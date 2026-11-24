// Webhook delivery retries and the endpoint auto-pause rule (feature 006, research R2).

/** Waits after each failed attempt: 10 s, 1 min, 5 min, 30 min, 1 h, 2 h, 4 h, 8 h, 8 h (about 23 h 36 min). */
export const DELIVERY_RETRY_WAITS_SECONDS = [10, 60, 300, 1800, 3600, 7200, 14400, 28800, 28800] as const;
/** The first attempt plus one per wait. */
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_WAITS_SECONDS.length + 1;
/** An endpoint with no success for this long, and at least AUTO_PAUSE_MIN_FAILURES failed attempts, is paused. */
export const AUTO_PAUSE_AFTER_MS = 24 * 3600 * 1000;
export const AUTO_PAUSE_MIN_FAILURES = 10;
/** Deliveries per endpoint in flight at once, so one slow endpoint cannot hold the others (FR-008). */
export const MAX_IN_FLIGHT_PER_ENDPOINT = 5;
/** An endpoint must answer within this time. */
export const DELIVERY_TIMEOUT_MS = 10_000;

export function isLastAttempt(attemptsMade: number): boolean {
  return attemptsMade >= MAX_DELIVERY_ATTEMPTS;
}

/** When to try again after `attemptsMade` attempts (1-based) failed, or null after the last one. */
export function nextAttemptAt(attemptsMade: number, now: Date): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) throw new Error('attemptsMade must be 1 or more');
  if (isLastAttempt(attemptsMade)) return null;
  const wait = DELIVERY_RETRY_WAITS_SECONDS[attemptsMade - 1]!;
  return new Date(now.getTime() + wait * 1000);
}

export interface AutoPauseInput {
  /** The first failure since the last success; null when the last attempt succeeded. */
  failingSince: Date | null;
  consecutiveFailures: number;
  now: Date;
}

export function shouldAutoPause(input: AutoPauseInput): boolean {
  if (!input.failingSince) return false;
  return input.now.getTime() - input.failingSince.getTime() >= AUTO_PAUSE_AFTER_MS && input.consecutiveFailures >= AUTO_PAUSE_MIN_FAILURES;
}
