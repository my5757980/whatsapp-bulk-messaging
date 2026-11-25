import { describe, expect, it } from 'vitest';
import { AUTO_PAUSE_AFTER_MS, AUTO_PAUSE_MIN_FAILURES, DELIVERY_RETRY_WAITS_SECONDS, MAX_DELIVERY_ATTEMPTS, isLastAttempt, nextAttemptAt, shouldAutoPause } from './retries.js';

// T009 (feature 006, research R2): webhook delivery retries and the endpoint auto-pause rule.
describe('delivery retries', () => {
  it('waits 10 s, 1 min, 5 min, 30 min, 1 h, 2 h, 4 h, 8 h and 8 h: 9 retries, about 23 h 36 min', () => {
    expect(DELIVERY_RETRY_WAITS_SECONDS).toEqual([10, 60, 300, 1800, 3600, 7200, 14400, 28800, 28800]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(10);
    const total = DELIVERY_RETRY_WAITS_SECONDS.reduce((a, b) => a + b, 0);
    expect(total).toBe(23 * 3600 + 36 * 60 + 10);
    expect(total).toBeLessThan(24 * 3600);
  });

  it('gives the next attempt time after each failed attempt, and none after the last', () => {
    const now = new Date('2026-11-24T10:00:00Z');
    expect(nextAttemptAt(1, now)?.toISOString()).toBe('2026-11-24T10:00:10.000Z');
    expect(nextAttemptAt(2, now)?.toISOString()).toBe('2026-11-24T10:01:00.000Z');
    expect(nextAttemptAt(9, now)?.toISOString()).toBe('2026-11-24T18:00:00.000Z');
    expect(nextAttemptAt(10, now)).toBeNull();
    expect(isLastAttempt(9)).toBe(false);
    expect(isLastAttempt(10)).toBe(true);
    expect(() => nextAttemptAt(0, now)).toThrow();
  });
});

describe('shouldAutoPause', () => {
  const now = new Date('2026-11-25T10:00:00Z');
  const day = AUTO_PAUSE_AFTER_MS;

  it('pauses an endpoint with no success for 24 hours and at least 10 failed attempts', () => {
    expect(AUTO_PAUSE_AFTER_MS).toBe(24 * 3600 * 1000);
    expect(AUTO_PAUSE_MIN_FAILURES).toBe(10);
    expect(shouldAutoPause({ failingSince: new Date(now.getTime() - day), consecutiveFailures: 10, now })).toBe(true);
  });

  it('keeps it running while either condition is missing', () => {
    expect(shouldAutoPause({ failingSince: new Date(now.getTime() - day + 1000), consecutiveFailures: 50, now })).toBe(false);
    expect(shouldAutoPause({ failingSince: new Date(now.getTime() - 2 * day), consecutiveFailures: 9, now })).toBe(false);
    expect(shouldAutoPause({ failingSince: null, consecutiveFailures: 100, now })).toBe(false);
  });
});
