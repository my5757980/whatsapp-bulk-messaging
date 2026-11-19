import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error.js';
import { compileFilter, eligibilityCondition, type AttributeDef } from '../../src/modules/contacts/audience-query.builder.js';

// T117: audience filter -> SQL (contract AudienceFilter, FR-014, research R11).
const defs: AttributeDef[] = [
  { key: 'city', type: 'TEXT' },
  { key: 'spend', type: 'NUMBER' },
  { key: 'last_order_date', type: 'DATE' },
  { key: 'vip', type: 'BOOLEAN' },
];

const compile = (rules: unknown[]) => compileFilter({ all: rules as never }, defs);

describe('compileFilter', () => {
  it('matches everyone without rules', () => {
    expect(compile([]).text).toBe('TRUE');
  });

  it('builds tag rules with lower-cased tag names', () => {
    const sql = compile([{ tag: ' VIP ' }]);
    expect(sql.text).toContain('EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name =');
    expect(sql.values).toEqual(['vip']);
  });

  it('supports eq, neq and contains on text attributes', () => {
    expect(compile([{ attr: 'city', op: 'eq', value: 'Dubai' }])).toMatchObject({ text: '(c.attributes ->> $1) = $2', values: ['city', 'Dubai'] });
    expect(compile([{ attr: 'city', op: 'neq', value: 'Dubai' }]).text).toBe('(c.attributes ->> $1) IS DISTINCT FROM $2');
    const contains = compile([{ attr: 'city', op: 'contains', value: '50%_off' }]);
    expect(contains.text).toBe("(c.attributes ->> $1) ILIKE $2 ESCAPE '\\'");
    expect(contains.values).toEqual(['city', '%50\\%\\_off%']);
  });

  it('compares numbers and dates by type', () => {
    expect(compile([{ attr: 'spend', op: 'gt', value: '100' }])).toMatchObject({
      text: "(jsonb_typeof(c.attributes -> $1) = 'number' AND (c.attributes ->> $2)::numeric > $3)",
      values: ['spend', 'spend', 100],
    });
    expect(compile([{ attr: 'spend', op: 'lt', value: 5 }]).text).toContain('::numeric < $3');
    expect(compile([{ attr: 'last_order_date', op: 'before', value: '2026-01-15' }])).toMatchObject({
      text: "((c.attributes ->> $1) ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (c.attributes ->> $2) < $3)",
      values: ['last_order_date', 'last_order_date', '2026-01-15'],
    });
    expect(compile([{ attr: 'last_order_date', op: 'after', value: '2026-01-15T10:00:00Z' }]).values).toEqual([
      'last_order_date',
      'last_order_date',
      '2026-01-15',
    ]);
  });

  it('supports is_true / is_false on booleans', () => {
    expect(compile([{ attr: 'vip', op: 'is_true' }])).toMatchObject({ text: "(c.attributes -> $1) = 'true'::jsonb", values: ['vip'] });
    expect(compile([{ attr: 'vip', op: 'is_false' }]).text).toBe("(c.attributes -> $1) = 'false'::jsonb");
  });

  it('joins rules with AND', () => {
    const sql = compile([{ tag: 'vip' }, { attr: 'city', op: 'eq', value: 'Dubai' }]);
    expect(sql.text).toMatch(/^\(EXISTS .*\) AND \(\(c\.attributes ->> \$2\) = \$3\)$/);
    expect(sql.values).toEqual(['vip', 'city', 'Dubai']);
  });

  it('rejects unknown attributes, operators that do not fit the type and invalid values', () => {
    const issue = (rules: unknown[]) => {
      try {
        compile(rules);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        return (error as AppError).details?.[0];
      }
      throw new Error('expected a validation error');
    };
    expect(issue([{ attr: 'unknown', op: 'eq', value: 'x' }])).toMatchObject({ field: 'audienceFilter.all.0.attr' });
    expect(issue([{ tag: 'a' }, { attr: 'city', op: 'gt', value: 3 }])).toMatchObject({ field: 'audienceFilter.all.1.op' });
    expect(issue([{ attr: 'spend', op: 'gt', value: 'lots' }])).toMatchObject({ field: 'audienceFilter.all.0.value' });
    expect(issue([{ attr: 'last_order_date', op: 'before', value: '15/01/2026' }])).toMatchObject({ field: 'audienceFilter.all.0.value' });
    expect(issue([{ attr: 'vip', op: 'eq', value: 'maybe' }])).toMatchObject({ field: 'audienceFilter.all.0.value' });
  });
});

describe('eligibilityCondition', () => {
  it('always excludes opted-out contacts and needs an opt-in for marketing', () => {
    expect(eligibilityCondition('UTILITY').text).toBe("c.consent_status <> 'OPTED_OUT'");
    expect(eligibilityCondition('AUTHENTICATION').text).toBe("c.consent_status <> 'OPTED_OUT'");
    expect(eligibilityCondition('MARKETING').text).toBe("c.consent_status = 'OPTED_IN'");
    expect(eligibilityCondition('UTILITY', { optedInOnly: true }).text).toBe("c.consent_status = 'OPTED_IN'");
  });
});
