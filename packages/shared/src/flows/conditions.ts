import { isWithinHours, todayIn, type WorkingHours } from '../working-hours.js';
import { resolveDateBound } from './answers.js';
import type { ConditionOp, ConditionRule } from './graph.js';

// Condition steps (003 T049, FR-012, contracts/flow-graph.md "Condition rules"). Pure: the caller
// gathers the facts (contact values, tags, consent, 002 working hours) and the instant.

export interface ConditionFacts {
  /** Contact attribute values as stored (string, number, boolean or YYYY-MM-DD). */
  attributes: Record<string, unknown>;
  /** The session's answers. */
  answers: Record<string, unknown>;
  fields: { name: string | null; phone: string | null };
  tagIds: ReadonlySet<string>;
  consent: string;
  /** 002 working hours and the company time zone. */
  workingHours: { hours: Partial<WorkingHours>; timezone: string };
  now: Date;
}

type Subject = ConditionRule['subject'];

const VALUE_OPS: readonly ConditionOp[] = ['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'is_not_empty', 'greater_than', 'less_than', 'before', 'after'];
const FIELD_OPS: readonly ConditionOp[] = ['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'is_not_empty'];

/** The operators a subject allows, in display order. */
export function opsFor(subject: Pick<Subject, 'kind'>): ConditionOp[] {
  switch (subject.kind) {
    case 'attribute':
    case 'answer':
      return [...VALUE_OPS];
    case 'field':
      return [...FIELD_OPS];
    case 'tag':
      return ['is_present', 'is_absent'];
    case 'consent':
      return ['equals'];
    case 'workingHours':
      return ['inside', 'outside'];
  }
}

/** Operators that compare with the rule's value. */
export function opNeedsValue(op: ConditionOp): boolean {
  return !['is_empty', 'is_not_empty', 'is_present', 'is_absent', 'inside', 'outside'].includes(op);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function number(value: string): number | null {
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(value.replace(/,/g, ''))) return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function date(value: string, today: string): string | null {
  const resolved = resolveDateBound(value.toLowerCase(), today);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(resolved);
  return m ? m[1]! : null;
}

function compareValue(op: ConditionOp, subject: string, ruleValue: string, facts: ConditionFacts): boolean {
  const a = subject.toLowerCase();
  const b = ruleValue.trim().toLowerCase();
  switch (op) {
    case 'equals':
      return a === b;
    case 'not_equals':
      return a !== b;
    case 'contains':
      return b !== '' && a.includes(b);
    case 'starts_with':
      return b !== '' && a.startsWith(b);
    case 'is_empty':
      return a === '';
    case 'is_not_empty':
      return a !== '';
    case 'greater_than':
    case 'less_than': {
      const x = number(subject);
      const y = number(ruleValue.trim());
      if (x === null || y === null) return false;
      return op === 'greater_than' ? x > y : x < y;
    }
    case 'before':
    case 'after': {
      const today = todayIn(facts.workingHours.timezone, facts.now);
      const x = date(subject, today);
      const y = date(ruleValue.trim(), today);
      if (x === null || y === null) return false;
      return op === 'before' ? x < y : x > y;
    }
    default:
      return false;
  }
}

/** One rule against the facts; an operator the subject does not allow is false. */
export function evaluateRule(rule: ConditionRule, facts: ConditionFacts): boolean {
  if (!opsFor(rule.subject).includes(rule.op)) return false;
  const value = rule.value ?? '';
  switch (rule.subject.kind) {
    case 'attribute':
      return compareValue(rule.op, text(facts.attributes[rule.subject.key]), value, facts);
    case 'answer':
      return compareValue(rule.op, text(facts.answers[rule.subject.name]), value, facts);
    case 'field':
      return compareValue(rule.op, text(facts.fields[rule.subject.key]), value, facts);
    case 'tag':
      return facts.tagIds.has(rule.subject.tagId) === (rule.op === 'is_present');
    case 'consent':
      return facts.consent.toUpperCase() === value.trim().toUpperCase();
    case 'workingHours':
      return isWithinHours(facts.workingHours.hours, facts.workingHours.timezone, facts.now) === (rule.op === 'inside');
  }
}

/** All rules must hold ("all"), or at least one ("any"). */
export function evaluateCondition(join: 'all' | 'any', rules: ConditionRule[], facts: ConditionFacts): boolean {
  return join === 'all' ? rules.every((r) => evaluateRule(r, facts)) : rules.some((r) => evaluateRule(r, facts));
}
