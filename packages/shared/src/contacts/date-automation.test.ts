import { describe, expect, it } from 'vitest';
import { dueOn, nextDays } from './date-automation.js';

// T008 (feature 010, research R9): due dates for date automations.
describe('dueOn', () => {
  it('yearly: due on the day and month, whatever the year', () => {
    expect(dueOn('1990-05-14', 'YEARLY', 0, '2026-05-14')).toBe(true);
    expect(dueOn('1990-05-14', 'YEARLY', 0, '2026-05-15')).toBe(false);
    expect(dueOn('2024-11-28', 'YEARLY', 0, '2026-11-28')).toBe(true);
  });

  it('yearly with an offset, across month and year ends', () => {
    expect(dueOn('1990-05-14', 'YEARLY', -3, '2026-05-11')).toBe(true);
    expect(dueOn('1990-05-14', 'YEARLY', 3, '2026-05-17')).toBe(true);
    expect(dueOn('1985-01-02', 'YEARLY', -3, '2026-12-30')).toBe(true);
    expect(dueOn('1985-12-31', 'YEARLY', 3, '2027-01-03')).toBe(true);
    expect(dueOn('1985-03-01', 'YEARLY', -1, '2028-02-29')).toBe(true);
  });

  it('29 February is due on 28 February in years without it', () => {
    expect(dueOn('2000-02-29', 'YEARLY', 0, '2027-02-28')).toBe(true);
    expect(dueOn('2000-02-29', 'YEARLY', 0, '2027-03-01')).toBe(false);
    expect(dueOn('2000-02-29', 'YEARLY', 0, '2028-02-29')).toBe(true);
    expect(dueOn('2000-02-29', 'YEARLY', 0, '2028-02-28')).toBe(false);
  });

  it('once: due on the exact date (with its offset), never for past dates', () => {
    expect(dueOn('2026-12-01', 'ONCE', 0, '2026-12-01')).toBe(true);
    expect(dueOn('2026-12-01', 'ONCE', -3, '2026-11-28')).toBe(true);
    expect(dueOn('2026-12-01', 'ONCE', 0, '2027-12-01')).toBe(false);
    expect(dueOn('2025-11-28', 'ONCE', 0, '2026-11-28')).toBe(false);
  });

  it('refuses bad dates and offsets beyond 30 days', () => {
    expect(dueOn('1990-02-30', 'YEARLY', 0, '2026-02-28')).toBe(false);
    expect(dueOn('not a date', 'YEARLY', 0, '2026-02-28')).toBe(false);
    expect(dueOn('1990-05-14', 'YEARLY', 31, '2026-06-14')).toBe(false);
  });
});

describe('nextDays', () => {
  it('lists consecutive days', () => {
    expect(nextDays('2026-12-30', 3)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });
});
