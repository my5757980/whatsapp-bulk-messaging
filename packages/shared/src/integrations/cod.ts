// Cash-on-delivery confirmation rules (feature 006 US5, FR-034 - FR-038, research R10): the button
// payloads that carry the order, the first answer winning, closing when the store settles the order
// first, and the reminder and final times.

export type CodStatusName = 'NONE' | 'ASKED' | 'CONFIRMED' | 'CANCELLED' | 'NO_ANSWER' | 'CLOSED';
export type CodAnswer = 'CONFIRMED' | 'CANCELLED';

export const COD_PAYLOAD_PREFIX = 'cod1';

export const COD_DEFAULTS = {
  reminderMinutes: 360,
  finalMinutes: 1440,
  autoCancel: false,
  confirmedReply: 'Thank you! Your order is confirmed and on its way soon.',
  cancelledReply: 'Your order is cancelled. We hope to see you again.',
  alreadyAnsweredReply: 'Thanks, we already have your answer for this order.',
} as const;

export interface CodSettingsValues {
  reminderMinutes: number;
  finalMinutes: number;
  autoCancel: boolean;
  confirmedReply: string;
  cancelledReply: string;
  alreadyAnsweredReply: string;
}

export function codSettings(saved: Partial<CodSettingsValues> | null | undefined): CodSettingsValues {
  return { ...COD_DEFAULTS, ...Object.fromEntries(Object.entries(saved ?? {}).filter(([, v]) => v !== undefined && v !== '')) };
}

/** The payload of one quick-reply button: the order and the answer (Y confirms, N cancels). */
export function codPayload(orderId: string, answer: CodAnswer): string {
  return `${COD_PAYLOAD_PREFIX}:${orderId}:${answer === 'CONFIRMED' ? 'Y' : 'N'}`;
}

const PAYLOAD = /^cod1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([YN])$/i;

export function parseCodPayload(payload: string | null | undefined): { orderId: string; answer: CodAnswer } | null {
  const m = PAYLOAD.exec((payload ?? '').trim());
  if (!m) return null;
  return { orderId: m[1]!.toLowerCase(), answer: m[2]!.toUpperCase() === 'Y' ? 'CONFIRMED' : 'CANCELLED' };
}

/**
 * The customer's tap: the first answer wins (also after "no answer"); a repeated or late tap only
 * gets the "already answered" reply, and an order the store settled first stays closed.
 */
export function codAfterAnswer(current: CodStatusName, answer: CodAnswer): { status: CodStatusName; accepted: boolean } {
  if (current === 'ASKED' || current === 'NO_ANSWER') return { status: answer, accepted: true };
  return { status: current, accepted: false };
}

/** The store settled the order (cancelled, or paid) before the customer answered. */
export function codAfterStoreChange(current: CodStatusName, order: { cancelled: boolean; paid: boolean }): CodStatusName {
  if ((current === 'ASKED' || current === 'NO_ANSWER') && (order.cancelled || order.paid)) return 'CLOSED';
  return current;
}

/** When the reminder and the final "not confirmed" fall, counted from the question. */
export function codTimes(askedAt: Date, settings: Pick<CodSettingsValues, 'reminderMinutes' | 'finalMinutes'>): { reminderAt: Date; finalAt: Date } {
  return {
    reminderAt: new Date(askedAt.getTime() + settings.reminderMinutes * 60_000),
    finalAt: new Date(askedAt.getTime() + settings.finalMinutes * 60_000),
  };
}

/** The tag the store order gets for each outcome. */
export const COD_TAGS: Record<'CONFIRMED' | 'CANCELLED' | 'NO_ANSWER', string> = {
  CONFIRMED: 'whatsapp-cod-confirmed',
  CANCELLED: 'whatsapp-cod-cancelled',
  NO_ANSWER: 'whatsapp-cod-no-answer',
};
