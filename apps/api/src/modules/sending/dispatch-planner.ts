// Dispatcher decisions (research R7, T098). Pure so the rules are unit-tested (T075).

export interface DispatchState {
  state: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  sendingEnabled: boolean;
  connectionStatus: 'CONNECTED' | 'ERROR' | 'DISCONNECTED';
  ratePerSecond: number;
  /** Send jobs already waiting in the number's queue (the buffer). */
  waitingJobs: number;
}

export type DispatchPlan =
  | { action: 'claim'; batchSize: number }
  | { action: 'wait' }
  | { action: 'stop' }
  | { action: 'pause'; reason: 'sending_disabled' | 'number_unavailable' };

/** The queue buffer holds at most ~2 s of messages, so a pause takes effect within seconds. */
export const BUFFER_SECONDS = 2;

export function planDispatch(s: DispatchState): DispatchPlan {
  if (s.state !== 'RUNNING') return { action: 'stop' };
  if (!s.sendingEnabled) return { action: 'pause', reason: 'sending_disabled' };
  if (s.connectionStatus !== 'CONNECTED') return { action: 'pause', reason: 'number_unavailable' };
  const batchSize = Math.max(1, s.ratePerSecond) * BUFFER_SECONDS - s.waitingJobs;
  return batchSize > 0 ? { action: 'claim', batchSize } : { action: 'wait' };
}

/**
 * BullMQ job id for a message's send job. BullMQ forbids ":" in custom ids, so the documented
 * `msg:{id}` is written `msg-{id}`. Send jobs are removed on completion, so a message that
 * returns to PENDING (pause) can be enqueued again under the same id after resume.
 */
export function sendJobId(messageId: string): string {
  return `msg-${messageId}`;
}
