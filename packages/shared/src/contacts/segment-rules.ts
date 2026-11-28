import { z } from 'zod';

// Feature 010 (research R1, FR-001, FR-002): saved segments. Rules sit in groups ("all of" or "any of");
// the groups are joined by "all of". The api compiles them to SQL; the web app builds them.

export const SEGMENT_MAX_GROUPS = 5;
export const SEGMENT_MAX_RULES = 30;
export const BEHAVIOUR_WINDOWS = [7, 30, 90] as const;
export const BEHAVIOUR_EVENTS = ['sent', 'delivered', 'read', 'replied', 'clicked', 'failed'] as const;
export const SEGMENT_ATTR_OPERATORS = ['eq', 'neq', 'contains', 'gt', 'lt', 'before', 'after', 'is_true', 'is_false', 'is_empty', 'is_not_empty'] as const;
export const SEGMENT_LEAD_SOURCES = [
  'UNKNOWN',
  'ORGANIC',
  'API',
  'IMPORT',
  'CAMPAIGN_UPLOAD',
  'CHAT_LINK',
  'AD',
  'LEAD_FORM',
  'FORM',
  'WEBSITE_BUTTON',
  'STORE',
  'CUSTOM',
] as const;

const day = z.iso.date();
const days = z.number().int().min(1).max(365);

export const SegmentRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), tag: z.string().trim().min(1).max(50), has: z.boolean() }).strict(),
  z.object({ kind: z.literal('attr'), attr: z.string().trim().min(1).max(40), op: z.enum(SEGMENT_ATTR_OPERATORS), value: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal('consent'), statuses: z.array(z.enum(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN'])).min(1).max(3) }).strict(),
  z.object({ kind: z.literal('lead_source'), sources: z.array(z.enum(SEGMENT_LEAD_SOURCES)).min(1).max(SEGMENT_LEAD_SOURCES.length) }).strict(),
  z
    .object({ kind: z.literal('added'), before: day.optional(), after: day.optional(), days: days.optional() })
    .strict()
    .refine((r) => [r.before, r.after, r.days].filter((v) => v !== undefined).length === 1, { message: 'give one of before, after or days' }),
  z.object({ kind: z.literal('last_inbound'), within: z.boolean(), days }).strict(),
  z.object({ kind: z.literal('blocked'), blocked: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('behaviour'),
      event: z.enum(BEHAVIOUR_EVENTS),
      did: z.boolean(),
      campaignId: z.uuid().optional(),
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    })
    .strict()
    .refine((r) => (r.campaignId === undefined) !== (r.days === undefined), { message: 'give a campaign or a window of 7, 30 or 90 days' }),
]);
export type SegmentRule = z.infer<typeof SegmentRuleSchema>;

export const SegmentGroupSchema = z.object({ match: z.enum(['all', 'any']), rules: z.array(SegmentRuleSchema).min(1).max(SEGMENT_MAX_RULES) }).strict();
export type SegmentGroup = z.infer<typeof SegmentGroupSchema>;

export const SegmentRulesSchema = z
  .object({ groups: z.array(SegmentGroupSchema).min(1).max(SEGMENT_MAX_GROUPS) })
  .strict()
  .refine((r) => r.groups.reduce((n, g) => n + g.rules.length, 0) <= SEGMENT_MAX_RULES, { message: `at most ${SEGMENT_MAX_RULES} rules in total` });
export type SegmentRules = z.infer<typeof SegmentRulesSchema>;

/** A rule that names something that no longer exists (FR-006). */
export interface BrokenSegmentRule {
  group: number;
  rule: number;
  issue: 'TAG_MISSING' | 'ATTRIBUTE_MISSING' | 'CAMPAIGN_MISSING';
}

/** The tag names, attribute keys and campaign ids a set of rules refers to. */
export function segmentReferences(rules: SegmentRules): { tags: string[]; attributes: string[]; campaignIds: string[] } {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  const campaignIds = new Set<string>();
  for (const group of rules.groups) {
    for (const rule of group.rules) {
      if (rule.kind === 'tag') tags.add(rule.tag.trim().toLowerCase());
      if (rule.kind === 'attr') attributes.add(rule.attr);
      if (rule.kind === 'behaviour' && rule.campaignId) campaignIds.add(rule.campaignId);
    }
  }
  return { tags: [...tags], attributes: [...attributes], campaignIds: [...campaignIds] };
}
