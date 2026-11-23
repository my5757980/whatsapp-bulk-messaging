// Retry plans for failed campaign messages (feature 005, FR-013, research R5). Pure.

/** Delays a round may wait after the previous attempt: 30 minutes, 1, 2, 4, 8 or 12 hours. */
export const RETRY_DELAY_CHOICES = [30, 60, 120, 240, 480, 720] as const;
export const MAX_RETRY_ROUNDS = 3;
/** The last round must start within 24 hours of the campaign's start. */
export const RETRY_WINDOW_MINUTES = 24 * 60;

export interface RetryPlan {
  rounds: number;
  delaysMinutes: readonly number[];
}

export type RetryPlanProblem = 'ROUNDS_OUT_OF_RANGE' | 'DELAYS_DO_NOT_MATCH_ROUNDS' | 'DELAY_NOT_ALLOWED' | 'RETRY_WINDOW_EXCEEDED';

export function retryPlanProblem(plan: RetryPlan): RetryPlanProblem | null {
  if (!Number.isInteger(plan.rounds) || plan.rounds < 0 || plan.rounds > MAX_RETRY_ROUNDS) return 'ROUNDS_OUT_OF_RANGE';
  if (plan.delaysMinutes.length !== plan.rounds) return 'DELAYS_DO_NOT_MATCH_ROUNDS';
  if (plan.delaysMinutes.some((delay) => !(RETRY_DELAY_CHOICES as readonly number[]).includes(delay))) return 'DELAY_NOT_ALLOWED';
  const total = plan.delaysMinutes.reduce((sum, delay) => sum + delay, 0);
  return total > RETRY_WINDOW_MINUTES ? 'RETRY_WINDOW_EXCEEDED' : null;
}

/** A round falls due its delay after the previous attempt (the first pass or the previous round) finished. */
export function retryRoundDueAt(previousFinishedAt: Date, delayMinutes: number): Date {
  return new Date(previousFinishedAt.getTime() + delayMinutes * 60_000);
}

export function retryWindowEndsAt(launchedAt: Date): Date {
  return new Date(launchedAt.getTime() + RETRY_WINDOW_MINUTES * 60_000);
}

/** Rounds may start until 24 hours after the campaign started; later rounds are skipped. */
export function isWithinRetryWindow(launchedAt: Date, at: Date): boolean {
  return at.getTime() <= retryWindowEndsAt(launchedAt).getTime();
}
