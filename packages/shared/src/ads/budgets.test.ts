import { describe, expect, it } from 'vitest';
import { budgetProblem, capCheck, capReached, formatMinor, monthLeft, toMinor } from './budgets.js';

// T007 (feature 007, research R5, R7): minimum budgets and the monthly spending cap.
describe('ad budgets and the spending cap', () => {
  it("refuses budgets below Meta's minimum", () => {
    expect(budgetProblem(500, 400)).toBeNull();
    expect(budgetProblem(300, 400)).toBe("must be at least 400 (Meta's minimum for this account)");
    expect(budgetProblem(0, 400)).toBe('must be a whole positive amount');
  });

  it("counts the days left in the account's month, today included", () => {
    expect(monthLeft(new Date('2026-11-25T10:00:00Z'), 'Asia/Dubai')).toEqual({ month: '2026-11', daysLeft: 6, firstDay: '2026-11-01' });
    // 22:00 UTC on 30 November is already 1 December in Dubai.
    expect(monthLeft(new Date('2026-11-30T22:00:00Z'), 'Asia/Dubai')).toEqual({ month: '2026-12', daysLeft: 31, firstDay: '2026-12-01' });
    expect(monthLeft(new Date('2028-02-29T12:00:00Z'), 'UTC').daysLeft).toBe(1);
  });

  it('refuses a change that could pass the cap, with the remaining amount', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const base = { spentThisMonthMinor: 100_000, activeDailyBudgetsMinor: [5_000], now, timeZone: 'Asia/Dubai' };
    expect(capCheck({ ...base, capMinor: null, newDailyBudgetMinor: 50_000 })).toEqual({ ok: true, projectedMinor: 100_000 + 55_000 * 6 });
    expect(capCheck({ ...base, capMinor: 200_000, newDailyBudgetMinor: 5_000 })).toEqual({ ok: true, projectedMinor: 160_000 });
    expect(capCheck({ ...base, capMinor: 150_000, newDailyBudgetMinor: 5_000 })).toEqual({ ok: false, projectedMinor: 160_000, remainingMinor: 50_000 });
    expect(capCheck({ ...base, spentThisMonthMinor: 160_000, capMinor: 150_000, newDailyBudgetMinor: 1 })).toMatchObject({ ok: false, remainingMinor: 0 });
    expect(capReached(150_000, 150_000)).toBe(true);
    expect(capReached(150_000, 149_999)).toBe(false);
    expect(capReached(null, 1e9)).toBe(false);
  });

  it("formats and reads amounts with the currency's decimals", () => {
    // Intl puts a non-breaking space between the code and the amount.
    expect(formatMinor(5_050, 'AED').replace(/\s/g, ' ')).toBe('AED 50.50');
    expect(formatMinor(5_000, 'JPY')).toBe('¥5,000');
    expect(toMinor(50.5, 'AED')).toBe(5_050);
    expect(toMinor(500, 'JPY')).toBe(500);
  });
});
