// Message status precedence rules (data-model.md §5, FR-025).
import { ExpiredReason, MessageStatus } from './enums.js';

const RANK: Readonly<Record<MessageStatus, number>> = {
  [MessageStatus.PENDING]: 0,
  [MessageStatus.QUEUED]: 1,
  [MessageStatus.SENDING]: 2,
  [MessageStatus.SENT]: 3,
  [MessageStatus.DELIVERED]: 4,
  [MessageStatus.READ]: 5,
  // Terminal outcomes outside the delivery path.
  [MessageStatus.FAILED]: -1,
  [MessageStatus.SKIPPED]: -1,
  [MessageStatus.CANCELLED]: -1,
  [MessageStatus.EXPIRED]: -1,
};

const DELIVERY_PATH = new Set<MessageStatus>([
  MessageStatus.PENDING,
  MessageStatus.QUEUED,
  MessageStatus.SENDING,
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
  MessageStatus.READ,
]);

/** Rank on the delivery path; -1 for FAILED, SKIPPED and CANCELLED. */
export function statusRank(status: MessageStatus): number {
  return RANK[status];
}

/**
 * Whether a message may move from `current` to `next`.
 * - Delivery statuses only move forward (out-of-order updates never downgrade).
 * - FAILED applies only while below DELIVERED.
 * - SKIPPED and CANCELLED are platform decisions from PENDING or QUEUED.
 * - The pause path moves QUEUED back to PENDING.
 */
export function canTransition(current: MessageStatus, next: MessageStatus, opts: { expiredReason?: ExpiredReason | null } = {}): boolean {
  if (current === next) return false;
  // Feature 009 (research R8): a late Meta webhook replaces the sweep's "not delivered in time";
  // messages dropped before sending or after an offer ended never change.
  if (current === MessageStatus.EXPIRED) {
    return opts.expiredReason === ExpiredReason.NOT_DELIVERED_IN_TIME && (next === MessageStatus.DELIVERED || next === MessageStatus.READ || next === MessageStatus.FAILED);
  }
  if (!DELIVERY_PATH.has(current)) return false; // FAILED / SKIPPED / CANCELLED are final

  switch (next) {
    case MessageStatus.EXPIRED:
      // Dropped at send time (from the queue) or by the sweep (sent, never delivered).
      return RANK[current] <= RANK[MessageStatus.SENT];
    case MessageStatus.FAILED:
      return RANK[current] < RANK[MessageStatus.DELIVERED];
    case MessageStatus.SKIPPED:
    case MessageStatus.CANCELLED:
      return current === MessageStatus.PENDING || current === MessageStatus.QUEUED;
    case MessageStatus.PENDING:
      return current === MessageStatus.QUEUED;
    default:
      return RANK[next] > RANK[current];
  }
}

/** True once no more sending work is needed for the message. */
export function isFinalForSending(status: MessageStatus): boolean {
  return (
    status !== MessageStatus.PENDING &&
    status !== MessageStatus.QUEUED &&
    status !== MessageStatus.SENDING
  );
}

const LABELS: Readonly<Record<MessageStatus, string>> = {
  [MessageStatus.PENDING]: 'Queued',
  [MessageStatus.QUEUED]: 'Queued',
  [MessageStatus.SENDING]: 'Queued',
  [MessageStatus.SENT]: 'Sent',
  [MessageStatus.DELIVERED]: 'Delivered',
  [MessageStatus.READ]: 'Read',
  [MessageStatus.FAILED]: 'Failed',
  [MessageStatus.SKIPPED]: 'Skipped',
  [MessageStatus.CANCELLED]: 'Cancelled',
  [MessageStatus.EXPIRED]: 'Expired',
};

/** User-facing label; internal PENDING/SENDING show as "Queued" (spec FR-025 vocabulary). */
export function displayStatus(status: MessageStatus): string {
  return LABELS[status];
}
