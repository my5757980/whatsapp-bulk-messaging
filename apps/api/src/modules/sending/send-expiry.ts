// Feature 009 (research R7, R8): a message that waited in our queue past its template's time-to-live, or
// whose offer has ended, is not sent; it becomes EXPIRED with the reason. Pure, so it is unit-tested.

export type ExpiryDecision = { expire: false } | { expire: true; reason: 'EXPIRED_BEFORE_SENDING' | 'OFFER_ENDED' };

export interface ExpiryInput {
  /** When the message entered the send queue (created when never queued). */
  queuedAt: Date | null;
  createdAt: Date;
  /** The template's time-to-live in seconds (Meta's or the platform's), or null. */
  ttlSeconds: number | null;
  /** A limited-time offer's end in Unix milliseconds, or null. */
  offerEndsAtMs: number | null;
}

export function sendExpiry(input: ExpiryInput, now: Date): ExpiryDecision {
  if (input.offerEndsAtMs !== null && Number.isFinite(input.offerEndsAtMs) && input.offerEndsAtMs > 0 && input.offerEndsAtMs <= now.getTime()) return { expire: true, reason: 'OFFER_ENDED' };
  if (input.ttlSeconds) {
    const since = (input.queuedAt ?? input.createdAt).getTime();
    if (since + input.ttlSeconds * 1000 <= now.getTime()) return { expire: true, reason: 'EXPIRED_BEFORE_SENDING' };
  }
  return { expire: false };
}
