import { describe, expect, it } from 'vitest';
import { WINDOW_MS, inHistory, isLive, latest, startsOpening, windowEndsAt } from '../../../src/modules/inbox/conversations/window.js';

// T007: the 24-hour customer service window (FR-006, research R5, data-model §4).
const t = (iso: string) => new Date(iso);
const last = t('2026-11-19T10:00:00.000Z');

describe('24-hour window', () => {
  it('lasts exactly 24 hours', () => {
    expect(WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('ends 24 hours after the last customer message', () => {
    expect(windowEndsAt(last)).toEqual(t('2026-11-20T10:00:00.000Z'));
  });

  it('does not exist when the customer never wrote', () => {
    expect(windowEndsAt(null)).toBeNull();
    expect(isLive(null, last)).toBe(false);
    expect(inHistory(null, last)).toBe(true);
  });

  it('is live until the 24-hour mark and in History from it on', () => {
    expect(isLive(last, t('2026-11-20T09:59:59.999Z'))).toBe(true);
    expect(inHistory(last, t('2026-11-20T09:59:59.999Z'))).toBe(false);
    expect(isLive(last, t('2026-11-20T10:00:00.000Z'))).toBe(false);
    expect(inHistory(last, t('2026-11-20T10:00:00.000Z'))).toBe(true);
  });

  it('defaults to the current time', () => {
    expect(isLive(new Date(Date.now() - 60_000))).toBe(true);
    expect(isLive(new Date(Date.now() - WINDOW_MS - 60_000))).toBe(false);
  });

  it('does not depend on time zones', () => {
    const sameInstant = t('2026-11-19T15:00:00.000+05:00'); // 10:00 UTC
    expect(windowEndsAt(sameInstant)).toEqual(windowEndsAt(last));
    expect(isLive(sameInstant, t('2026-11-20T13:59:00.000+04:00'))).toBe(true); // 09:59 UTC
    expect(isLive(sameInstant, t('2026-11-20T14:00:00.000+04:00'))).toBe(false); // 10:00 UTC
  });
});

describe('openings', () => {
  it('start with the first customer message', () => {
    expect(startsOpening(null, last)).toBe(true);
  });

  it('do not start while the window is open', () => {
    expect(startsOpening(last, t('2026-11-20T09:59:00.000Z'))).toBe(false);
  });

  it('start again once the window had closed', () => {
    expect(startsOpening(last, t('2026-11-20T10:00:00.000Z'))).toBe(true);
    expect(startsOpening(last, t('2026-11-25T08:00:00.000Z'))).toBe(true);
  });

  it('do not start for an older message delivered late', () => {
    expect(startsOpening(last, t('2026-11-19T09:00:00.000Z'))).toBe(false);
  });
});

describe('latest', () => {
  it('keeps the newer timestamp when webhooks arrive out of order', () => {
    expect(latest(last, t('2026-11-19T09:00:00.000Z'))).toEqual(last);
    expect(latest(last, t('2026-11-19T11:00:00.000Z'))).toEqual(t('2026-11-19T11:00:00.000Z'));
    expect(latest(null, last)).toEqual(last);
  });
});
