import { displayStatus, type CampaignState, type MessageStatus, type TemplateStatus } from '@wbm/shared';
import type { BadgeProps } from '@/components/ui/badge';
import type { StatusTotals } from './types';

type Variant = NonNullable<BadgeProps['variant']>;

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export const campaignStateVariant: Record<CampaignState, Variant> = {
  DRAFT: 'outline',
  SCHEDULED: 'secondary',
  RUNNING: 'default',
  PAUSED: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'secondary',
};

export const templateStatusVariant: Record<TemplateStatus, Variant> = {
  DRAFT: 'outline',
  PENDING: 'secondary',
  APPROVED: 'success',
  REJECTED: 'destructive',
  PAUSED: 'warning',
  DISABLED: 'destructive',
  DELETED: 'outline',
};

const MESSAGE_VARIANT: Record<MessageStatus, Variant> = {
  PENDING: 'outline',
  QUEUED: 'outline',
  SENDING: 'outline',
  SENT: 'secondary',
  DELIVERED: 'default',
  READ: 'success',
  FAILED: 'destructive',
  SKIPPED: 'warning',
  CANCELLED: 'secondary',
  EXPIRED: 'warning',
};

export function messageStatusBadge(status: MessageStatus): { label: string; variant: Variant } {
  return { label: displayStatus(status), variant: MESSAGE_VARIANT[status] };
}

export function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** Why a campaign recipient was skipped; feature 009 reasons get their own words. */
const SKIP_WORDS: Record<string, string> = { OFFER_CODE_MISSING: 'Missing offer code', MEDIA_URL_MISSING: 'Missing media address' };
export function skipReasonLabel(reason: string): string {
  return SKIP_WORDS[reason] ?? titleCase(reason);
}

/** Why a message expired (feature 009, research R7, R8). */
const EXPIRED_WORDS: Record<string, string> = { EXPIRED_BEFORE_SENDING: 'Not sent in time', NOT_DELIVERED_IN_TIME: 'Not delivered in time', OFFER_ENDED: 'Offer ended' };
export function expiredReasonLabel(reason: string): string {
  return EXPIRED_WORDS[reason] ?? titleCase(reason);
}

export function totalRecipients(t: StatusTotals): number {
  return t.pending + t.queued + t.sent + t.delivered + t.read + t.failed + t.skipped + t.cancelled;
}

/** Share of recipients with a final sending outcome (everything except pending/queued). */
export function progressPercent(t: StatusTotals): number {
  const total = totalRecipients(t);
  return total ? Math.round(((total - t.pending - t.queued) / total) * 100) : 0;
}

export const consentLabel: Record<'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN', { label: string; variant: Variant }> = {
  OPTED_IN: { label: 'Opted in', variant: 'success' },
  OPTED_OUT: { label: 'Opted out', variant: 'destructive' },
  UNKNOWN: { label: 'Unknown', variant: 'outline' },
};
