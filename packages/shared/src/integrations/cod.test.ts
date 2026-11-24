import { describe, expect, it } from 'vitest';
import { COD_DEFAULTS, codAfterAnswer, codAfterStoreChange, codPayload, codSettings, codTimes, parseCodPayload } from './cod.js';

// T056 (feature 006 US5, research R10): COD payloads, the first answer winning, closing and the waits.
describe('COD confirmation rules', () => {
  const orderId = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('builds and reads the button payloads', () => {
    expect(codPayload(orderId, 'CONFIRMED')).toBe(`cod1:${orderId}:Y`);
    expect(codPayload(orderId, 'CANCELLED')).toBe(`cod1:${orderId}:N`);
    expect(parseCodPayload(`cod1:${orderId}:Y`)).toEqual({ orderId, answer: 'CONFIRMED' });
    expect(parseCodPayload(` cod1:${orderId.toUpperCase()}:n `)).toEqual({ orderId, answer: 'CANCELLED' });
    for (const bad of ['', 'cod1:123:Y', `cod2:${orderId}:Y`, `cod1:${orderId}:X`, `cod1:${orderId}`, null]) expect(parseCodPayload(bad), String(bad)).toBeNull();
  });

  it('lets the first answer win, also after no answer, and keeps settled orders closed', () => {
    expect(codAfterAnswer('ASKED', 'CONFIRMED')).toEqual({ status: 'CONFIRMED', accepted: true });
    expect(codAfterAnswer('ASKED', 'CANCELLED')).toEqual({ status: 'CANCELLED', accepted: true });
    expect(codAfterAnswer('NO_ANSWER', 'CONFIRMED')).toEqual({ status: 'CONFIRMED', accepted: true });
    expect(codAfterAnswer('CONFIRMED', 'CANCELLED')).toEqual({ status: 'CONFIRMED', accepted: false });
    expect(codAfterAnswer('CANCELLED', 'CONFIRMED')).toEqual({ status: 'CANCELLED', accepted: false });
    expect(codAfterAnswer('CLOSED', 'CONFIRMED')).toEqual({ status: 'CLOSED', accepted: false });
    expect(codAfterAnswer('NONE', 'CONFIRMED')).toEqual({ status: 'NONE', accepted: false });
  });

  it('closes a waiting question when the store cancels or the order is paid first', () => {
    expect(codAfterStoreChange('ASKED', { cancelled: true, paid: false })).toBe('CLOSED');
    expect(codAfterStoreChange('ASKED', { cancelled: false, paid: true })).toBe('CLOSED');
    expect(codAfterStoreChange('NO_ANSWER', { cancelled: true, paid: false })).toBe('CLOSED');
    expect(codAfterStoreChange('ASKED', { cancelled: false, paid: false })).toBe('ASKED');
    expect(codAfterStoreChange('CONFIRMED', { cancelled: true, paid: false })).toBe('CONFIRMED');
  });

  it('counts the reminder and the final time from the question', () => {
    const asked = new Date('2026-11-24T10:00:00Z');
    expect(codTimes(asked, { reminderMinutes: 360, finalMinutes: 1440 })).toEqual({
      reminderAt: new Date('2026-11-24T16:00:00Z'),
      finalAt: new Date('2026-11-25T10:00:00Z'),
    });
    expect(codSettings({ reminderMinutes: 30, confirmedReply: '' })).toEqual({ ...COD_DEFAULTS, reminderMinutes: 30 });
  });
});
