import { QUEUES } from '../../common/queue/queue.constants.js';
import type { QueuedJob } from '../sending/send-jobs.js';

// Jobs on the `inbox` queue (feature 002): inbound media downloads (research R4), read receipts
// (R11) and push alerts (R9). Free-form replies use the number's send queue instead (R3).

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

/** Push alert triggers (FR-037). The worker works out the recipients and texts. */
export type InboxNotifyJobData =
  | { kind: 'message'; conversationId: string; itemId: string }
  | { kind: 'requesting'; conversationId: string; userIds: string[] }
  | { kind: 'transferred'; conversationId: string; userIds: string[]; byName: string }
  | { kind: 'mention'; conversationId: string; userIds: string[]; byName: string };

/** Never retried: a late alert is useless and a retry could alert a device twice. */
export function inboxNotifyJob(data: InboxNotifyJobData): QueuedJob<InboxNotifyJobData> {
  return { name: 'notify', data, opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } };
}

/** Best effort and never retried: a missed read receipt only affects the customer's ticks. */
export function readReceiptJob(conversationId: string): QueuedJob<ReadReceiptJobData> {
  return {
    name: 'mark-read',
    data: { conversationId },
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  };
}
