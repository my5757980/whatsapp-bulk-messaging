import { AMBIGUOUS_FAILURE_REASON, classifyMetaError, describeMetaError } from '../meta/meta-error-classifier.js';
import { MetaApiError, MetaNetworkError } from '../meta/meta-graph.client.js';

// Send-worker decisions (research R7/R9/R11, T100). Pure so the rules are unit-tested (T076).

/** One first try + 3 retries (backoff 30 s, 2 min, 8 min). */
export const MAX_SEND_ATTEMPTS = 4;

export function backoffDelay(attemptsMade: number): number {
  return 30_000 * 4 ** (Math.max(1, attemptsMade) - 1);
}

export interface PreSendState {
  messageStatus: 'PENDING' | 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  /** Null for API-origin messages (no campaign checks). */
  campaignState: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | null;
  sendingEnabled: boolean;
  consent: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
  /** MARKETING templates need an explicit opt-in. */
  marketing: boolean;
  /** Feature 010 (US4): a utility keyword reply confirms an opt-out, so it goes to the person who opted out. */
  consentReply?: boolean;
}

export type PreSendDecision =
  | { action: 'send' }
  | { action: 'ignore' }
  | { action: 'requeue'; pauseReason?: 'sending_disabled' }
  | { action: 'cancel' }
  | { action: 'skip'; reason: 'OPTED_OUT' | 'NO_OPT_IN' };

export function preSendCheck(s: PreSendState): PreSendDecision {
  if (s.messageStatus !== 'QUEUED') return { action: 'ignore' };
  if (s.campaignState === 'CANCELLED') return { action: 'cancel' };
  if (s.campaignState !== null && s.campaignState !== 'RUNNING') return { action: 'requeue' };
  if (!s.sendingEnabled) return { action: 'requeue', pauseReason: 'sending_disabled' };
  if (s.consent === 'OPTED_OUT' && !s.consentReply) return { action: 'skip', reason: 'OPTED_OUT' };
  if (s.marketing && s.consent !== 'OPTED_IN') return { action: 'skip', reason: 'NO_OPT_IN' };
  return { action: 'send' };
}

export type SendFailureDecision =
  | { action: 'retry'; code: number | null; reason: string }
  | { action: 'fail'; code: number | null; reason: string }
  | { action: 'block'; code: number | null; reason: string; pauseReason: string };

/**
 * Maps a send error to the retry policy. `attempt` is 1-based (the attempt that just failed).
 * Ambiguous network outcomes are never retried, so a customer never gets a duplicate (SC-004).
 */
export function decideSendFailure(error: unknown, attempt: number): SendFailureDecision {
  if (error instanceof MetaNetworkError) {
    if (error.phase === 'ambiguous') return { action: 'fail', code: null, reason: AMBIGUOUS_FAILURE_REASON };
    const reason = 'Could not reach Meta before sending';
    return attempt < MAX_SEND_ATTEMPTS ? { action: 'retry', code: null, reason } : { action: 'fail', code: null, reason };
  }
  if (error instanceof MetaApiError) {
    const code = error.code ?? null;
    const reason = describeMetaError(error.code, error.message);
    switch (classifyMetaError(error.code, error.httpStatus)) {
      case 'TRANSIENT':
        return attempt < MAX_SEND_ATTEMPTS ? { action: 'retry', code, reason } : { action: 'fail', code, reason };
      case 'BLOCKING':
        return { action: 'block', code, reason, pauseReason: `meta_error_${code ?? error.httpStatus}` };
      case 'PERMANENT':
        return { action: 'fail', code, reason };
    }
  }
  return { action: 'fail', code: null, reason: error instanceof Error ? error.message.slice(0, 300) : 'Unexpected send error' };
}
