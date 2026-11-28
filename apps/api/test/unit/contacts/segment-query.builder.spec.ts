import type { SegmentRules } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/common/errors/app-error.js';
import { compileSegment, type SegmentContext } from '../../../src/modules/contacts/segment-query.builder.js';

// T018 (feature 010 US1, research R1): segment rules compiled to one parameterised WHERE.
const campaignId = '0190a000-0000-7000-8000-000000000001';
const ctx: SegmentContext = {
  attributes: new Map([
    ['city', 'TEXT'],
    ['birthday', 'DATE'],
    ['orders', 'NUMBER'],
  ]),
  tags: new Set(['customer', 'trial']),
  campaigns: new Set([campaignId]),
  timezone: 'Asia/Dubai',
};
const one = (rule: SegmentRules['groups'][number]['rules'][number]): SegmentRules => ({ groups: [{ match: 'all', rules: [rule] }] });
const sqlOf = (rules: SegmentRules) => {
  const { where, broken } = compileSegment(rules, ctx);
  return { text: where.sql, values: where.values, broken };
};

describe('compileSegment', () => {
  it('compiles each rule kind with its values as parameters', () => {
    expect(sqlOf(one({ kind: 'tag', tag: 'Customer', has: true })).text).toContain('EXISTS (SELECT 1 FROM contact_tags');
    expect(sqlOf(one({ kind: 'tag', tag: 'trial', has: false })).text).toMatch(/NOT \(EXISTS/);
    expect(sqlOf(one({ kind: 'attr', attr: 'city', op: 'eq', value: 'Dubai' })).values).toContain('Dubai');
    expect(sqlOf(one({ kind: 'attr', attr: 'birthday', op: 'is_empty' })).text).toContain("= ''");
    expect(sqlOf(one({ kind: 'consent', statuses: ['OPTED_IN', 'UNKNOWN'] })).values).toEqual(['OPTED_IN', 'UNKNOWN']);
    expect(sqlOf(one({ kind: 'lead_source', sources: ['WEBSITE_BUTTON'] })).text).toContain('lead_source_kind::text IN');
    expect(sqlOf(one({ kind: 'added', days: 30 })).text).toContain('make_interval(days =>');
    expect(sqlOf(one({ kind: 'added', before: '2026-11-01' })).values).toEqual(['2026-11-01', 'Asia/Dubai']);
    expect(sqlOf(one({ kind: 'last_inbound', within: false, days: 90 })).text).toMatch(/NOT \(EXISTS \(SELECT 1 FROM conversations/);
    expect(sqlOf(one({ kind: 'blocked', blocked: true })).text).toContain('blocked_at IS NOT NULL');
    const read = sqlOf(one({ kind: 'behaviour', event: 'read', did: true, campaignId }));
    expect(read.text).toContain("m.origin = 'CAMPAIGN'");
    expect(read.values).toContain(campaignId);
    expect(sqlOf(one({ kind: 'behaviour', event: 'replied', did: false, days: 30 })).text).toMatch(/NOT \(EXISTS \(SELECT 1 FROM messages m[\s\S]*chat_messages/);
    expect(sqlOf(one({ kind: 'behaviour', event: 'clicked', did: true, days: 7 })).text).toContain('link_clicks');
  });

  it('joins rules with AND or OR inside a group, and groups with AND', () => {
    const { text } = sqlOf({
      groups: [
        { match: 'any', rules: [{ kind: 'lead_source', sources: ['API'] }, { kind: 'lead_source', sources: ['IMPORT'] }] },
        { match: 'all', rules: [{ kind: 'blocked', blocked: false }, { kind: 'consent', statuses: ['OPTED_IN'] }] },
      ],
    });
    expect(text).toMatch(/\(\(.*\) OR \(.*\)\) AND \(\(.*\) AND \(.*\)\)/s);
  });

  it('never puts values into the SQL text', () => {
    const { text } = sqlOf(one({ kind: 'attr', attr: 'city', op: 'contains', value: "Dubai'; DROP TABLE contacts; --" }));
    expect(text).not.toContain('DROP TABLE');
  });

  it('reports missing tags, attributes and campaigns as broken rules that match no one', () => {
    const missing = '0190a000-0000-7000-8000-00000000ffff';
    const result = sqlOf({
      groups: [
        { match: 'all', rules: [{ kind: 'tag', tag: 'gone', has: true }, { kind: 'attr', attr: 'shoe_size', op: 'eq', value: '42' }] },
        { match: 'any', rules: [{ kind: 'behaviour', event: 'sent', did: true, campaignId: missing }] },
      ],
    });
    expect(result.broken).toEqual([
      { group: 0, rule: 0, issue: 'TAG_MISSING' },
      { group: 0, rule: 1, issue: 'ATTRIBUTE_MISSING' },
      { group: 1, rule: 0, issue: 'CAMPAIGN_MISSING' },
    ]);
    expect(result.text).toContain('FALSE');
  });

  it('refuses values that do not fit the attribute type (422)', () => {
    expect(() => compileSegment(one({ kind: 'attr', attr: 'orders', op: 'gt', value: 'many' }), ctx)).toThrow(AppError);
    expect(() => compileSegment(one({ kind: 'attr', attr: 'city', op: 'gt', value: 3 }), ctx)).toThrow(AppError);
  });
});
