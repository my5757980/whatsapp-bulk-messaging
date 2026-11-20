// Jobs on the `flows` queue (003 research R10): names and data shared by the session service, which
// queues them, and the processors, which run them.

/** A question, list or buttons timeout (and, with US4, a delay step) for one wait of a session. */
export const FLOW_TIMER_JOB = 'flow-timer';
export interface FlowTimerData {
  sessionId: string;
  /** The wait token when the timer was set; a newer wait makes the timer stale. */
  token: number;
}

/** Every 5 minutes: sessions idle for 24 hours end as EXPIRED (FR-032). */
export const FLOW_EXPIRY_JOB = 'flow-expiry';

/** BullMQ job ids may not contain ":", so ids use "-". */
export const flowTimerJobId = (data: FlowTimerData): string => `flow-timer-${data.sessionId}-${data.token}`;

/** YYYY-MM-DD of `now` in a time zone (company "today" for date answers); UTC when the zone is unknown. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
