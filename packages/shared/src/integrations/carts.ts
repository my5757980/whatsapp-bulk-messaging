// Abandoned cart rules (feature 006 US6, FR-039 - FR-044, research R11): up to three reminders with
// increasing waits, when each is due, what stops a cart, the 7-day recovery window and expiry.

export const CART_MAX_STEPS = 3;
export const CART_MIN_WAIT_MINUTES = 30;
export const CART_MAX_WAIT_MINUTES = 7 * 24 * 60;
/** An order within this time after the last reminder counts as recovered (FR-043). */
export const CART_RECOVERY_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Carts older than this are no longer reminded (FR-044). */
export const CART_EXPIRY_MS = 7 * 24 * 3600 * 1000;

export type CartStopReason = 'ordered' | 'opted_out' | 'blocked' | 'replied' | 'no_consent' | 'no_phone' | 'store_disconnected' | 'deleted';
export type CartEvent = { kind: 'ORDERED'; at: Date } | { kind: 'OPTED_OUT' } | { kind: 'BLOCKED' } | { kind: 'REPLIED' } | { kind: 'STORE_DISCONNECTED' } | { kind: 'DELETED' };

export function cartStepProblems(steps: ReadonlyArray<{ waitMinutes?: number | undefined }>): string[] {
  const problems: string[] = [];
  if (steps.length < 1 || steps.length > CART_MAX_STEPS) problems.push(`Use 1 to ${CART_MAX_STEPS} reminders`);
  steps.forEach((step, i) => {
    const wait = step.waitMinutes;
    if (wait === undefined || !Number.isInteger(wait) || wait < CART_MIN_WAIT_MINUTES || wait > CART_MAX_WAIT_MINUTES) {
      problems.push(`Reminder ${i + 1}: wait between 30 minutes and 7 days`);
    } else if (i > 0 && wait <= (steps[i - 1]?.waitMinutes ?? 0)) {
      problems.push(`Reminder ${i + 1} must come later than reminder ${i}`);
    }
  });
  return problems;
}

/** When reminder `step` (1-based) is due, counted from when the cart started; null after the last one. */
export function cartDueAt(startedAt: Date, step: number, steps: ReadonlyArray<{ waitMinutes?: number | undefined }>): Date | null {
  const wait = steps[step - 1]?.waitMinutes;
  return wait === undefined ? null : new Date(startedAt.getTime() + wait * 60_000);
}

export function cartExpired(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() > CART_EXPIRY_MS;
}

/**
 * What an event does to an open or reminding cart: an order after a reminder (within 7 days) is a
 * recovery; an order before any reminder closes the cart without counting it; opt-outs, blocks,
 * replies and deletions stop it.
 */
export function cartAfterEvent(cart: { lastReminderAt: Date | null }, event: CartEvent): { status: 'RECOVERED' | 'STOPPED'; reason: CartStopReason } {
  switch (event.kind) {
    case 'ORDERED':
      return cart.lastReminderAt && event.at.getTime() - cart.lastReminderAt.getTime() <= CART_RECOVERY_WINDOW_MS && event.at >= cart.lastReminderAt
        ? { status: 'RECOVERED', reason: 'ordered' }
        : { status: 'STOPPED', reason: 'ordered' };
    case 'OPTED_OUT':
      return { status: 'STOPPED', reason: 'opted_out' };
    case 'BLOCKED':
      return { status: 'STOPPED', reason: 'blocked' };
    case 'REPLIED':
      return { status: 'STOPPED', reason: 'replied' };
    case 'STORE_DISCONNECTED':
      return { status: 'STOPPED', reason: 'store_disconnected' };
    case 'DELETED':
      return { status: 'STOPPED', reason: 'deleted' };
  }
}
