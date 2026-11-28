import { dueOn } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { addDays, companyClock, dueCondition, dueTarget } from '../../../src/modules/automations/due-query.js';

// T055 (feature 010 US5, research R9): the due conditions for yearly and one-time dates, offsets and
// 29 February, and the company day in other time zones.

/** What the SQL condition decides for one stored value, evaluated in TypeScript. */
function sqlSaysDue(stored: string, timing: 'YEARLY' | 'ONCE', offset: number, today: string): boolean {
  const t = dueTarget(timing, offset, today);
  return t.timing === 'ONCE' ? stored === t.date : /^\d{4}-\d{2}-\d{2}$/.test(stored) && t.monthDays.includes(stored.slice(5));
}

describe('dueCondition', () => {
  it('compares a one-time date with today minus the offset', () => {
    const sql = dueCondition('renewal', 'ONCE', -3, '2027-05-10');
    expect(sql.sql).toBe('(c.attributes ->> ?) = ?');
    expect(sql.values).toEqual(['renewal', '2027-05-13']);
  });

  it('compares the month and day of a yearly date', () => {
    const sql = dueCondition('birthday', 'YEARLY', 0, '2027-07-04');
    expect(sql.sql).toBe("((c.attributes ->> ?) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND substr((c.attributes ->> ?), 6, 5) IN (?))");
    expect(sql.values).toEqual(['birthday', 'birthday', '07-04']);
  });

  it('sends 29 February birthdays on 28 February in years without it', () => {
    expect(dueTarget('YEARLY', 0, '2027-02-28')).toEqual({ timing: 'YEARLY', monthDays: ['02-28', '02-29'] });
    expect(dueTarget('YEARLY', 0, '2028-02-28')).toEqual({ timing: 'YEARLY', monthDays: ['02-28'] });
    expect(dueTarget('YEARLY', 0, '2028-02-29')).toEqual({ timing: 'YEARLY', monthDays: ['02-29'] });
    // Two days before: due on 26 February 2027 for both 28 and 29 February.
    expect(dueTarget('YEARLY', -2, '2027-02-26')).toEqual({ timing: 'YEARLY', monthDays: ['02-28', '02-29'] });
  });

  it('crosses year ends with offsets', () => {
    expect(dueTarget('YEARLY', 3, '2027-01-02')).toEqual({ timing: 'YEARLY', monthDays: ['12-30'] });
    expect(dueTarget('YEARLY', -3, '2026-12-30')).toEqual({ timing: 'YEARLY', monthDays: ['01-02'] });
  });

  it('refuses offsets beyond 30 days', () => {
    expect(() => dueTarget('YEARLY', 31, '2027-01-02')).toThrow();
    expect(() => dueTarget('ONCE', 1.5, '2027-01-02')).toThrow();
  });

  it('agrees with the shared dueOn rule on every day of three years', () => {
    const stored = ['2024-02-29', '2023-12-31', '2025-01-01', '2026-03-01', '2028-02-28', '1990-07-15', '2027-06-30'];
    let checked = 0;
    for (let day = '2026-01-01'; day <= '2028-12-31'; day = addDays(day, 1)) {
      for (const offset of [-30, -3, -1, 0, 1, 3, 30]) {
        for (const timing of ['YEARLY', 'ONCE'] as const) {
          for (const value of stored) {
            expect(sqlSaysDue(value, timing, offset, day), `${value} ${timing} ${offset} on ${day}`).toBe(dueOn(value, timing, offset, day));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });
});

describe('companyClock', () => {
  const instant = new Date('2027-03-01T22:30:00Z');

  it('reads the day and time in the company time zone', () => {
    expect(companyClock(instant, 'UTC')).toEqual({ date: '2027-03-01', time: '22:30' });
    expect(companyClock(instant, 'Asia/Dubai')).toEqual({ date: '2027-03-02', time: '02:30' });
    expect(companyClock(instant, 'America/Los_Angeles')).toEqual({ date: '2027-03-01', time: '14:30' });
    expect(companyClock(instant, 'Pacific/Kiritimati')).toEqual({ date: '2027-03-02', time: '12:30' });
  });

  it('uses 00 for midnight hours', () => {
    expect(companyClock(new Date('2027-03-01T20:05:00Z'), 'Asia/Dubai')).toEqual({ date: '2027-03-02', time: '00:05' });
  });
});
