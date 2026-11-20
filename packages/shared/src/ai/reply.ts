import { z } from 'zod';
import { AI_LIMITS } from './config.js';
import { looksSensitive } from './masking.js';

// The reply JSON every customer turn ends with (specs/004-ai-agent/contracts/claude-messages.md §4,
// research R3, T011). The model fills it under a strict JSON schema; sanitiseReply() then applies
// the checks that must hold whatever the model wrote, before anything reaches WhatsApp.

export const WHATSAPP_LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listButton: 20,
} as const;

export const HAND_OVER_REASONS = ['customer_asked', 'topic', 'unsure', 'repeat', 'other'] as const;
export type HandOverReason = (typeof HAND_OVER_REASONS)[number];

// Every property is required and nullable: strict structured outputs need each property listed.
export const AgentReplySchema = z.strictObject({
  message: z.string(),
  language: z.string().nullable(),
  buttons: z.array(z.string()).nullable(),
  list: z
    .strictObject({
      button: z.string(),
      rows: z.array(z.strictObject({ title: z.string(), description: z.string().nullable() })),
    })
    .nullable(),
  mediaId: z.string().nullable(),
  usedSources: z.array(z.string()),
  unanswered: z.string().nullable(),
  handOver: z.strictObject({ reason: z.enum(HAND_OVER_REASONS), summary: z.string() }).nullable(),
  remember: z.array(z.strictObject({ key: z.string(), value: z.string() })).nullable(),
  startFlow: z.string().nullable(),
  optOut: z.enum(['clear', 'ask']).nullable(),
});
export type AgentReply = z.infer<typeof AgentReplySchema>;

/** The JSON schema sent as `output_config.format.schema` (no `$schema` key, no length limits). */
export const AGENT_REPLY_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(AgentReplySchema) as Record<string, unknown>;
  return schema;
})();

export type AttributeKind = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN';

/** What the agent version allows and what exists, for checking a reply. */
export interface ReplyContext {
  maxReplyChars: number;
  allowButtons: boolean;
  allowLists: boolean;
  mediaIds: ReadonlySet<string>;
  flowIds: ReadonlySet<string>;
  attributes: ReadonlyMap<string, AttributeKind>;
  sourceIds: ReadonlySet<string>;
}

export interface DroppedPart {
  field: string;
  reason: string;
}

const chars = (value: string): number => [...value].length;

function shorten(text: string, limit: number): string {
  const all = [...text];
  if (all.length <= limit) return text;
  let cut = all.slice(0, limit - 1).join('');
  const space = cut.search(/\s\S*$/);
  if (space > limit * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

function normaliseValue(kind: AttributeKind, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  switch (kind) {
    case 'NUMBER':
      return /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '')) ? value.replace(/,/g, '') : null;
    case 'DATE': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
    }
    case 'BOOLEAN': {
      const lower = value.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) return 'true';
      if (['false', 'no', '0'].includes(lower)) return 'false';
      return null;
    }
    case 'TEXT':
      return chars(value) <= 500 ? value : null;
  }
}

/** Applies the checks in code (contracts/claude-messages.md §4); every removed part is reported. */
export function sanitiseReply(input: AgentReply, context: ReplyContext): { reply: AgentReply; dropped: DroppedPart[] } {
  const dropped: DroppedPart[] = [];
  const drop = (field: string, reason: string) => dropped.push({ field, reason });

  let buttons: string[] | null = null;
  if (input.buttons && input.buttons.length > 0) {
    if (!context.allowButtons) drop('buttons', 'not_allowed');
    else {
      const kept: string[] = [];
      let tooMany = false;
      for (const raw of input.buttons) {
        const title = raw.trim();
        if (!title) drop('buttons', 'empty');
        else if (chars(title) > WHATSAPP_LIMITS.buttonTitle) drop('buttons', 'too_long');
        else if (kept.some((k) => k.toLowerCase() === title.toLowerCase())) drop('buttons', 'duplicate');
        else if (kept.length >= WHATSAPP_LIMITS.buttons) tooMany = true;
        else kept.push(title);
      }
      if (tooMany) drop('buttons', 'too_many');
      buttons = kept.length ? kept : null;
    }
  }

  let list: AgentReply['list'] = null;
  if (input.list) {
    if (buttons) drop('list', 'with_buttons');
    else if (!context.allowLists) drop('list', 'not_allowed');
    else {
      const label = input.list.button.trim();
      if (!label || chars(label) > WHATSAPP_LIMITS.listButton) drop('list', 'bad_button');
      else {
        const rows: NonNullable<AgentReply['list']>['rows'] = [];
        let tooMany = false;
        for (const row of input.list.rows) {
          const title = row.title.trim();
          if (!title) drop('list', 'empty_row');
          else if (chars(title) > WHATSAPP_LIMITS.rowTitle) drop('list', 'row_too_long');
          else if (rows.length >= WHATSAPP_LIMITS.listRows) tooMany = true;
          else {
            let description = row.description?.trim() || null;
            if (description && chars(description) > WHATSAPP_LIMITS.rowDescription) {
              drop('list', 'description_too_long');
              description = null;
            }
            rows.push({ title, description });
          }
        }
        if (tooMany) drop('list', 'too_many_rows');
        if (rows.length) list = { button: label, rows };
        else drop('list', 'no_rows');
      }
    }
  }

  let mediaId = input.mediaId;
  if (mediaId && !context.mediaIds.has(mediaId)) {
    drop('mediaId', 'unknown');
    mediaId = null;
  }

  let startFlow = input.startFlow;
  if (startFlow && !context.flowIds.has(startFlow)) {
    drop('startFlow', 'unknown');
    startFlow = null;
  }

  const usedSources = input.usedSources.filter((id) => context.sourceIds.has(id));
  if (usedSources.length !== input.usedSources.length) drop('usedSources', 'unknown');

  let remember: AgentReply['remember'] = null;
  if (input.remember && input.remember.length > 0) {
    const kept = new Map<string, string>();
    for (const { key, value } of input.remember) {
      const kind = context.attributes.get(key);
      if (!kind) drop(`remember.${key}`, 'not_allowed');
      else if (looksSensitive(value)) drop(`remember.${key}`, 'sensitive');
      else {
        const normalised = normaliseValue(kind, value);
        if (normalised === null) drop(`remember.${key}`, 'wrong_type');
        else kept.set(key, normalised);
      }
    }
    remember = kept.size ? [...kept].map(([key, value]) => ({ key, value })) : null;
  }

  const limit = mediaId ? Math.min(context.maxReplyChars, AI_LIMITS.mediaCaption) : context.maxReplyChars;
  let message = input.message.trim();
  if (chars(message) > limit) {
    drop('message', 'too_long');
    message = shorten(message, limit);
  }

  const language = input.language && /^[a-z]{2,3}$/.test(input.language) ? input.language : null;
  const unanswered = input.unanswered?.trim() ? [...input.unanswered.trim()].slice(0, 300).join('') : null;
  const handOver = input.handOver ? { reason: input.handOver.reason, summary: [...input.handOver.summary.trim()].slice(0, 1000).join('') } : null;

  return {
    reply: { message, language, buttons, list, mediaId, usedSources, unanswered, handOver, remember, startFlow, optOut: input.optOut },
    dropped,
  };
}
