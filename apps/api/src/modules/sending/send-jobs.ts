import type { JobsOptions } from 'bullmq';
import { sendJobId } from './dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from './send-outcome.js';

// Jobs on a number's send queue (`send-{numberId}`) and their priorities (002 research R3).
// BullMQ runs jobs without a priority first, then prioritized jobs, lowest number first. One queue
// per number keeps a single rate limiter, so replies jump ahead of broadcasts without ever
// exceeding the number's rate (constitution Principle IV).

export const SEND_PRIORITY = {
  /** Live chat replies and templates sent from a chat. */
  CHAT: 1,
  /** Campaign messages. */
  CAMPAIGN: 10,
} as const;

/** Failed send jobs are kept a week for inspection, then removed. */
export const FAILED_SEND_JOB_RETENTION_SECONDS = 7 * 24 * 3600;

export interface SendJobData {
  messageId: string;
}

export interface SessionJobData {
  chatMessageId: string;
}

export interface QueuedJob<T> {
  name: string;
  data: T;
  opts: JobsOptions;
}

const retrying = (jobId: string, priority?: number): JobsOptions => ({
  jobId,
  attempts: MAX_SEND_ATTEMPTS,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: { age: FAILED_SEND_JOB_RETENTION_SECONDS },
  ...(priority === undefined ? {} : { priority }),
});

/** A campaign message (dispatcher). */
export function campaignSendJob(messageId: string): QueuedJob<SendJobData> {
  return { name: 'send', data: { messageId }, opts: retrying(sendJobId(messageId), SEND_PRIORITY.CAMPAIGN) };
}

/** A template sent from a chat (`messages` origin INBOX), processed by the 001 send processor. */
export function chatTemplateSendJob(messageId: string): QueuedJob<SendJobData> {
  return { name: 'send', data: { messageId }, opts: retrying(sendJobId(messageId), SEND_PRIORITY.CHAT) };
}

/** A free-form live chat reply (`chat_messages` SESSION_OUT), processed by the session processor. */
export function sessionSendJob(chatMessageId: string): QueuedJob<SessionJobData> {
  return { name: 'session', data: { chatMessageId }, opts: retrying(`session-${chatMessageId}`, SEND_PRIORITY.CHAT) };
}
