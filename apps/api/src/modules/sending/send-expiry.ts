// Feature 009 (research R7, R8): a message still waiting to be sent when its template's time-to-live has
// passed since it was created (the campaign launch, the API call or the code request), or after its
// offer ended, is not sent; it becomes EXPIRED with the reason. A pause or a retry round does not restart
// the clock. Pure, so it is unit-tested.

export type ExpiryDecision = { expire: false } | { expire: true; reason: 'EXPIRED_BEFORE_SENDING' | 'OFFER_ENDED' };

export interface ExpiryInput {
  /** When the message was created: the campaign launch, the API call or the code request. */
  createdAt: Date;
  /** The template's time-to-live in seconds (Meta's or the platform's), or null. */
  ttlSeconds: number | null;
  /** A limited-time offer's end in Unix milliseconds, or null. */
  offerEndsAtMs: number | null;
}

export function sendExpiry(input: ExpiryInput, now: Date): ExpiryDecision {
  if (input.offerEndsAtMs !== null && Number.isFinite(input.offerEndsAtMs) && input.offerEndsAtMs > 0 && input.offerEndsAtMs <= now.getTime()) return { expire: true, reason: 'OFFER_ENDED' };
  if (input.ttlSeconds && input.createdAt.getTime() + input.ttlSeconds * 1000 <= now.getTime()) return { expire: true, reason: 'EXPIRED_BEFORE_SENDING' };
  return { expire: false };
}

/**
 * When a sent message counts as not delivered in time (research R8): only for a time-to-live that Meta
 * applies (codes and utility), because Meta then drops the message without an error. Null otherwise.
 */
export function deliveryDeadline(template: { ttlSeconds: number | null; ttlAppliedBy: string | null }, sentAt: Date): Date | null {
  return template.ttlSeconds && template.ttlAppliedBy === 'META' ? new Date(sentAt.getTime() + template.ttlSeconds * 1000) : null;
}
