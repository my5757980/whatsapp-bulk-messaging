// Shared live chat types and helpers (specs/002-team-inbox/data-model.md). The string unions match
// the Prisma enums of the same names, so pure modules stay free of the generated client.

export type ConversationState = 'ACTIVE' | 'REQUESTING' | 'INTERVENED';

export const LIVE_STATES: readonly ConversationState[] = ['ACTIVE', 'REQUESTING', 'INTERVENED'];

export const CHAT_CONTENT_TYPES = [
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACTS',
  'BUTTON_REPLY',
  'LIST_REPLY',
  'FORM_REPLY',
  'REACTION',
  'TEMPLATE',
  'UNSUPPORTED',
  // Reply buttons and lists sent by chatbot flows (feature 003)
  'BUTTONS',
  'LIST',
] as const;

export type ChatContentType = (typeof CHAT_CONTENT_TYPES)[number];

/** Longest list preview, matching `conversations.last_message_preview varchar(120)`. */
export const PREVIEW_MAX = 120;

/** Cuts text to `max` characters (code points, as Postgres counts them), ending with "…" when cut. */
export function cutText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}
