import { describe, expect, it } from 'vitest';
import { SEGMENT_MAX_RULES, SegmentRulesSchema, segmentReferences, type SegmentRule } from './segment-rules.js';

// T006 (feature 010, research R1): the segment rule schema.
const campaignId = '0190a000-0000-7000-8000-000000000001';
const valid: SegmentRule[] = [
  { kind: 'tag', tag: 'customer', has: true },
  { kind: 'tag', tag: 'trial', has: false },
  { kind: 'attr', attr: 'city', op: 'eq', value: 'Dubai' },
  { kind: 'attr', attr: 'birthday', op: 'is_empty' },
  { kind: 'consent', statuses: ['OPTED_IN'] },
  { kind: 'lead_source', sources: ['WEBSITE_BUTTON', 'CHAT_LINK'] },
  { kind: 'added', days: 30 },
  { kind: 'added', before: '2026-11-01' },
  { kind: 'last_inbound', within: false, days: 90 },
  { kind: 'blocked', blocked: false },
  { kind: 'behaviour', event: 'read', did: true, campaignId },
  { kind: 'behaviour', event: 'replied', did: false, days: 30 },
];
const rules = (list: SegmentRule[], match: 'all' | 'any' = 'all') => ({ groups: [{ match, rules: list }] });

describe('SegmentRulesSchema', () => {
  it('accepts every rule kind, including the "did not" and "has not" forms', () => {
    for (const rule of valid) expect(SegmentRulesSchema.safeParse(rules([rule])).success, JSON.stringify(rule)).toBe(true);
    expect(SegmentRulesSchema.safeParse({ groups: [rules(valid.slice(0, 6)).groups[0], { match: 'any', rules: valid.slice(6) }] }).success).toBe(true);
  });

  it('refuses empty segments, more than 5 groups and more than 30 rules in total', () => {
    expect(SegmentRulesSchema.safeParse({ groups: [] }).success).toBe(false);
    expect(SegmentRulesSchema.safeParse({ groups: [{ match: 'all', rules: [] }] }).success).toBe(false);
    const group = { match: 'all' as const, rules: [valid[0]!] };
    expect(SegmentRulesSchema.safeParse({ groups: Array.from({ length: 6 }, () => group) }).success).toBe(false);
    const many = Array.from({ length: SEGMENT_MAX_RULES / 2 + 1 }, () => valid[0]!);
    expect(SegmentRulesSchema.safeParse({ groups: [{ match: 'all', rules: many }, { match: 'any', rules: many }] }).success).toBe(false);
  });

  it('needs a campaign or a 7, 30 or 90 day window for behaviour, and one bound for "added"', () => {
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'behaviour', event: 'sent', did: true } as SegmentRule])).success).toBe(false);
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'behaviour', event: 'sent', did: true, days: 14 } as unknown as SegmentRule])).success).toBe(false);
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'behaviour', event: 'sent', did: true, days: 7, campaignId }])).success).toBe(false);
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'added', days: 30, before: '2026-11-01' }])).success).toBe(false);
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'added' } as SegmentRule])).success).toBe(false);
    expect(SegmentRulesSchema.safeParse(rules([{ kind: 'last_inbound', within: true, days: 400 }])).success).toBe(false);
  });

  it('lists the tags, attributes and campaigns the rules name', () => {
    expect(segmentReferences(rules(valid))).toEqual({ tags: ['customer', 'trial'], attributes: ['city', 'birthday'], campaignIds: [campaignId] });
  });
});
