import { canTransition, type ExpiredReason, type MessageStatus } from '@wbm/shared';
import { describeMetaError } from '../../meta/meta-error-classifier.js';

// Status webhook rules (contracts/meta-webhooks.md §3, research R10, FR-025). Pure (T077).

export type MetaStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';

export interface StatusEvent {
  status: MetaStatus;
  timestamp: Date;
  error?: { code: number | undefined; message: string | undefined };
  pricing?: { billable: boolean | undefined; category: string | undefined };
}

export interface ParsedStatus extends StatusEvent {
  wamid: string;
  recipientId: string | undefined;
}

export interface MessageSnapshot {
  status: MessageStatus;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  /** Feature 009: why an EXPIRED message expired; only "not delivered in time" can still change. */
  expiredReason?: ExpiredReason | null;
}

export interface StatusUpdate {
  status?: MessageStatus;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  failureCode?: number | null;
  failureReason?: string;
  billable?: boolean;
  pricingCategory?: string;
  /** Cleared when a late webhook replaces "not delivered in time" (feature 009). */
  expiredReason?: null;
}

const DELIVERY: Record<'sent' | 'delivered' | 'read', { status: MessageStatus; field: 'sentAt' | 'deliveredAt' | 'readAt' }> = {
  sent: { status: 'SENT', field: 'sentAt' },
  delivered: { status: 'DELIVERED', field: 'deliveredAt' },
  read: { status: 'READ', field: 'readAt' },
};

/**
 * Returns the fields to write for one status event, or null when nothing changes:
 * statuses never move backwards, timestamps fill independently (out-of-order events still give
 * a full timeline), FAILED only applies below DELIVERED, and `deleted` is recorded as an event only.
 */
export function computeStatusUpdate(current: MessageSnapshot, event: StatusEvent): StatusUpdate | null {
  let update: StatusUpdate | null = null;
  // Feature 009 (research R8): a late webhook still wins over the sweep's "not delivered in time".
  const opts = { expiredReason: current.expiredReason ?? null };
  const leaving = current.status === 'EXPIRED' ? { expiredReason: null } : {};

  if (event.status === 'failed') {
    if (!canTransition(current.status, 'FAILED', opts)) return null;
    update = {
      ...leaving,
      status: 'FAILED',
      failedAt: event.timestamp,
      failureCode: event.error?.code ?? null,
      failureReason: describeMetaError(event.error?.code, event.error?.message),
    };
  } else if (event.status !== 'deleted') {
    const { status, field } = DELIVERY[event.status];
    if (canTransition(current.status, status, opts)) {
      update = { ...leaving, status, ...(current[field] ? {} : { [field]: event.timestamp }) };
    } else if (!current[field] && current.status !== 'FAILED') {
      update = { [field]: event.timestamp };
    }
  }

  if (update && event.pricing) {
    if (event.pricing.billable !== undefined) update.billable = event.pricing.billable;
    if (event.pricing.category !== undefined) update.pricingCategory = event.pricing.category;
  }
  return update;
}

const KNOWN: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'failed', 'deleted']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Reads `value.statuses[]` of a `messages` webhook change; malformed items are dropped. */
export function parseStatuses(value: Record<string, unknown>): ParsedStatus[] {
  const items = Array.isArray(value.statuses) ? (value.statuses as Array<Record<string, unknown>>) : [];
  const out: ParsedStatus[] = [];
  for (const item of items) {
    const wamid = str(item.id);
    const status = str(item.status);
    const seconds = Number(item.timestamp);
    if (!wamid || !status || !KNOWN.has(status) || !Number.isFinite(seconds)) continue;

    const parsed: ParsedStatus = {
      wamid,
      status: status as MetaStatus,
      timestamp: new Date(seconds * 1000),
      recipientId: str(item.recipient_id),
    };
    const firstError = Array.isArray(item.errors) ? (item.errors[0] as Record<string, unknown> | undefined) : undefined;
    if (firstError) {
      parsed.error = {
        code: typeof firstError.code === 'number' ? firstError.code : undefined,
        message: str(firstError.message) ?? str(firstError.title),
      };
    }
    const pricing = item.pricing as Record<string, unknown> | undefined;
    if (pricing && typeof pricing === 'object') {
      parsed.pricing = {
        billable: typeof pricing.billable === 'boolean' ? pricing.billable : undefined,
        category: str(pricing.category),
      };
    }
    out.push(parsed);
  }
  return out;
}
