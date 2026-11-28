// BullMQ queue names (research R6). BullMQ forbids ":" in queue names, so the per-number send
// queue documented as `send:{numberId}` is named `send-<numberId>`.
export const QUEUES = {
  DISPATCH: 'campaign-dispatch',
  WEBHOOKS: 'webhooks',
  IMPORTS: 'imports',
  MAINTENANCE: 'maintenance',
  /** Live chat background work: inbound media downloads and read receipts (feature 002). */
  INBOX: 'inbox',
  /** Chatbot flows: delay and question timers, API steps, session expiry (feature 003). */
  FLOWS: 'flows',
  /** AI agent: debounced customer turns, AI conversation expiry and team assistant requests (feature 004). */
  AI: 'ai',
  /** AI agent knowledge: reading files and websites, one job at a time (feature 004, research R11). */
  AI_KNOWLEDGE: 'ai-knowledge',
  /** Drip campaigns: the 30-second tick that enrols from starting events and sends due steps (feature 005, research R7). */
  DRIPS: 'drips',
  /**
   * Outbound webhooks: one job per delivery with its retry waits, plus the sweep that re-adds lost
   * jobs (feature 006, research R2; a queue of its own so long retries never wait behind housekeeping).
   */
  WEBHOOKS_OUT: 'webhooks-out',
  /**
   * Stores: saved store events, the 15-minute reconciler, token refresh, the 30-second store tick for
   * COD and cart reminders, and store updates (feature 006, research R7–R11).
   */
  STORES: 'stores',
  /**
   * Ads: status every 5 minutes, hourly insights and the spending cap, daily audience diffs, leads and
   * the lead catch-up (feature 007, plan Technical Context).
   */
  ADS: 'ads',
  /**
   * Payments: Stripe notifications, the 60-second tick for expiry and reminders, the 15-minute
   * reconciler and the notification check timeout (feature 008, research R3, R4, R6).
   */
  PAYMENTS: 'payments',
  /** Catalog: the hourly product copy and the store fill (feature 008, research R8, R9). */
  CATALOG: 'catalog',
  /**
   * Bulk contact work: tag actions and segment drip enrolments, one at a time and in order (feature 010,
   * research R3).
   */
  BULK: 'bulk',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function sendQueueName(numberId: string): string {
  return `send-${numberId}`;
}
