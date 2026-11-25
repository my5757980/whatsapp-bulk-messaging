// Budgets and the monthly spending cap (feature 007, FR-010, FR-018, FR-019, research R5, R7). Money
// is in the ad account currency's minor units; days and months are in the account's time zone.

export function budgetProblem(dailyBudgetMinor: number, minDailyBudgetMinor: number): string | null {
  if (!Number.isInteger(dailyBudgetMinor) || dailyBudgetMinor <= 0) return 'must be a whole positive amount';
  return dailyBudgetMinor < minDailyBudgetMinor ? `must be at least ${minDailyBudgetMinor} (Meta's minimum for this account)` : null;
}

/** The local year, month and day of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as { year: number; month: number; day: number };
  return parts;
}

/** `YYYY-MM` and the days left in the month, today included. */
export function monthLeft(now: Date, timeZone: string): { month: string; daysLeft: number; firstDay: string } {
  const { year, month, day } = localParts(now, timeZone);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { month: `${year}-${mm}`, daysLeft: daysInMonth - day + 1, firstDay: `${year}-${mm}-01` };
}

export interface CapInput {
  capMinor: number | null;
  spentThisMonthMinor: number;
  /** Daily budgets of the platform's other active campaigns. */
  activeDailyBudgetsMinor: number[];
  /** The budget the change would run at (a launch, a resume or a new budget). */
  newDailyBudgetMinor: number;
  now: Date;
  timeZone: string;
}

export type CapResult = { ok: true; projectedMinor: number } | { ok: false; projectedMinor: number; remainingMinor: number };

/** Refuse a change that could let the month's spend pass the cap (FR-018). */
export function capCheck(input: CapInput): CapResult {
  const { daysLeft } = monthLeft(input.now, input.timeZone);
  const daily = input.activeDailyBudgetsMinor.reduce((sum, b) => sum + b, 0) + input.newDailyBudgetMinor;
  const projectedMinor = input.spentThisMonthMinor + daily * daysLeft;
  if (input.capMinor === null || projectedMinor <= input.capMinor) return { ok: true, projectedMinor };
  return { ok: false, projectedMinor, remainingMinor: Math.max(0, input.capMinor - input.spentThisMonthMinor) };
}

export function capReached(capMinor: number | null, spentThisMonthMinor: number): boolean {
  return capMinor !== null && spentThisMonthMinor >= capMinor;
}

/** Minor units to an amount with the currency's own decimals, for display. */
export function formatMinor(minor: number, currency: string, locale = 'en'): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

/** An amount typed in major units (for example 50.5) to minor units for the currency. */
export function toMinor(amount: number, currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return Math.round(amount * 10 ** digits);
}
