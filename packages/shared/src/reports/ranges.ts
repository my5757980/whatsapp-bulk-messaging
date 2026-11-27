// Feature 009 (research R14): report ranges are whole days in the company time zone, at most 366 days
// long and within the 12 months that messages are kept. Intl only, so the api and the web share it.

export const REPORT_MAX_DAYS = 366;
export const REPORT_KEPT_MONTHS = 12;

export type ReportRangeProblem = 'BAD_DATE' | 'TO_BEFORE_FROM' | 'TOO_LONG' | 'TOO_OLD';

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight UTC of a YYYY-MM-DD day, or null when it is not a real date. */
function utcDay(value: string): number | null {
  if (!DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

/** Why a report range is refused, or null. `today` is the company's date (YYYY-MM-DD). */
export function reportRangeProblem(from: string, to: string, today: string): ReportRangeProblem | null {
  const f = utcDay(from);
  const t = utcDay(to);
  const now = utcDay(today);
  if (f === null || t === null || now === null) return 'BAD_DATE';
  if (t < f) return 'TO_BEFORE_FROM';
  if ((t - f) / DAY_MS + 1 > REPORT_MAX_DAYS) return 'TOO_LONG';
  const oldest = new Date(now);
  oldest.setUTCMonth(oldest.getUTCMonth() - REPORT_KEPT_MONTHS);
  if (f < oldest.getTime()) return 'TOO_OLD';
  return null;
}

/** Words for each problem, for the api's 422 and the web's form. */
export const REPORT_RANGE_WORDS: Readonly<Record<ReportRangeProblem, string>> = {
  BAD_DATE: 'Choose real dates (YYYY-MM-DD)',
  TO_BEFORE_FROM: 'The last day is before the first day',
  TOO_LONG: `A report covers at most ${REPORT_MAX_DAYS} days`,
  TOO_OLD: `Reports cover the last ${REPORT_KEPT_MONTHS} months; older messages are removed`,
};

/** Offset of `timeZone` from UTC at `date`, in milliseconds (zone time minus UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant local midnight starts `day` (YYYY-MM-DD) in `timeZone`, daylight-saving changes included. */
export function zonedMidnight(day: string, timeZone: string): Date {
  const guess = utcDay(day);
  if (guess === null) throw new Error(`Not a date: ${day}`);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** The company's date (YYYY-MM-DD) at `now`. */
export function dayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The range's first instant (inclusive) and the instant after its last day (exclusive). */
export function reportRangeBounds(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  const next = new Date((utcDay(to) ?? Number.NaN) + DAY_MS).toISOString().slice(0, 10);
  return { start: zonedMidnight(from, timeZone), end: zonedMidnight(next, timeZone) };
}
