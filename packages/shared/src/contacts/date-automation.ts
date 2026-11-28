// Feature 010 (research R9, FR-020 – FR-022): when a contact is due for a date automation. Dates are
// calendar days (YYYY-MM-DD) in the company time zone; no clock or time zone maths happens here.

export type DateAutomationTiming = 'YEARLY' | 'ONCE';
export const DATE_AUTOMATION_MAX_OFFSET = 30;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function parse(value: string): number | null {
  const m = DATE.exec(value);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === value ? t : null;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The stored date's day in a given year; 29 February is 28 February in years without it. */
function inYear(month: number, dayOfMonth: number, year: number): number {
  const d = month === 2 && dayOfMonth === 29 && !isLeap(year) ? 28 : dayOfMonth;
  return Date.UTC(year, month - 1, d);
}

/**
 * Whether a contact whose attribute holds `date` is due `today`.
 * - YEARLY: the stored day and month, shifted by the offset, falls on today (the year is ignored).
 * - ONCE: the stored date shifted by the offset is today; past dates are never due.
 * A negative offset means before the date ("3 days before renewal" is -3).
 */
export function dueOn(date: string, timing: DateAutomationTiming, offsetDays: number, today: string): boolean {
  const stored = parse(date);
  const now = parse(today);
  if (stored === null || now === null || Math.abs(offsetDays) > DATE_AUTOMATION_MAX_OFFSET) return false;
  if (timing === 'ONCE') return stored + offsetDays * DAY_MS === now;
  const s = new Date(stored);
  const month = s.getUTCMonth() + 1;
  const dayOfMonth = s.getUTCDate();
  // The date that would be due today is today minus the offset; check this year and the years either
  // side, since an offset can cross a year end (31 Dec + 3 days is due on 3 Jan).
  const year = new Date(now).getUTCFullYear();
  return [year - 1, year, year + 1].some((y) => inYear(month, dayOfMonth, y) + offsetDays * DAY_MS === now);
}

/** The next `count` days from `today` and how they relate to dueOn, for previews. */
export function nextDays(today: string, count: number): string[] {
  const start = parse(today);
  if (start === null) return [];
  return Array.from({ length: count }, (_, i) => iso(start + i * DAY_MS));
}
