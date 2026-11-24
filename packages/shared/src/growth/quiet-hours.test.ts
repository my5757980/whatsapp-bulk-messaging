import { describe, expect, it } from 'vitest';
import { isQuietAt, nextSendableAt, quietHoursProblem } from './quiet-hours.js';

// T009 (feature 005, FR-021): quiet hours in the company time zone. 2026-11-23 is a Monday.
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const night = { from: '21:00', to: '09:00', days: EVERY_DAY };

describe('quietHoursProblem', () => {
  it('needs two different HH:MM times and at least one weekday from 1 to 7', () => {
    expect(quietHoursProblem(night)).toBeNull();
    expect(quietHoursProblem({ from: '9:00', to: '17:00', days: EVERY_DAY })).toBe('BAD_TIME');
    expect(quietHoursProblem({ from: '24:00', to: '17:00', days: EVERY_DAY })).toBe('BAD_TIME');
    expect(quietHoursProblem({ from: '17:00', to: '17:00', days: EVERY_DAY })).toBe('SAME_TIMES');
    expect(quietHoursProblem({ from: '21:00', to: '09:00', days: [] })).toBe('NO_DAYS');
    expect(quietHoursProblem({ from: '21:00', to: '09:00', days: [0] })).toBe('BAD_DAY');
    expect(quietHoursProblem({ from: '21:00', to: '09:00', days: [8] })).toBe('BAD_DAY');
  });
});

describe('isQuietAt', () => {
  it('is never quiet without quiet hours', () => {
    expect(isQuietAt(null, 'Asia/Dubai', new Date('2026-11-23T20:00:00Z'))).toBe(false);
  });

  it('checks a window that crosses midnight in the time zone', () => {
    // Dubai is UTC+4 all year.
    expect(isQuietAt(night, 'Asia/Dubai', new Date('2026-11-23T18:00:00Z'))).toBe(true); // 22:00
    expect(isQuietAt(night, 'Asia/Dubai', new Date('2026-11-23T04:59:00Z'))).toBe(true); // 08:59
    expect(isQuietAt(night, 'Asia/Dubai', new Date('2026-11-23T05:00:00Z'))).toBe(false); // 09:00
    expect(isQuietAt(night, 'Asia/Dubai', new Date('2026-11-23T16:59:00Z'))).toBe(false); // 20:59
    expect(isQuietAt(night, 'Asia/Dubai', new Date('2026-11-23T17:00:00Z'))).toBe(true); // 21:00
  });

  it('checks a window inside one day', () => {
    const lunch = { from: '13:00', to: '14:00', days: EVERY_DAY };
    expect(isQuietAt(lunch, 'UTC', new Date('2026-11-23T13:30:00Z'))).toBe(true);
    expect(isQuietAt(lunch, 'UTC', new Date('2026-11-23T14:00:00Z'))).toBe(false);
    expect(isQuietAt(lunch, 'UTC', new Date('2026-11-23T12:59:00Z'))).toBe(false);
  });

  it('applies only on the chosen days, counting a night from the day it starts', () => {
    const weekNights = { from: '21:00', to: '09:00', days: [1, 2, 3, 4, 5] };
    // Friday 2026-11-27 22:00 Dubai starts a chosen night; it goes on into Saturday morning.
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-27T18:00:00Z'))).toBe(true);
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-27T22:00:00Z'))).toBe(true); // Sat 02:00
    // Saturday night is not chosen.
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-28T18:00:00Z'))).toBe(false); // Sat 22:00
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-28T22:00:00Z'))).toBe(false); // Sun 02:00
    // Sunday night is not chosen either; Monday night is.
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-29T22:00:00Z'))).toBe(false); // Mon 02:00
    expect(isQuietAt(weekNights, 'Asia/Dubai', new Date('2026-11-30T18:00:00Z'))).toBe(true); // Mon 22:00
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(isQuietAt(night, 'Not/AZone', new Date('2026-11-23T22:00:00Z'))).toBe(true);
    expect(isQuietAt(night, 'Not/AZone', new Date('2026-11-23T12:00:00Z'))).toBe(false);
  });
});

describe('nextSendableAt', () => {
  it('returns the same time outside quiet hours', () => {
    const at = new Date('2026-11-23T06:00:00Z'); // 10:00 Dubai
    expect(nextSendableAt(night, 'Asia/Dubai', at).toISOString()).toBe(at.toISOString());
    expect(nextSendableAt(null, 'Asia/Dubai', at).toISOString()).toBe(at.toISOString());
  });

  it('moves a time inside quiet hours to when they end', () => {
    // 22:00 Monday Dubai -> 09:00 Tuesday Dubai.
    expect(nextSendableAt(night, 'Asia/Dubai', new Date('2026-11-23T18:00:30Z')).toISOString()).toBe('2026-11-24T05:00:00.000Z');
    // 03:00 Tuesday Dubai -> 09:00 the same morning.
    expect(nextSendableAt(night, 'Asia/Dubai', new Date('2026-11-23T23:00:00Z')).toISOString()).toBe('2026-11-24T05:00:00.000Z');
  });

  it('lands on the wall-clock end across a daylight saving change', () => {
    const early = { from: '01:00', to: '03:00', days: EVERY_DAY };
    // New York falls back on 2026-11-01: 01:30 EDT -> 03:00 EST (08:00Z).
    expect(nextSendableAt(early, 'America/New_York', new Date('2026-11-01T05:30:00Z')).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    // New York springs forward on 2026-03-08 (02:00 -> 03:00): 02:30 does not exist, so sending starts at 03:00 EDT.
    const toHalfPastTwo = { from: '00:00', to: '02:30', days: EVERY_DAY };
    expect(nextSendableAt(toHalfPastTwo, 'America/New_York', new Date('2026-03-08T06:00:00Z')).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });
});
