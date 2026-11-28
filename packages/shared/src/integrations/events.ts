// The outbound webhook event catalog and payload shapes (feature 006, research R3,
// contracts/webhook-events.md). Pure, so the dashboard can show the same labels.

export const OUTBOUND_API_VERSION = '2026-11';

export const EVENT_TYPES = [
  'message.status',
  'message.received',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'contact.tags_changed',
  'contact.opted_in',
  'contact.opted_out',
  'link.clicked',
  'drip.joined',
  'drip.finished',
  'drip.left',
  'chat.assigned',
  'chat.closed',
  'api_campaign.triggered',
  'store.notification_sent',
  'store.cod_answered',
  'store.cart_recovered',
  // Feature 007 ads
  'ad.chat_started',
  'ad.lead_received',
  // Feature 008 commerce and payments (research R14); never with keys or card details
  'payment.requested',
  'payment.paid',
  'payment.failed',
  'payment.expired',
  'payment.refunded',
  'payment.cancelled',
  'chat_order.received',
  'chat_order.paid',
  'form.submitted',
  // Feature 009 (contracts/public-otp-v1.openapi.yaml): one-time code status, never the code.
  'otp.status',
  'test.ping',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Types an endpoint can choose (the test ping is sent on request only). */
export const SUBSCRIBABLE_EVENT_TYPES = EVENT_TYPES.filter((t) => t !== 'test.ping') as Exclude<EventType, 'test.ping'>[];

export type EventGroup = 'messages' | 'contacts' | 'links' | 'drips' | 'live_chat' | 'api_campaigns' | 'stores' | 'ads' | 'payments' | 'commerce' | 'forms' | 'otp' | 'test';

export const EVENT_GROUPS: Record<EventType, EventGroup> = {
  'message.status': 'messages',
  'message.received': 'messages',
  'contact.created': 'contacts',
  'contact.updated': 'contacts',
  'contact.deleted': 'contacts',
  'contact.tags_changed': 'contacts',
  'contact.opted_in': 'contacts',
  'contact.opted_out': 'contacts',
  'link.clicked': 'links',
  'drip.joined': 'drips',
  'drip.finished': 'drips',
  'drip.left': 'drips',
  'chat.assigned': 'live_chat',
  'chat.closed': 'live_chat',
  'api_campaign.triggered': 'api_campaigns',
  'store.notification_sent': 'stores',
  'store.cod_answered': 'stores',
  'store.cart_recovered': 'stores',
  'ad.chat_started': 'ads',
  'ad.lead_received': 'ads',
  'payment.requested': 'payments',
  'payment.paid': 'payments',
  'payment.failed': 'payments',
  'payment.expired': 'payments',
  'payment.refunded': 'payments',
  'payment.cancelled': 'payments',
  'chat_order.received': 'commerce',
  'chat_order.paid': 'commerce',
  'form.submitted': 'forms',
  'otp.status': 'otp',
  'test.ping': 'test',
};

export const EVENT_LABELS: Record<EventType, string> = {
  'message.status': 'Message status (sent, delivered, read, failed)',
  'message.received': 'Customer message received',
  'contact.created': 'Contact created',
  'contact.updated': 'Contact changed',
  'contact.deleted': 'Contact deleted',
  'contact.tags_changed': 'Tags added or removed',
  'contact.opted_in': 'Opted in',
  'contact.opted_out': 'Opted out',
  'link.clicked': 'Tracked link opened',
  'drip.joined': 'Joined a drip',
  'drip.finished': 'Finished a drip',
  'drip.left': 'Left a drip',
  'chat.assigned': 'Live chat assigned',
  'chat.closed': 'Live chat closed',
  'api_campaign.triggered': 'API campaign triggered',
  'store.notification_sent': 'Store message sent',
  'store.cod_answered': 'Cash-on-delivery answer',
  'store.cart_recovered': 'Cart recovered',
  'ad.chat_started': 'Chat started from an ad',
  'ad.lead_received': 'Lead received from a lead form',
  'payment.requested': 'Payment requested',
  'payment.paid': 'Payment received',
  'payment.failed': 'Payment attempt failed',
  'payment.expired': 'Payment request expired',
  'payment.refunded': 'Payment refunded',
  'payment.cancelled': 'Payment request cancelled',
  'chat_order.received': 'Order received in chat',
  'chat_order.paid': 'Chat order paid',
  'form.submitted': 'WhatsApp Form answered',
  'otp.status': 'One-time code status (sent, delivered, read, failed, expired)',
  'test.ping': 'Test event',
};

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

export interface EventContact {
  id: string;
  phone: string | null;
  name: string | null;
}

/** The common contact shape; null when the contact was deleted. Phones are E.164. */
export function eventContact(contact: { id: string; phoneE164: string | null; name: string | null } | null | undefined): EventContact | null {
  if (!contact) return null;
  const phone = contact.phoneE164 ? (contact.phoneE164.startsWith('+') ? contact.phoneE164 : `+${contact.phoneE164}`) : null;
  return { id: contact.id, phone, name: contact.name ?? null };
}

export interface EventMessage {
  id: string;
  waMessageId: string | null;
  origin: string;
  campaignId: string | null;
  apiCampaignId: string | null;
  dripId: string | null;
  templateName: string | null;
}

export function eventMessage(message: EventMessage): EventMessage {
  return {
    id: message.id,
    waMessageId: message.waMessageId ?? null,
    origin: message.origin,
    campaignId: message.campaignId ?? null,
    apiCampaignId: message.apiCampaignId ?? null,
    dripId: message.dripId ?? null,
    templateName: message.templateName ?? null,
  };
}

/** The request body sent to an endpoint. */
export function eventPayload(id: string, type: EventType, occurredAt: Date, data: unknown) {
  return { id, type, timestamp: occurredAt.toISOString(), api_version: OUTBOUND_API_VERSION, data };
}

/** Keys that must never leave the platform in an event, at any depth (FR-058). */
const SECRET_KEYS = /^(secret|secrets|token|accesstoken|access_token|apikey|api_key|password|credentials|clientsecret|client_secret|consumerkey|consumersecret|pin|signature)$/i;

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) throw new Error(`An event cannot carry "${key}" (at ${path || 'data'})`);
    assertNoSecrets(inner, path ? `${path}.${key}` : key);
  }
}

/** Fields removed from customer messages for endpoints that turned content off (FR-009). */
const CONTENT_FIELDS = ['text', 'caption', 'buttonPayload'] as const;

/** Checks an event's data and applies the endpoint's content setting. */
export function buildEvent(type: EventType, data: Record<string, unknown>, includeContent: boolean): Record<string, unknown> {
  assertNoSecrets(data, '');
  if (includeContent || type !== 'message.received') return data;
  const copy: Record<string, unknown> = { ...data };
  for (const field of CONTENT_FIELDS) delete copy[field];
  return copy;
}
