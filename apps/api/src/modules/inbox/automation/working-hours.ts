// Working hours in an IANA time zone (T079, FR-035, research R10). Pure: Intl handles the zone
// and daylight saving time. Ranges are HH:MM, start included, end excluded; an empty day is closed.

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WorkingHours = Record<Weekday, Array<[string, string]>>;

const WEEKDAY_BY_SHORT: Record<string, Weekday> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/** The weekday and "HH:MM" of an instant in a time zone. */
export function localTime(timezone: string, at: Date): { weekday: Weekday; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: WEEKDAY_BY_SHORT[get('weekday')] ?? 'mon', hhmm: `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}` };
}

export function isWithinHours(hours: Partial<WorkingHours>, timezone: string, at: Date = new Date()): boolean {
  const { weekday, hhmm } = localTime(timezone, at);
  return (hours[weekday] ?? []).some(([start, end]) => start <= hhmm && hhmm < end);
}
