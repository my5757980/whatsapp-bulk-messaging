// Payment requests (feature 008, research R2, R3, R5): limits, the Checkout Session expiry, how a
// Stripe event changes a request, the display state, and the redaction of stored events. Pure.
import { minimumMinor } from './money.js';

export const PAYMENT_STATUSES = ['WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_SOURCES = ['INBOX', 'FLOW', 'CAMPAIGN', 'API', 'STORE_ORDER', 'CHAT_ORDER'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export const PAYMENT_DISPLAYS = ['WAITING', 'FAILED_ATTEMPT', 'PAID', 'PAID_LATE', 'PARTLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'CANCELLED', 'NOT_DELIVERED'] as const;
export type PaymentDisplay = (typeof PAYMENT_DISPLAYS)[number];

export const PAYMENT_LIMITS = {
  descriptionMax: 250,
  referenceMax: 80,
  sessionTextMax: 1024,
  buttonTextMax: 20,
  expiryMinutesMin: 30,
  expiryMinutesMax: 43_200,
  /** Flow steps never wait past the 24-hour window (the 003 timeout ceiling). */
  flowExpiryMinutesMax: 1_380,
  defaultExpiryMinutes: 1_440,
  defaultMaxAmountMinor: 1_000_000,
  remindersMax: 2,
  /** Stripe Checkout Sessions last 30 minutes to 24 hours. */
  sessionMinSeconds: 30 * 60,
  sessionMaxSeconds: 24 * 60 * 60,
  /** Expire calls for a session are retried by later ticks at most this often. */
  sessionExpireAttemptsMax: 10,
} as const;

/** Metadata key on Checkout Sessions and payment intents that names our request (R2). */
export const PAYMENT_REQUEST_METADATA_KEY = 'wbm_payment_request';
/** Metadata key on the connection check session (R4). */
export const PAYMENT_CHECK_METADATA_KEY = 'wbm_check';

export function amountProblem(amountMinor: number, currency: string, maxMinor: number): 'AMOUNT_INVALID' | 'AMOUNT_TOO_SMALL' | 'AMOUNT_TOO_LARGE' | null {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return 'AMOUNT_INVALID';
  if (amountMinor < minimumMinor(currency)) return 'AMOUNT_TOO_SMALL';
  if (amountMinor > maxMinor) return 'AMOUNT_TOO_LARGE';
  return null;
}

export function expiryProblem(minutes: number, inFlow = false): string | null {
  const max = inFlow ? PAYMENT_LIMITS.flowExpiryMinutesMax : PAYMENT_LIMITS.expiryMinutesMax;
  if (!Number.isInteger(minutes) || minutes < PAYMENT_LIMITS.expiryMinutesMin || minutes > max) {
    return `The expiry must be ${PAYMENT_LIMITS.expiryMinutesMin} to ${max} minutes`;
  }
  return null;
}

/**
 * The `expires_at` (Unix seconds) of a new Checkout Session: the request's expiry, kept within
 * Stripe's 30 minutes to 24 hours from now. A session may outlive a request that ends in under 30
 * minutes; the payments tick expires it at the request's expiry (R2, R6).
 */
export function sessionExpiresAt(nowMs: number, requestExpiresAtMs: number): number {
  const min = nowMs + PAYMENT_LIMITS.sessionMinSeconds * 1000;
  const max = nowMs + PAYMENT_LIMITS.sessionMaxSeconds * 1000;
  return Math.floor(Math.min(max, Math.max(min, requestExpiresAtMs)) / 1000);
}

// ---------- Stripe events ----------

export type PaymentChange =
  | { kind: 'paid'; at: number; amountMinor: number; paymentIntentId: string | null; sessionId: string }
  | { kind: 'processing'; sessionId: string; paymentIntentId: string | null }
  | { kind: 'failed'; at: number; code: string | null }
  | { kind: 'sessionExpired'; sessionId: string }
  | { kind: 'refunded'; at: number; refundedMinor: number; paymentIntentId: string };

export interface ParsedStripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** Unix seconds. */
  created: number;
  /** Our request id from metadata; null for refunds, which match by payment intent. */
  requestId: string | null;
  paymentIntentId: string | null;
  /** The connection check session (R4), never a customer payment. */
  check: boolean;
  change: PaymentChange | null;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** A Stripe expandable field: the id, or the object's id when expanded. */
const idOf = (value: unknown): string | null => str(value) ?? str(obj(value).id);

export function parseStripeEvent(event: unknown): ParsedStripeEvent {
  const e = obj(event);
  const data = obj(obj(e.data).object);
  const metadata = obj(data.metadata);
  const type = str(e.type) ?? '';
  const created = num(e.created);
  const base = {
    id: str(e.id) ?? '',
    type,
    livemode: e.livemode === true,
    created,
    check: str(metadata[PAYMENT_CHECK_METADATA_KEY]) !== null,
  };
  const sessionId = str(data.id) ?? '';
  const requestId = str(metadata[PAYMENT_REQUEST_METADATA_KEY]) ?? (type.startsWith('checkout.session.') ? str(data.client_reference_id) : null);
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const paymentIntentId = idOf(data.payment_intent);
      const change: PaymentChange =
        data.payment_status === 'paid' || type === 'checkout.session.async_payment_succeeded'
          ? { kind: 'paid', at: created, amountMinor: num(data.amount_total), paymentIntentId, sessionId }
          : { kind: 'processing', sessionId, paymentIntentId };
      return { ...base, requestId, paymentIntentId, change };
    }
    case 'checkout.session.async_payment_failed':
      return { ...base, requestId, paymentIntentId: idOf(data.payment_intent), change: { kind: 'failed', at: created, code: 'async_payment_failed' } };
    case 'checkout.session.expired':
      return { ...base, requestId, paymentIntentId: null, change: { kind: 'sessionExpired', sessionId } };
    case 'payment_intent.payment_failed': {
      const error = obj(data.last_payment_error);
      return { ...base, requestId, paymentIntentId: str(data.id), change: { kind: 'failed', at: created, code: str(error.decline_code) ?? str(error.code) } };
    }
    case 'charge.refunded': {
      const paymentIntentId = idOf(data.payment_intent);
      return {
        ...base,
        requestId: str(metadata[PAYMENT_REQUEST_METADATA_KEY]),
        paymentIntentId,
        change: paymentIntentId ? { kind: 'refunded', at: created, refundedMinor: num(data.amount_refunded), paymentIntentId } : null,
      };
    }
    default:
      return { ...base, requestId, paymentIntentId: null, change: null };
  }
}

/** The request fields that events change; times are epoch milliseconds. */
export interface PaymentState {
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  expiresAt: number;
  paidAt: number | null;
  paidAmountMinor: number | null;
  paidLate: boolean;
  paymentIntentId: string | null;
  failedAttempts: number;
  lastFailureCode: string | null;
  refundedMinor: number;
  sessionId: string | null;
}

export type PaymentEffect = 'PAID' | 'PAID_LATE' | 'FAILED' | 'PARTLY_REFUNDED' | 'REFUNDED' | 'SESSION_ENDED';

export type ApplyResult =
  | { outcome: 'applied'; state: PaymentState; effects: PaymentEffect[] }
  | { outcome: 'ignored'; reason: 'LIVEMODE_MISMATCH' | 'CHECK_SESSION' | 'UNHANDLED_TYPE' | 'ALREADY_PAID' | 'NOT_WAITING' | 'OTHER_SESSION' | 'NOT_NEWER' }
  | { outcome: 'pending'; reason: 'REFUND_BEFORE_PAYMENT' };

const RANK: Record<PaymentStatus, number> = { WAITING: 0, EXPIRED: 1, CANCELLED: 1, PAID: 2, REFUNDED: 3 };

/** Statuses only move forward; an expired or cancelled request can still become paid (late). */
export function canPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return RANK[to] > RANK[from];
}

/** How one parsed Stripe event changes a request (R3). Never moves a status back. */
export function applyPaymentEvent(state: PaymentState, event: ParsedStripeEvent, connectionLivemode: boolean): ApplyResult {
  if (event.livemode !== connectionLivemode) return { outcome: 'ignored', reason: 'LIVEMODE_MISMATCH' };
  if (event.check) return { outcome: 'ignored', reason: 'CHECK_SESSION' };
  const change = event.change;
  if (!change) return { outcome: 'ignored', reason: 'UNHANDLED_TYPE' };
  switch (change.kind) {
    case 'paid': {
      if (state.status === 'PAID' || state.status === 'REFUNDED') return { outcome: 'ignored', reason: 'ALREADY_PAID' };
      const paidAt = change.at * 1000;
      const paidLate = state.status === 'EXPIRED' || state.status === 'CANCELLED' || paidAt > state.expiresAt;
      return {
        outcome: 'applied',
        state: { ...state, status: 'PAID', paidAt, paidAmountMinor: change.amountMinor || state.amountMinor, paymentIntentId: change.paymentIntentId ?? state.paymentIntentId, paidLate },
        effects: paidLate ? ['PAID', 'PAID_LATE'] : ['PAID'],
      };
    }
    case 'processing':
      if (state.status !== 'WAITING') return { outcome: 'ignored', reason: 'NOT_WAITING' };
      return { outcome: 'applied', state: { ...state, paymentIntentId: change.paymentIntentId ?? state.paymentIntentId }, effects: [] };
    case 'failed':
      if (state.status !== 'WAITING') return { outcome: 'ignored', reason: 'NOT_WAITING' };
      return { outcome: 'applied', state: { ...state, failedAttempts: state.failedAttempts + 1, lastFailureCode: change.code }, effects: ['FAILED'] };
    case 'sessionExpired':
      if (state.sessionId !== change.sessionId) return { outcome: 'ignored', reason: 'OTHER_SESSION' };
      return { outcome: 'applied', state: { ...state, sessionId: null }, effects: ['SESSION_ENDED'] };
    case 'refunded': {
      if (state.status !== 'PAID' && state.status !== 'REFUNDED') return { outcome: 'pending', reason: 'REFUND_BEFORE_PAYMENT' };
      if (change.refundedMinor <= state.refundedMinor) return { outcome: 'ignored', reason: 'NOT_NEWER' };
      const full = change.refundedMinor >= (state.paidAmountMinor ?? state.amountMinor);
      return {
        outcome: 'applied',
        state: { ...state, refundedMinor: change.refundedMinor, status: full ? 'REFUNDED' : 'PAID' },
        effects: [full ? 'REFUNDED' : 'PARTLY_REFUNDED'],
      };
    }
  }
}

export interface DisplayInput {
  status: PaymentStatus;
  failedAttempts: number;
  paidLate: boolean;
  refundedMinor: number;
  /** The message that carried the link failed (001/002 message status). */
  deliveryFailed: boolean;
}

export function paymentDisplay(input: DisplayInput): PaymentDisplay {
  switch (input.status) {
    case 'WAITING':
      if (input.deliveryFailed) return 'NOT_DELIVERED';
      return input.failedAttempts > 0 ? 'FAILED_ATTEMPT' : 'WAITING';
    case 'PAID':
      if (input.refundedMinor > 0) return 'PARTLY_REFUNDED';
      return input.paidLate ? 'PAID_LATE' : 'PAID';
    default:
      return input.status;
  }
}

// ---------- Redaction (SC-004) ----------

/** Keys whose values describe cards or customers; removed wherever they appear in a stored event. */
const REDACTED_KEYS = new Set(['payment_method_details', 'billing_details', 'customer_details', 'shipping_details', 'shipping', 'card', 'customer_email', 'receipt_email']);

/** A copy of a Stripe event without card or customer details (R3). Ids, amounts and metadata stay. */
export function redactStripeEvent(event: unknown): unknown {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key)) continue;
      // An expanded payment method holds card details; a plain id is kept.
      if (key === 'payment_method' && inner !== null && typeof inner === 'object') continue;
      out[key] = walk(inner);
    }
    return out;
  };
  return walk(event);
}
