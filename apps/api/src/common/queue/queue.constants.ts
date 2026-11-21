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
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function sendQueueName(numberId: string): string {
  return `send-${numberId}`;
}
