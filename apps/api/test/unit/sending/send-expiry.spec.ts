import { describe, expect, it } from 'vitest';
import { deliveryDeadline, sendExpiry } from '../../../src/modules/sending/send-expiry.js';

// T048 (feature 009 US4, research R7, R8): what the send processor drops before sending, and when a sent
// message counts as not delivered in time.
const now = new Date('2026-12-01T10:00:00Z');
const minutes = (m: number) => new Date(now.getTime() + m * 60_000);

describe('sendExpiry', () => {
  it('drops a message whose time-to-live passed since it was created, for every kind of template', () => {
    // Codes (5 minutes), utility (1 hour) and marketing (12 hours, our queue only) alike.
    for (const ttlSeconds of [300, 3_600, 43_200]) {
      expect(sendExpiry({ createdAt: new Date(now.getTime() - ttlSeconds * 1000), ttlSeconds, offerEndsAtMs: null }, now), String(ttlSeconds)).toEqual({ expire: true, reason: 'EXPIRED_BEFORE_SENDING' });
      expect(sendExpiry({ createdAt: new Date(now.getTime() - ttlSeconds * 1000 + 1_000), ttlSeconds, offerEndsAtMs: null }, now), String(ttlSeconds)).toEqual({ expire: false });
    }
  });

  it('counts from creation, so a paused campaign resumed after the time-to-live does not send', () => {
    // Launched 70 minutes ago with a 1-hour time-to-live; claimed again just now after a pause.
    expect(sendExpiry({ createdAt: minutes(-70), ttlSeconds: 3_600, offerEndsAtMs: null }, now)).toEqual({ expire: true, reason: 'EXPIRED_BEFORE_SENDING' });
  });

  it('drops a message whose offer has ended, before the time-to-live', () => {
    expect(sendExpiry({ createdAt: minutes(-1), ttlSeconds: null, offerEndsAtMs: minutes(-0.5).getTime() }, now)).toEqual({ expire: true, reason: 'OFFER_ENDED' });
    expect(sendExpiry({ createdAt: minutes(-120), ttlSeconds: 3_600, offerEndsAtMs: minutes(-1).getTime() }, now)).toEqual({ expire: true, reason: 'OFFER_ENDED' });
    expect(sendExpiry({ createdAt: minutes(-1), ttlSeconds: null, offerEndsAtMs: minutes(10).getTime() }, now)).toEqual({ expire: false });
  });

  it('keeps messages without a time-to-live or an offer', () => {
    expect(sendExpiry({ createdAt: minutes(-100_000), ttlSeconds: null, offerEndsAtMs: null }, now)).toEqual({ expire: false });
    expect(sendExpiry({ createdAt: minutes(-100_000), ttlSeconds: 0, offerEndsAtMs: Number.NaN }, now)).toEqual({ expire: false });
  });
});

describe('deliveryDeadline', () => {
  it('is set only for a time-to-live that Meta applies', () => {
    expect(deliveryDeadline({ ttlSeconds: 300, ttlAppliedBy: 'META' }, now)).toEqual(minutes(5));
    expect(deliveryDeadline({ ttlSeconds: 43_200, ttlAppliedBy: 'PLATFORM' }, now)).toBeNull();
    expect(deliveryDeadline({ ttlSeconds: null, ttlAppliedBy: null }, now)).toBeNull();
  });
});
