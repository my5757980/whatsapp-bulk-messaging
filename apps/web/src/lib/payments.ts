import { formatMinor, type GatewayCheckKey, type GatewayCheckResult, type PaymentDisplay, type PaymentSource, type PaymentStatus } from '@wbm/shared';

// Payments types, query keys and labels (feature 008, T021; contracts/commerce-api.openapi.yaml).
// Money is in minor units of the Stripe connection currency (lower-case ISO code), never converted.

// ---------- Gateway (US1) ----------

export interface GatewayCheck {
  check: GatewayCheckKey;
  result: GatewayCheckResult;
  detail: string;
  fix?: string | null;
}

export interface NotificationCheck {
  status: 'NOT_RUN' | 'PENDING' | 'PASSED' | 'FAILED';
  startedAt?: string | null;
  passedAt?: string | null;
  fix?: string | null;
}

export interface PaymentGateway {
  provider: 'STRIPE';
  mode: 'LIVE' | 'TEST';
  accountId: string | null;
  accountName: string | null;
  country: string | null;
  currency: string;
  keyKind: 'restricted' | 'secret';
  endpointRegistered: boolean;
  status: 'CONNECTED' | 'ERROR';
  checks: GatewayCheck[];
  notificationCheck: NotificationCheck;
  webhookUrl: string;
  lastCheckedAt: string | null;
  lastEventAt: string | null;
}

// ---------- Settings ----------

export interface PaymentReminder {
  beforeMinutes: number;
  templateId: string;
  mapping?: Record<string, unknown>;
}

export interface PaymentSettings {
  maxAmountMinor: number;
  defaultExpiryMinutes: number;
  requestRoles: Array<'ADMIN' | 'MANAGER' | 'AGENT'>;
  sessionText: string;
  buttonText: string;
  templateId: string | null;
  templateName?: string | null;
  templateMapping: Record<string, unknown>;
  reminders: PaymentReminder[];
  chatOrderMode: 'AUTO' | 'REVIEW';
  chatOrderExpiryMinutes: number;
  chatOrderTagId: string | null;
  updatedAt?: string;
}

// ---------- Requests (US2, US3) ----------

export interface PaymentRequest {
  id: string;
  contactId: string | null;
  conversationId: string | null;
  contactName: string | null;
  phone: string | null;
  amountMinor: number;
  currency: string;
  description: string;
  reference: string | null;
  status: PaymentStatus;
  display: PaymentDisplay;
  source: PaymentSource;
  createdBy: { id: string; name: string } | null;
  expiresAt: string;
  paidAt: string | null;
  paidLate: boolean;
  failedAttempts: number;
  lastFailureCode: string | null;
  refundedMinor: number;
  cancelledAt: string | null;
  remindersSent: number;
  opens: number;
  isTest: boolean;
  payUrl: string;
  campaignId: string | null;
  chatOrderId: string | null;
  storeOrderId: string | null;
  createdAt: string;
}

export interface PaymentRequestDetail extends PaymentRequest {
  delivery: string | null;
  events: Array<{ type: string; result: string; source?: string; receivedAt: string }>;
}

/** The summary a chat item carries for a payment request (002 contract update). */
export interface ChatPaymentSummary {
  id: string;
  amountMinor: number;
  currency: string;
  description: string;
  status: PaymentStatus;
  display: PaymentDisplay;
  expiresAt: string;
  payUrl: string;
}

export interface PaymentTotals {
  requestedMinor: number;
  requestedCount: number;
  paidMinor: number;
  paidCount: number;
  waitingMinor: number;
  waitingCount: number;
  expiredMinor: number;
  expiredCount: number;
  refundedMinor: number;
  refundedCount: number;
}

export interface PaymentsSummary {
  currency: string;
  totals: PaymentTotals;
  days: Array<PaymentTotals & { day: string }>;
  sources: Array<PaymentTotals & { source: PaymentSource }>;
}

export const paymentsKeys = {
  gateway: ['payments', 'gateway'] as const,
  settings: ['payments', 'settings'] as const,
  requests: (filters: Record<string, string | number | boolean | undefined>) => ['payments', 'requests', filters] as const,
  request: (id: string) => ['payments', 'requests', id] as const,
  summary: (from: string, to: string, source?: string) => ['payments', 'summary', from, to, source ?? ''] as const,
  contact: (contactId: string) => ['payments', 'contact', contactId] as const,
};

// ---------- Labels ----------

export const GATEWAY_CHECK_LABEL: Record<GatewayCheckKey, string> = {
  KEY_FORMAT: 'Stripe key',
  KEY_KIND: 'Key type',
  ACCOUNT_READ: 'Stripe account',
  ACCOUNT_COUNTRY: 'Account country',
  ACCOUNT_CURRENCY: 'Currency',
  CHARGES_ENABLED: 'Taking payments',
  CHECKOUT_ACCESS: 'Payment pages',
  WEBHOOK_ENDPOINT: 'Notification address',
};

export const PAYMENT_DISPLAY_LABEL: Record<PaymentDisplay, string> = {
  WAITING: 'Waiting',
  FAILED_ATTEMPT: 'Failed attempt',
  PAID: 'Paid',
  PAID_LATE: 'Paid late',
  PARTLY_REFUNDED: 'Partly refunded',
  REFUNDED: 'Refunded',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  NOT_DELIVERED: 'Not delivered',
};

export const PAYMENT_DISPLAY_TONE: Record<PaymentDisplay, 'neutral' | 'good' | 'warn' | 'bad'> = {
  WAITING: 'neutral',
  FAILED_ATTEMPT: 'warn',
  PAID: 'good',
  PAID_LATE: 'good',
  PARTLY_REFUNDED: 'warn',
  REFUNDED: 'neutral',
  EXPIRED: 'bad',
  CANCELLED: 'neutral',
  NOT_DELIVERED: 'bad',
};

export const PAYMENT_SOURCE_LABEL: Record<PaymentSource, string> = {
  INBOX: 'Live chat',
  FLOW: 'Flow',
  CAMPAIGN: 'Campaign',
  API: 'API',
  STORE_ORDER: 'Store order',
  CHAT_ORDER: 'Chat order',
};

/** An amount in minor units with its currency, e.g. "AED 150.00". */
export function paymentMoney(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '—';
  return formatMinor(minor, currency);
}
