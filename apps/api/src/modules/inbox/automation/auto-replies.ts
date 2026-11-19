// Which automatic message a customer message gets (T080, FR-035, FR-036, research R10). Pure.
// The "exactly once" guards (welcome per opening, off-hours per contact per 12 h) are applied by
// the service with database and Redis conditions, so concurrent webhooks cannot send twice.

export interface AutoReplyFacts {
  welcomeEnabled: boolean;
  offHoursEnabled: boolean;
  withinHours: boolean;
  /** The message starts a new opening (first message, or the first after 24 hours). */
  newOpening: boolean;
  /** Opt-out, opt-in or "talk to a person" keyword. */
  keyword: boolean;
  blocked: boolean;
  optedOut: boolean;
}

export type AutoReplyKind = 'welcome' | 'off_hours';

export function decideAutoReply(f: AutoReplyFacts): AutoReplyKind | null {
  // Opt-out holds on every automated send path (constitution Principle I).
  if (f.keyword || f.blocked || f.optedOut) return null;
  if (!f.withinHours) return f.offHoursEnabled ? 'off_hours' : null;
  return f.welcomeEnabled && f.newOpening ? 'welcome' : null;
}
