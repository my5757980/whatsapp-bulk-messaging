import { QUEUES } from '../../common/queue/queue.constants.js';
import type { QueuedJob } from '../sending/send-jobs.js';

// Jobs on the `inbox` queue (feature 002): inbound media downloads (research R4) and read
// receipts (R11). Free-form replies use the number's send queue instead (R3).

export const INBOX_QUEUE = QUEUES.INBOX;

/** Media downloads stop after this many tries; the item then shows "media unavailable". */
export const INBOUND_MEDIA_ATTEMPTS = 3;

export interface InboundMediaJobData {
  chatMessageId: string;
  metaMediaId: string;
}

export interface ReadReceiptJobData {
  conversationId: string;
}

export function inboundMediaJob(data: InboundMediaJobData): QueuedJob<InboundMediaJobData> {
  return {
    name: 'media',
    data,
    opts: {
      jobId: `media-${data.chatMessageId}`,
      attempts: INBOUND_MEDIA_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  };
}

/** Best effort and never retried: a missed read receipt only affects the customer's ticks. */
export function readReceiptJob(conversationId: string): QueuedJob<ReadReceiptJobData> {
  return {
    name: 'mark-read',
    data: { conversationId },
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  };
}
