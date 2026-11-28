import { DATE_AUTOMATION_MAX_OFFSET, type DateAutomationTiming } from '@wbm/shared';
import { Prisma } from '../../generated/prisma/client.js';

// Feature 010 (US5, research R9): which contacts are due for a date automation on a company day. The stored
// attribute is an ISO date (YYYY-MM-DD, checked by the 001 attribute validator). The conditions are the
// inverse of the shared `dueOn` rule, so they compare strings and never cast stored values.

const DAY_MS = 86_400_000;
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The calendar day and the HH:mm time of an instant in the company time zone. */
export function companyClock(now: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** A calendar day moved by whole days. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A calendar day as the Date Prisma uses for `@db.Date` columns (UTC midnight). */
export const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** The calendar day of a `@db.Date` value. */
export const dayOf = (date: Date) => date.toISOString().slice(0, 10);

export type DueTarget = { timing: 'ONCE'; date: string } | { timing: 'YEARLY'; monthDays: string[] };

/**
 * What a stored date must be for its contact to be due `today`:
 * - ONCE: exactly today minus the offset.
 * - YEARLY: the month and day of today minus the offset; 29 February also counts on 28 February of a year
 *   without it. A negative offset is before the date ("3 days before" is -3).
 */
export function dueTarget(timing: DateAutomationTiming, offsetDays: number, today: string): DueTarget {
  if (!Number.isInteger(offsetDays) || Math.abs(offsetDays) > DATE_AUTOMATION_MAX_OFFSET) throw new Error(`offset out of range: ${offsetDays}`);
  const target = addDays(today, -offsetDays);
  if (timing === 'ONCE') return { timing, date: target };
  const monthDay = target.slice(5);
  return { timing, monthDays: monthDay === '02-28' && !isLeap(Number(target.slice(0, 4))) ? ['02-28', '02-29'] : [monthDay] };
}

/** SQL condition on contacts (alias `c`): the attribute holds a date that is due `today`. */
export function dueCondition(attributeKey: string, timing: DateAutomationTiming, offsetDays: number, today: string): Prisma.Sql {
  const value = Prisma.sql`(c.attributes ->> ${attributeKey})`;
  const target = dueTarget(timing, offsetDays, today);
  if (target.timing === 'ONCE') return Prisma.sql`${value} = ${target.date}`;
  return Prisma.sql`(${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND substr(${value}, 6, 5) IN (${Prisma.join(target.monthDays)}))`;
}
