// The 24-hour customer service window (FR-006, research R5). It is derived from the customer's
// last message and never stored, so it cannot drift: "live" until the 24-hour mark, History after.

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** When free-form replies stop being allowed; null when the customer never wrote. */
export function windowEndsAt(lastCustomerMessageAt: Date | null): Date | null {
  return lastCustomerMessageAt ? new Date(lastCustomerMessageAt.getTime() + WINDOW_MS) : null;
}

/** True while free-form replies are allowed. */
export function isLive(lastCustomerMessageAt: Date | null, now: Date = new Date()): boolean {
  const end = windowEndsAt(lastCustomerMessageAt);
  return end !== null && now.getTime() < end.getTime();
}

/** Shown under Past chats: the customer never wrote, or their last message is 24 hours old or more. */
export function inHistory(lastCustomerMessageAt: Date | null, now: Date = new Date()): boolean {
  return !isLive(lastCustomerMessageAt, now);
}

/** A customer message starts a new opening when it arrives with no open window (data-model §1). */
export function startsOpening(previousLastCustomerMessageAt: Date | null, messageAt: Date): boolean {
  return !isLive(previousLastCustomerMessageAt, messageAt);
}

/** The newer of two timestamps; webhooks can arrive out of order. */
export function latest(current: Date | null, candidate: Date): Date {
  return current && current.getTime() >= candidate.getTime() ? current : candidate;
}
