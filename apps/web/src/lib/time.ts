// Timezone helpers for scheduling without extra libraries (Intl only).

/** Offset of `timeZone` from UTC at `date`, in milliseconds (zone time minus UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time ("YYYY-MM-DDTHH:mm") in `timeZone` to an absolute Date. */
export function zonedTimeToUtc(local: string, timeZone: string): Date {
  const [datePart = '', timePart = '00:00'] = local.split('T');
  const [y = 0, m = 1, d = 1] = datePart.split('-').map(Number);
  const [hh = 0, mm = 0] = timePart.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-check once so times next to a daylight-saving change land correctly.
  const second = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** "YYYY-MM-DDTHH:mm" for <input type="datetime-local"> showing `date` in `timeZone`. */
export function toZonedInputValue(date: Date, timeZone: string): string {
  const shifted = new Date(date.getTime() + zoneOffsetMs(date, timeZone));
  return shifted.toISOString().slice(0, 16);
}

export function formatInZone(value: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
