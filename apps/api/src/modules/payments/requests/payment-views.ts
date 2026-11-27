import { formatMinor, paymentDisplay, type PaymentDisplay, type PaymentSource, type PaymentState, type PaymentStatus } from '@wbm/shared';
import type { PaymentRequest, Prisma } from '../../../generated/prisma/client.js';

// Payment request views (feature 008, contracts/commerce-api.openapi.yaml schemas PaymentRequest and
// ChatPaymentSummary, contracts/public-payments-v1.openapi.yaml Payment). Pure.

export const REQUEST_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  contact: { select: { name: true, phoneE164: true } },
} satisfies Prisma.PaymentRequestInclude;
export type RequestRow = Prisma.PaymentRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export function payUrl(linkBase: string, code: string): string {
  return `${linkBase.replace(/\/+$/, '')}/p/${code}`;
}

export function displayOf(row: Pick<PaymentRequest, 'status' | 'failedAttempts' | 'paidLate' | 'refundedMinor'>, deliveryFailed = false): PaymentDisplay {
  return paymentDisplay({ status: row.status as PaymentStatus, failedAttempts: row.failedAttempts, paidLate: row.paidLate, refundedMinor: Number(row.refundedMinor), deliveryFailed });
}

/** The fields Stripe events change, as the shared rules see them. */
export function stateOf(row: PaymentRequest): PaymentState {
  return {
    status: row.status as PaymentStatus,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    expiresAt: row.expiresAt.getTime(),
    paidAt: row.paidAt?.getTime() ?? null,
    paidAmountMinor: row.paidAmountMinor === null ? null : Number(row.paidAmountMinor),
    paidLate: row.paidLate,
    paymentIntentId: row.paymentIntentId,
    failedAttempts: row.failedAttempts,
    lastFailureCode: row.lastFailureCode,
    refundedMinor: Number(row.refundedMinor),
    sessionId: row.sessionId,
  };
}

export function requestDto(row: RequestRow, linkBase: string, deliveryFailed = false) {
  return {
    id: row.id,
    contactId: row.contactId,
    conversationId: row.conversationId,
    contactName: row.contact?.name ?? row.customerName,
    phone: row.contact?.phoneE164 ?? row.phoneE164,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    description: row.description,
    reference: row.reference,
    status: row.status as PaymentStatus,
    display: displayOf(row, deliveryFailed),
    source: row.source as PaymentSource,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    paidLate: row.paidLate,
    failedAttempts: row.failedAttempts,
    lastFailureCode: row.lastFailureCode,
    refundedMinor: Number(row.refundedMinor),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    remindersSent: row.remindersSent,
    opens: row.opens,
    isTest: row.isTest,
    payUrl: payUrl(linkBase, row.code),
    campaignId: row.campaignId,
    chatOrderId: row.chatOrderId,
    storeOrderId: row.storeOrderId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What a chat item shows about the request it carries (kept in the item's payload). */
export function chatSummary(row: PaymentRequest, linkBase: string) {
  return {
    id: row.id,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    description: row.description,
    status: row.status,
    display: displayOf(row),
    expiresAt: row.expiresAt.toISOString(),
    payUrl: payUrl(linkBase, row.code),
  };
}

/** The `payment` object of outbound events (research R14): never keys or card details. */
export function eventPayment(row: PaymentRequest, linkBase: string): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    description: row.description,
    reference: row.reference,
    source: row.source,
    expiresAt: row.expiresAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    paidLate: row.paidLate,
    failedAttempts: row.failedAttempts,
    refundedMinor: Number(row.refundedMinor),
    payUrl: payUrl(linkBase, row.code),
    test: row.isTest,
  };
}

/** Text placeholders of the Pay now message and payment templates: amount, description, reference, expires. */
export function paymentWords(row: Pick<PaymentRequest, 'amountMinor' | 'currency' | 'description' | 'reference' | 'expiresAt' | 'code'>, linkBase: string, timeZone: string) {
  let expires: string;
  try {
    expires = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(row.expiresAt);
  } catch {
    expires = row.expiresAt.toISOString().slice(0, 16).replace('T', ' ');
  }
  return {
    amount: formatMinor(Number(row.amountMinor), row.currency),
    description: row.description,
    reference: row.reference ?? '',
    expires,
    link: payUrl(linkBase, row.code),
    code: row.code,
  };
}

/** Fills {amount}, {description}, {reference} and {expires}; an empty reference drops its line. */
export function fillSessionText(template: string, words: ReturnType<typeof paymentWords>): string {
  return template
    .split('\n')
    .filter((line) => !(line.includes('{reference}') && !words.reference))
    .join('\n')
    .replace(/\{(amount|description|reference|expires)\}/g, (_, key: 'amount' | 'description' | 'reference' | 'expires') => words[key])
    .slice(0, 1024);
}
