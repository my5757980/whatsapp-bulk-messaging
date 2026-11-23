// Drip quiet hours in the company time zone (feature 005, FR-021). Pure: Intl handles the zone and
// daylight saving time. A window may cross midnight; it belongs to the day it starts on, so a Friday
// night window goes on into Saturday morning even when Saturday is not chosen.

export interface QuietHours {
  /** "HH:MM", included. */
  from: string;
  /** "HH:MM", excluded. */
  to: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  days: readonly number[];
}

export type QuietHoursProblem = 'BAD_TIME' | 'SAME_TIMES' | 'NO_DAYS' | 'BAD_DAY';

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAY_MINUTES = 24 * 60;
const ISO_DAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function quietHoursProblem(quiet: QuietHours): QuietHoursProblem | null {
  if (!HHMM.test(quiet.from) || !HHMM.test(quiet.to)) return 'BAD_TIME';
  if (quiet.from === quiet.to) return 'SAME_TIMES';
  if (quiet.days.length === 0) return 'NO_DAYS';
  if (quiet.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return 'BAD_DAY';
  return null;
}

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** ISO weekday and minutes since midnight of an instant in a time zone (UTC when the zone is unknown). */
function localClock(timezone: string, at: Date): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0';
  return { day: ISO_DAY[part('weekday')] ?? 1, minutes: (Number(part('hour')) % 24) * 60 + Number(part('minute')) };
}

export function isQuietAt(quiet: QuietHours | null | undefined, timezone: string, at: Date): boolean {
  if (!quiet || quietHoursProblem(quiet)) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const { day, minutes } = localClock(timezone, at);
  if (from < to) return minutes >= from && minutes < to && quiet.days.includes(day);
  if (minutes >= from) return quiet.days.includes(day);
  if (minutes < to) return quiet.days.includes(day === 1 ? 7 : day - 1);
  return false;
}

/** `at` when sending may happen then; otherwise the moment the quiet hours end. */
export function nextSendableAt(quiet: QuietHours | null | undefined, timezone: string, at: Date): Date {
  if (!quiet || !isQuietAt(quiet, timezone, at)) return at;
  const to = minutesOf(quiet.to);
  const now = localClock(timezone, at).minutes;
  const minutesLeft = now < to ? to - now : DAY_MINUTES - now + to;
  const startOfMinute = Math.floor(at.getTime() / 60_000) * 60_000;
  let candidate = new Date(startOfMinute + minutesLeft * 60_000);
  // A daylight saving change in between shifts the wall clock: correct to the wall-clock end.
  let drift = to - localClock(timezone, candidate).minutes;
  if (drift > DAY_MINUTES / 2) drift -= DAY_MINUTES;
  if (drift < -DAY_MINUTES / 2) drift += DAY_MINUTES;
  if (drift !== 0) candidate = new Date(candidate.getTime() + drift * 60_000);
  if (candidate.getTime() <= at.getTime()) candidate = new Date(startOfMinute + 60_000);
  // The end may not exist on a spring-forward day: step on until sending may start.
  for (let i = 0; i < 6 && isQuietAt(quiet, timezone, candidate); i += 1) candidate = new Date(candidate.getTime() + 30 * 60_000);
  return candidate;
}
