import { localTime, type Weekday, type WorkingHours } from '@wbm/shared';

// The next opening of the team's working hours, for hand-over messages outside hours (FR-024).

const DAY_NAMES: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_MS = 86_400_000;

/** "today at 09:00", "tomorrow at 09:00" or "Sunday at 09:00"; null when no hours are set. */
export function nextOpening(hours: Partial<WorkingHours>, timezone: string, now: Date = new Date()): string | null {
  const today = localTime(timezone, now);
  for (let offset = 0; offset < 8; offset += 1) {
    const { weekday } = offset === 0 ? today : localTime(timezone, new Date(now.getTime() + offset * DAY_MS));
    const starts = (hours[weekday] ?? []).map(([start]) => start).sort();
    const start = offset === 0 ? starts.find((s) => s > today.hhmm) : starts[0];
    if (!start) continue;
    const day = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : DAY_NAMES[weekday];
    return `${day} at ${start}`;
  }
  return null;
}

/** "YYYY-MM-DD HH:MM" in the time zone, for the turn context. */
export function localStamp(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
