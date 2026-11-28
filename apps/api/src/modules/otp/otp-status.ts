import type { Message } from '../../generated/prisma/client.js';

// The public status of a one-time code message (feature 009, contracts/public-otp-v1.openapi.yaml
// `OtpStatus`). Kept apart from the service so outbound events can use it without an import cycle.

const STATUS: Record<string, string> = {
  PENDING: 'queued',
  QUEUED: 'queued',
  SENDING: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  SKIPPED: 'failed',
  CANCELLED: 'failed',
  EXPIRED: 'expired',
};

export function otpStatusDto(m: Pick<Message, 'id' | 'phoneE164' | 'status' | 'failureCode' | 'failureReason' | 'expiredReason' | 'queuedAt' | 'createdAt' | 'sentAt' | 'deliveredAt' | 'readAt'>) {
  return {
    id: m.id,
    to: m.phoneE164 ?? '',
    status: STATUS[m.status] ?? 'queued',
    failureCode: m.failureCode,
    failureReason: m.failureReason,
    expiredReason: m.expiredReason === 'OFFER_ENDED' ? null : m.expiredReason,
    queuedAt: (m.queuedAt ?? m.createdAt).toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
  };
}
