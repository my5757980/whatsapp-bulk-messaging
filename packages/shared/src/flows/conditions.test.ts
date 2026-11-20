import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateRule, opsFor, type ConditionFacts } from './conditions.js';
import type { ConditionRule } from './graph.js';

// 003 T045: condition rules per subject (contracts/flow-graph.md "Condition rules").
const VIP = '0193a0de-0000-7000-8000-000000000001';
const NEW = '0193a0de-0000-7000-8000-000000000002';
// Monday 2026-11-23 10:30 in Dubai (UTC+4) is 06:30 UTC.
const MONDAY_MORNING_DUBAI = new Date('2026-11-23T06:30:00Z');

const facts = (overrides: Partial<ConditionFacts> = {}): ConditionFacts => ({
  attributes: { city: 'Dubai Marina', guests: 4, visit_date: '2026-12-25', member: true, empty: '' },
  answers: { topic: 'Refund', amount: '250' },
  fields: { name: 'Sara Khan', phone: '+971501234567' },
  tagIds: new Set([VIP]),
  consent: 'OPTED_IN',
  workingHours: { hours: { mon: [['09:00', '18:00']] }, timezone: 'Asia/Dubai' },
  now: MONDAY_MORNING_DUBAI,
  ...overrides,
});
const rule = (subject: ConditionRule['subject'], op: ConditionRule['op'], value?: string): ConditionRule => ({ subject, op, ...(value !== undefined ? { value } : {}) });
const attr = (key: string) => ({ kind: 'attribute' as const, key });

describe('text operators', () => {
  it('compare text without case or surrounding spaces', () => {
    expect(evaluateRule(rule(attr('city'), 'equals', ' dubai marina '), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'not_equals', 'Sharjah'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'contains', 'MARINA'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'starts_with', 'dub'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'starts_with', 'marina'), facts())).toBe(false);
  });

  it('treat missing and blank values as empty', () => {
    expect(evaluateRule(rule(attr('missing'), 'is_empty'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('empty'), 'is_empty'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'is_not_empty'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('missing'), 'equals', 'x'), facts())).toBe(false);
  });

  it('read numbers and booleans as text', () => {
    expect(evaluateRule(rule(attr('guests'), 'equals', '4'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('member'), 'equals', 'TRUE'), facts())).toBe(true);
  });
});

describe('number and date operators', () => {
  it('compare numbers, and are false when either side is not a number', () => {
    expect(evaluateRule(rule(attr('guests'), 'greater_than', '3'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('guests'), 'less_than', '4'), facts())).toBe(false);
    expect(evaluateRule(rule({ kind: 'answer', name: 'amount' }, 'greater_than', '100.5'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'greater_than', '3'), facts())).toBe(false);
    expect(evaluateRule(rule(attr('guests'), 'less_than', 'many'), facts())).toBe(false);
  });

  it('compare dates, including today in the company time zone', () => {
    expect(evaluateRule(rule(attr('visit_date'), 'after', '2026-12-24'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('visit_date'), 'before', '2026-12-25'), facts())).toBe(false);
    expect(evaluateRule(rule(attr('visit_date'), 'after', 'today'), facts())).toBe(true);
    expect(evaluateRule(rule(attr('city'), 'before', 'today'), facts())).toBe(false);
  });
});

describe('answers, contact fields, tags and consent', () => {
  it('reads answers from the session and name or phone from the contact', () => {
    expect(evaluateRule(rule({ kind: 'answer', name: 'topic' }, 'equals', 'refund'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'field', key: 'name' }, 'starts_with', 'sara'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'field', key: 'phone' }, 'starts_with', '+971'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'field', key: 'name' }, 'is_empty'), facts({ fields: { name: null, phone: null } }))).toBe(true);
  });

  it('checks tags and consent', () => {
    expect(evaluateRule(rule({ kind: 'tag', tagId: VIP }, 'is_present'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'tag', tagId: NEW }, 'is_present'), facts())).toBe(false);
    expect(evaluateRule(rule({ kind: 'tag', tagId: NEW }, 'is_absent'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'consent' }, 'equals', 'OPTED_IN'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'consent' }, 'equals', 'unknown'), facts({ consent: 'UNKNOWN' }))).toBe(true);
  });

  it('refuses an operator that does not belong to the subject', () => {
    expect(evaluateRule(rule({ kind: 'tag', tagId: VIP }, 'equals', 'x'), facts())).toBe(false);
    expect(evaluateRule(rule({ kind: 'field', key: 'name' }, 'greater_than', '1'), facts())).toBe(false);
    expect(opsFor({ kind: 'workingHours' })).toEqual(['inside', 'outside']);
    expect(opsFor({ kind: 'consent' })).toEqual(['equals']);
  });
});

describe('working hours', () => {
  it('uses the 002 working hours in their time zone', () => {
    expect(evaluateRule(rule({ kind: 'workingHours' }, 'inside'), facts())).toBe(true);
    expect(evaluateRule(rule({ kind: 'workingHours' }, 'outside'), facts())).toBe(false);
    // 19:30 in Dubai is after closing; the same instant is 15:30 UTC, which would be "open" in UTC.
    const evening = new Date('2026-11-23T15:30:00Z');
    expect(evaluateRule(rule({ kind: 'workingHours' }, 'inside'), facts({ now: evening }))).toBe(false);
    expect(evaluateRule(rule({ kind: 'workingHours' }, 'inside'), facts({ now: evening, workingHours: { hours: { mon: [['09:00', '18:00']] }, timezone: 'UTC' } }))).toBe(true);
  });
});

describe('all and any', () => {
  it('joins rules with all or any', () => {
    const vip = rule({ kind: 'tag', tagId: VIP }, 'is_present');
    const closed = rule({ kind: 'workingHours' }, 'outside');
    expect(evaluateCondition('all', [vip, closed], facts())).toBe(false);
    expect(evaluateCondition('any', [vip, closed], facts())).toBe(true);
    expect(evaluateCondition('any', [closed], facts())).toBe(false);
  });
});
