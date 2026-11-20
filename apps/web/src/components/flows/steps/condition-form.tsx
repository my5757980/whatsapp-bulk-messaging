'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, opNeedsValue, opsFor, type ConditionOp, type FlowGraph, type StepOf } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { answerNamesIn } from '@/lib/flows';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Tag } from '@/lib/types';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type ConditionStep = StepOf<'condition'>;
type Rule = ConditionStep['rules'][number];
type Subject = Rule['subject'];
type Kind = Subject['kind'];

const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: 'attribute', label: 'A contact attribute' },
  { kind: 'answer', label: 'An answer' },
  { kind: 'field', label: 'The contact name or phone' },
  { kind: 'tag', label: 'A tag' },
  { kind: 'consent', label: 'Consent' },
  { kind: 'workingHours', label: 'Working hours' },
];

const OP_LABELS: Record<ConditionOp, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  starts_with: 'starts with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  greater_than: 'is more than',
  less_than: 'is less than',
  before: 'is before',
  after: 'is after',
  is_present: 'is on the contact',
  is_absent: 'is not on the contact',
  inside: 'now is within working hours',
  outside: 'now is outside working hours',
};

interface Choices {
  attributes: AttributeDefinition[];
  answers: string[];
  tags: Tag[];
}

/** A subject of a kind with its first available item; null when there is none (no attributes yet). */
function subjectOf(kind: Kind, choices: Choices): Subject | null {
  switch (kind) {
    case 'attribute':
      return choices.attributes[0] ? { kind, key: choices.attributes[0].key } : null;
    case 'answer':
      return choices.answers[0] ? { kind, name: choices.answers[0] } : null;
    case 'field':
      return { kind, key: 'name' };
    case 'tag':
      return choices.tags[0] ? { kind, tagId: choices.tags[0].id } : null;
    case 'consent':
      return { kind };
    case 'workingHours':
      return { kind };
  }
}

/** A rule for a subject with its first comparison (consent starts with "opted in"). */
function ruleFor(subject: Subject): Rule {
  const op = opsFor(subject)[0]!;
  return subject.kind === 'consent' ? { subject, op, value: 'OPTED_IN' } : { subject, op };
}

/** Condition step (FR-012): rules on attributes, answers, contact fields, tags, consent and working hours. */
export function ConditionForm({ step, graph, onPatch }: { step: ConditionStep; graph: FlowGraph; onPatch: StepPatch<ConditionStep> }) {
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const choices: Choices = { attributes: attributes.data ?? [], answers: answerNamesIn(graph), tags: tags.data ?? [] };
  const setRule = (index: number, rule: Rule, key?: string) => onPatch({ rules: step.rules.map((r, i) => (i === index ? rule : r)) }, key);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="condition-join">Go to Yes when</Label>
        <NativeSelect id="condition-join" value={step.join} onChange={(e) => onPatch({ join: e.target.value === 'any' ? 'any' : 'all' })}>
          <option value="all">all rules match</option>
          <option value="any">any rule matches</option>
        </NativeSelect>
      </div>
      {step.rules.map((rule, index) => {
        const n = index + 1;
        const subject = rule.subject;
        return (
          <fieldset key={index} className="grid gap-2 rounded-md border p-2" data-testid="condition-rule">
            <legend className="px-1 text-sm font-medium">Rule {n}</legend>
            <div className="grid gap-1">
              <Label htmlFor={`rule-${index}-kind`}>Rule {n} checks</Label>
              <NativeSelect
                id={`rule-${index}-kind`}
                value={subject.kind}
                onChange={(e) => {
                  const next = subjectOf(e.target.value as Kind, choices);
                  if (next) setRule(index, ruleFor(next));
                }}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind} disabled={k.kind !== subject.kind && !subjectOf(k.kind, choices)}>
                    {k.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {subject.kind === 'attribute' && (
              <NativeSelect aria-label={`Rule ${n} attribute`} value={subject.key} onChange={(e) => setRule(index, { ...rule, subject: { kind: 'attribute', key: e.target.value } })}>
                {!choices.attributes.some((a) => a.key === subject.key) && <option value={subject.key}>{subject.key} (not available)</option>}
                {choices.attributes.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label} ({a.key})
                  </option>
                ))}
              </NativeSelect>
            )}
            {subject.kind === 'answer' && (
              <NativeSelect aria-label={`Rule ${n} answer`} value={subject.name} onChange={(e) => setRule(index, { ...rule, subject: { kind: 'answer', name: e.target.value } })}>
                {!choices.answers.includes(subject.name) && <option value={subject.name}>{subject.name} (not in this flow)</option>}
                {choices.answers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
            )}
            {subject.kind === 'field' && (
              <NativeSelect aria-label={`Rule ${n} contact field`} value={subject.key} onChange={(e) => setRule(index, { ...rule, subject: { kind: 'field', key: e.target.value === 'phone' ? 'phone' : 'name' } })}>
                <option value="name">Name</option>
                <option value="phone">Phone</option>
              </NativeSelect>
            )}
            {subject.kind === 'tag' && (
              <NativeSelect aria-label={`Rule ${n} tag`} value={subject.tagId} onChange={(e) => setRule(index, { ...rule, subject: { kind: 'tag', tagId: e.target.value } })}>
                {!choices.tags.some((t) => t.id === subject.tagId) && <option value={subject.tagId}>A deleted tag</option>}
                {choices.tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <div className="grid gap-1">
              <Label htmlFor={`rule-${index}-op`}>Rule {n} comparison</Label>
              <NativeSelect
                id={`rule-${index}-op`}
                value={rule.op}
                onChange={(e) => {
                  const op = e.target.value as ConditionOp;
                  setRule(index, opNeedsValue(op) ? { ...rule, op } : { subject, op });
                }}
              >
                {opsFor(subject).map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {opNeedsValue(rule.op) &&
              (subject.kind === 'consent' ? (
                <NativeSelect aria-label={`Rule ${n} value`} value={rule.value ?? 'OPTED_IN'} onChange={(e) => setRule(index, { ...rule, value: e.target.value })}>
                  <option value="OPTED_IN">Opted in</option>
                  <option value="UNKNOWN">Not asked yet</option>
                </NativeSelect>
              ) : (
                <Input
                  aria-label={`Rule ${n} value`}
                  value={rule.value ?? ''}
                  maxLength={200}
                  placeholder={rule.op === 'before' || rule.op === 'after' ? 'YYYY-MM-DD or today' : 'Value'}
                  onChange={(e) => setRule(index, { ...rule, value: e.target.value }, `rule:${index}`)}
                />
              ))}
            <Button type="button" size="sm" variant="ghost" className="justify-self-start" disabled={step.rules.length === 1} onClick={() => onPatch({ rules: step.rules.filter((_, i) => i !== index) })}>
              Remove rule
            </Button>
          </fieldset>
        );
      })}
      {step.rules.length < FLOW_LIMITS.conditionRules && (
        <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => onPatch({ rules: [...step.rules, ruleFor({ kind: 'workingHours' })] })}>
          Add rule
        </Button>
      )}
      <GoesToSelect id="condition-yes" label="If yes, go to" graph={graph} fromId={step.id} value={step.yes} required onChange={(yes) => onPatch({ yes })} />
      <GoesToSelect id="condition-no" label="If no, go to" graph={graph} fromId={step.id} value={step.no} required onChange={(no) => onPatch({ no })} />
    </div>
  );
}
