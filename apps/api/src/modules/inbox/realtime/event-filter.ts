import { can } from '@wbm/shared';
import { maskPhone } from '../../../common/phone/phone.js';
import { canAccess, matchesRules, seesAll, type AgentRuleFacts, type ChatFacts, type Viewer } from '../conversations/visibility.js';
import { cutText, PREVIEW_MAX, type ConversationState } from '../inbox-common.js';

// Decides, per connection, whether a live event is delivered and in what form
// (specs/002-team-inbox/contracts/realtime-events.md rules 1-2). Pure: the fan-out supplies facts.

export const INBOX_EVENT_TYPES = [
  'conversation.upserted',
  'message.created',
  'message.status',
  'note.created',
  'conversation.window_closed',
  'contact.updated',
  'resync',
] as const;

export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

/** One entry of the Redis Stream `wbm:inbox:events` (data-model §5). `data` never holds full phones. */
export interface InboxEventEnvelope {
  type: InboxEventType;
  conversationId: string | null;
  numberId: string | null;
  contactId: string | null;
  state: ConversationState | null;
  intervenedById: string | null;
  blocked: boolean;
  at: string;
  /** conversation.upserted only: the facts before the change, so users who lose sight of the chat are told. */
  prev?: { state: ConversationState; intervenedById: string | null; blocked: boolean };
  data: Record<string, unknown>;
}

/** Contact tags and attributes for agent rules; null when the contact is unknown or erased. */
export interface ContactFacts {
  tagIds: readonly string[];
  attributes: Record<string, unknown>;
}

export type Delivery = { send: false } | { send: true; event: InboxEventType; data: Record<string, unknown> };

const PHONE_KEYS = new Set(['phone', 'phoneE164']);
const PREVIEW_KEYS = new Set(['lastMessagePreview', 'preview']);
const SKIP: Delivery = { send: false };

export function decideDelivery(viewer: Viewer, rules: readonly AgentRuleFacts[], contact: ContactFacts | null, envelope: InboxEventEnvelope): Delivery {
  if (envelope.type === 'resync') return { send: true, event: 'resync', data: {} };

  if (envelope.type === 'contact.updated') {
    const relevant = seesAll(viewer) || rules.length === 0 || (contact !== null && matchesRules(rules, toFacts(contact, 'ACTIVE', null, false)));
    return relevant ? { send: true, event: envelope.type, data: sanitize(viewer, envelope.data) } : SKIP;
  }

  if (envelope.state === null) return SKIP;
  // An unknown or erased contact matches no rule, but an agent still sees the chats they took.
  const facts = toFacts(contact, envelope.state, envelope.intervenedById, envelope.blocked);
  if (!facts.blocked && canAccess(viewer, rules, facts)) {
    const data = envelope.type === 'conversation.upserted' ? { ...envelope.data, visible: true } : envelope.data;
    return { send: true, event: envelope.type, data: sanitize(viewer, data) };
  }

  // The chat just left this user's view: one final update so the UI drops it (rule 1).
  const prev = envelope.prev;
  if (envelope.type === 'conversation.upserted' && prev) {
    const before = toFacts(contact, prev.state, prev.intervenedById, prev.blocked);
    if (!before.blocked && canAccess(viewer, rules, before)) {
      return { send: true, event: envelope.type, data: { id: envelope.conversationId, visible: false } };
    }
  }
  return SKIP;
}

function toFacts(contact: ContactFacts | null, state: ConversationState, intervenedById: string | null, blocked: boolean): ChatFacts {
  return { state, intervenedById, blocked, contactTagIds: contact?.tagIds ?? [], contactAttributes: contact?.attributes ?? {} };
}

/** Masks phones for users without `phones.full` and cuts previews to 120 characters (rule 2). */
function sanitize(viewer: Viewer, data: Record<string, unknown>): Record<string, unknown> {
  return clean(data, !can(viewer.role, 'phones.full'), 0) as Record<string, unknown>;
}

function clean(value: unknown, maskPhones: boolean, depth: number): unknown {
  if (depth > 10 || value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => clean(item, maskPhones, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (maskPhones && PHONE_KEYS.has(key) && typeof inner === 'string') out[key] = maskPhone(inner);
    else if (PREVIEW_KEYS.has(key) && typeof inner === 'string') out[key] = cutText(inner, PREVIEW_MAX);
    else out[key] = clean(inner, maskPhones, depth + 1);
  }
  return out;
}
