'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { AttributeDefinition, AttributeOperator, AttributeType, AudienceRule, Tag } from '@/lib/types';

const OPERATORS: Record<AttributeType, Array<{ op: AttributeOperator; label: string }>> = {
  TEXT: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'contains', label: 'contains' },
  ],
  NUMBER: [
    { op: 'eq', label: 'equals' },
    { op: 'neq', label: 'does not equal' },
    { op: 'gt', label: 'greater than' },
    { op: 'lt', label: 'less than' },
  ],
  DATE: [
    { op: 'eq', label: 'on' },
    { op: 'before', label: 'before' },
    { op: 'after', label: 'after' },
  ],
  BOOLEAN: [
    { op: 'is_true', label: 'is yes' },
    { op: 'is_false', label: 'is no' },
  ],
};

/** A rule is complete when it can be sent to the API. */
export function isCompleteRule(rule: AudienceRule): boolean {
  if ('tag' in rule) return Boolean(rule.tag.trim());
  if (rule.op === 'is_true' || rule.op === 'is_false') return Boolean(rule.attr);
  return Boolean(rule.attr && rule.value?.toString().trim());
}

/** Tag / attribute rules combined with AND (contract AudienceFilter, T131). */
export function AudienceRuleBuilder({
  rules,
  onChange,
  tags,
  attributes,
}: {
  rules: AudienceRule[];
  onChange: (rules: AudienceRule[]) => void;
  tags: Tag[];
  attributes: AttributeDefinition[];
}) {
  const set = (i: number, rule: AudienceRule) => onChange(rules.map((r, j) => (j === i ? rule : r)));
  const typeOf = (key: string) => attributes.find((a) => a.key === key)?.type ?? 'TEXT';

  return (
    <div className="grid gap-3">
      {rules.map((rule, i) => {
        const kind = 'tag' in rule ? '__tag' : rule.attr;
        const type = 'tag' in rule ? null : typeOf(rule.attr);
        return (
          <div key={i} className="flex flex-wrap items-center gap-2" data-testid="audience-rule">
            {i > 0 ? <span className="w-10 text-xs font-medium text-muted-foreground">AND</span> : <span className="w-10 text-xs text-muted-foreground">Where</span>}
            <NativeSelect
              aria-label={`Rule ${i + 1} field`}
              className="w-44"
              value={kind}
              onChange={(e) => {
                const value = e.target.value;
                if (value === '__tag') return set(i, { tag: '' });
                const firstOp = OPERATORS[typeOf(value)][0]!.op;
                set(i, { attr: value, op: firstOp, value: '' });
              }}
            >
              <option value="__tag">Has tag</option>
              {attributes.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </NativeSelect>
            {'tag' in rule ? (
              <NativeSelect aria-label={`Rule ${i + 1} tag`} className="w-48" value={rule.tag} onChange={(e) => set(i, { tag: e.target.value })}>
                <option value="">Choose a tag…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name} ({t.contactCount})
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <>
                <NativeSelect
                  aria-label={`Rule ${i + 1} operator`}
                  className="w-40"
                  value={rule.op}
                  onChange={(e) => set(i, { ...rule, op: e.target.value as AttributeOperator })}
                >
                  {OPERATORS[type as AttributeType].map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                {rule.op === 'is_true' || rule.op === 'is_false' ? null : (
                  <Input
                    aria-label={`Rule ${i + 1} value`}
                    className="w-44"
                    type={type === 'DATE' ? 'date' : type === 'NUMBER' ? 'number' : 'text'}
                    step="any"
                    value={rule.value ?? ''}
                    onChange={(e) => set(i, { ...rule, value: e.target.value })}
                  />
                )}
              </>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label={`Remove rule ${i + 1}`}>
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rules, { tag: '' }])}>
          Add rule
        </Button>
      </div>
    </div>
  );
}
