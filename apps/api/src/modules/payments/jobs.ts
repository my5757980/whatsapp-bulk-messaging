// Job names and timings of the `payments` queue (feature 008, research R3, R4, R6).

/** One stored Stripe notification to apply. */
export const PAYMENT_EVENT_JOB = 'payment-event';
export interface PaymentEventJobData {
  eventRowId: string;
}

/** Expiry and reminders from due times in Postgres (R6). */
export const PAYMENTS_TICK_JOB = 'payments-tick';
export const PAYMENTS_TICK_EVERY_MS = 60_000;

/** Stripe events the webhook missed, read from /v1/events (R3). */
export const PAYMENTS_RECONCILE_JOB = 'payments-reconcile';
export const PAYMENTS_RECONCILE_EVERY_MS = 15 * 60_000;
/** Each read goes back this far before the cursor, so events created during the last read are not missed. */
export const PAYMENTS_RECONCILE_OVERLAP_SECONDS = 600;

/** The notification check fails when its event has not arrived by then (R4). */
export const NOTIFICATION_CHECK_TIMEOUT_JOB = 'notification-check-timeout';
export const NOTIFICATION_CHECK_TIMEOUT_MS = 120_000;
export interface NotificationCheckTimeoutData {
  sessionId: string;
}
