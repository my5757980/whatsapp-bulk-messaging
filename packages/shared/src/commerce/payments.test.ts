import { describe, expect, it } from 'vitest';
import {
  amountProblem,
  applyPaymentEvent,
  canPaymentTransition,
  expiryProblem,
  parseStripeEvent,
  paymentDisplay,
  redactStripeEvent,
  sessionExpiresAt,
  type PaymentState,
} from './payments.js';

// T008 (feature 008, research R2, R3, R5): limits, Checkout Session expiry, the event rules and display.
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const REQ = '0196f1f0-0000-7000-8000-000000000001';

function state(overrides: Partial<PaymentState> = {}): PaymentState {
  return {
    status: 'WAITING',
    amountMinor: 15000,
    currency: 'aed',
    expiresAt: NOW + 24 * HOUR,
    paidAt: null,
    paidAmountMinor: null,
    paidLate: false,
    paymentIntentId: null,
    failedAttempts: 0,
    lastFailureCode: null,
    refundedMinor: 0,
    sessionId: 'cs_test_1',
    ...overrides,
  };
}

const session = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: `evt_${type}`,
  object: 'event',
  type,
  livemode: false,
  created: Math.floor(NOW / 1000) + 60,
  data: { object: { id: 'cs_test_1', object: 'checkout.session', metadata: { wbm_payment_request: REQ }, client_reference_id: REQ, ...object } },
  ...extra,
});

describe('payment limits', () => {
  it('checks amounts against the minimum and the admin maximum', () => {
    expect(amountProblem(199, 'aed', 1_000_000)).toBe('AMOUNT_TOO_SMALL');
    expect(amountProblem(200, 'aed', 1_000_000)).toBeNull();
    expect(amountProblem(1_000_000, 'aed', 1_000_000)).toBeNull();
    expect(amountProblem(1_000_001, 'aed', 1_000_000)).toBe('AMOUNT_TOO_LARGE');
    expect(amountProblem(150.5, 'aed', 1_000_000)).toBe('AMOUNT_INVALID');
  });

  it('allows expiry from 30 minutes to 30 days, and at most 1,380 minutes in flows', () => {
    expect(expiryProblem(29)).not.toBeNull();
    expect(expiryProblem(30)).toBeNull();
    expect(expiryProblem(43_200)).toBeNull();
    expect(expiryProblem(43_201)).not.toBeNull();
    expect(expiryProblem(1_380, true)).toBeNull();
    expect(expiryProblem(1_381, true)).not.toBeNull();
  });

  it('clamps the Checkout Session expiry to Stripe’s 30 minutes – 24 hours and to the request expiry', () => {
    const s = (ms: number) => Math.floor(ms / 1000);
    expect(sessionExpiresAt(NOW, NOW + 2 * HOUR)).toBe(s(NOW + 2 * HOUR));
    expect(sessionExpiresAt(NOW, NOW + 10 * MIN)).toBe(s(NOW + 30 * MIN));
    expect(sessionExpiresAt(NOW, NOW + 7 * 24 * HOUR)).toBe(s(NOW + 24 * HOUR));
  });
});

describe('parseStripeEvent', () => {
  it('reads a paid checkout session', () => {
    const parsed = parseStripeEvent(session('checkout.session.completed', { payment_status: 'paid', amount_total: 15000, payment_intent: 'pi_1' }));
    expect(parsed).toMatchObject({ id: 'evt_checkout.session.completed', requestId: REQ, livemode: false, check: false, paymentIntentId: 'pi_1' });
    expect(parsed.change).toEqual({ kind: 'paid', at: Math.floor(NOW / 1000) + 60, amountMinor: 15000, paymentIntentId: 'pi_1', sessionId: 'cs_test_1' });
  });

  it('treats an unpaid completion (a delayed method) as processing', () => {
    expect(parseStripeEvent(session('checkout.session.completed', { payment_status: 'unpaid', payment_intent: 'pi_1' })).change).toEqual({ kind: 'processing', sessionId: 'cs_test_1', paymentIntentId: 'pi_1' });
  });

  it('maps async results, expiry, payment failures and refunds', () => {
    expect(parseStripeEvent(session('checkout.session.async_payment_succeeded', { payment_status: 'paid', amount_total: 15000, payment_intent: 'pi_1' })).change?.kind).toBe('paid');
    expect(parseStripeEvent(session('checkout.session.async_payment_failed', {})).change).toMatchObject({ kind: 'failed', code: 'async_payment_failed' });
    expect(parseStripeEvent(session('checkout.session.expired', { status: 'expired' })).change).toEqual({ kind: 'sessionExpired', sessionId: 'cs_test_1' });

    const failed = parseStripeEvent({
      id: 'evt_f', type: 'payment_intent.payment_failed', livemode: false, created: 1,
      data: { object: { id: 'pi_9', object: 'payment_intent', metadata: { wbm_payment_request: REQ }, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } } },
    });
    expect(failed).toMatchObject({ requestId: REQ, paymentIntentId: 'pi_9', change: { kind: 'failed', code: 'insufficient_funds' } });

    const refund = parseStripeEvent({
      id: 'evt_r', type: 'charge.refunded', livemode: false, created: 2,
      data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount: 15000, amount_refunded: 7500 } },
    });
    expect(refund).toMatchObject({ requestId: null, paymentIntentId: 'pi_1', change: { kind: 'refunded', refundedMinor: 7500 } });
  });

  it('marks the connection check session and leaves other types unhandled', () => {
    expect(parseStripeEvent(session('checkout.session.expired', { metadata: { wbm_check: '1' } })).check).toBe(true);
    expect(parseStripeEvent({ id: 'evt_x', type: 'customer.created', livemode: false, created: 1, data: { object: {} } }).change).toBeNull();
  });
});

describe('applyPaymentEvent', () => {
  const paid = () => parseStripeEvent(session('checkout.session.completed', { payment_status: 'paid', amount_total: 15000, payment_intent: 'pi_1' }));

  it('marks a waiting request paid', () => {
    const result = applyPaymentEvent(state(), paid(), false);
    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.state).toMatchObject({ status: 'PAID', paidAmountMinor: 15000, paymentIntentId: 'pi_1', paidLate: false });
    expect(result.state.paidAt).toBe((Math.floor(NOW / 1000) + 60) * 1000);
    expect(result.effects).toEqual(['PAID']);
  });

  it('marks payments after expiry or cancel as paid late, and never moves back', () => {
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      const result = applyPaymentEvent(state({ status }), paid(), false);
      expect(result).toMatchObject({ outcome: 'applied', state: { status: 'PAID', paidLate: true }, effects: ['PAID', 'PAID_LATE'] });
    }
    const late = applyPaymentEvent(state({ expiresAt: NOW }), paid(), false);
    expect(late).toMatchObject({ outcome: 'applied', state: { paidLate: true } });
    expect(applyPaymentEvent(state({ status: 'PAID' }), paid(), false)).toEqual({ outcome: 'ignored', reason: 'ALREADY_PAID' });
    const expired = parseStripeEvent(session('checkout.session.expired', {}));
    expect(applyPaymentEvent(state({ status: 'PAID', sessionId: null }), expired, false)).toMatchObject({ outcome: 'ignored' });
  });

  it('counts failed attempts and keeps the request payable', () => {
    const failed = parseStripeEvent({ id: 'e', type: 'payment_intent.payment_failed', livemode: false, created: 1, data: { object: { id: 'pi_2', metadata: { wbm_payment_request: REQ }, last_payment_error: { code: 'card_declined' } } } });
    const result = applyPaymentEvent(state({ failedAttempts: 1 }), failed, false);
    expect(result).toMatchObject({ outcome: 'applied', state: { status: 'WAITING', failedAttempts: 2, lastFailureCode: 'card_declined' }, effects: ['FAILED'] });
    expect(applyPaymentEvent(state({ status: 'PAID' }), failed, false)).toEqual({ outcome: 'ignored', reason: 'NOT_WAITING' });
  });

  it('clears the current session when it expires, and ignores other sessions', () => {
    const expired = parseStripeEvent(session('checkout.session.expired', {}));
    expect(applyPaymentEvent(state(), expired, false)).toMatchObject({ outcome: 'applied', state: { status: 'WAITING', sessionId: null }, effects: ['SESSION_ENDED'] });
    expect(applyPaymentEvent(state({ sessionId: 'cs_test_2' }), expired, false)).toEqual({ outcome: 'ignored', reason: 'OTHER_SESSION' });
  });

  it('stores the payment intent of a processing (delayed) payment without changing the status', () => {
    const processing = parseStripeEvent(session('checkout.session.completed', { payment_status: 'unpaid', payment_intent: 'pi_7' }));
    expect(applyPaymentEvent(state(), processing, false)).toMatchObject({ outcome: 'applied', state: { status: 'WAITING', paymentIntentId: 'pi_7' }, effects: [] });
  });

  it('applies partial and full refunds, and holds a refund that comes before its payment', () => {
    const refund = (amount: number) => parseStripeEvent({ id: `r${amount}`, type: 'charge.refunded', livemode: false, created: 5, data: { object: { payment_intent: 'pi_1', amount_refunded: amount } } });
    const paidState = state({ status: 'PAID', paidAmountMinor: 15000, paymentIntentId: 'pi_1' });
    expect(applyPaymentEvent(paidState, refund(5000), false)).toMatchObject({ outcome: 'applied', state: { status: 'PAID', refundedMinor: 5000 }, effects: ['PARTLY_REFUNDED'] });
    expect(applyPaymentEvent(state({ ...paidState, refundedMinor: 5000 }), refund(15000), false)).toMatchObject({ outcome: 'applied', state: { status: 'REFUNDED', refundedMinor: 15000 }, effects: ['REFUNDED'] });
    expect(applyPaymentEvent(state({ ...paidState, refundedMinor: 5000 }), refund(5000), false)).toEqual({ outcome: 'ignored', reason: 'NOT_NEWER' });
    expect(applyPaymentEvent(state(), refund(5000), false)).toEqual({ outcome: 'pending', reason: 'REFUND_BEFORE_PAYMENT' });
  });

  it('ignores events from the other mode, the check session and unhandled types', () => {
    expect(applyPaymentEvent(state(), paid(), true)).toEqual({ outcome: 'ignored', reason: 'LIVEMODE_MISMATCH' });
    const check = parseStripeEvent(session('checkout.session.completed', { payment_status: 'paid', amount_total: 200, metadata: { wbm_check: '1' } }));
    expect(applyPaymentEvent(state(), check, false)).toEqual({ outcome: 'ignored', reason: 'CHECK_SESSION' });
    const other = parseStripeEvent({ id: 'x', type: 'customer.created', livemode: false, created: 1, data: { object: {} } });
    expect(applyPaymentEvent(state(), other, false)).toEqual({ outcome: 'ignored', reason: 'UNHANDLED_TYPE' });
  });

  it('only moves forward between statuses', () => {
    expect(canPaymentTransition('WAITING', 'PAID')).toBe(true);
    expect(canPaymentTransition('WAITING', 'EXPIRED')).toBe(true);
    expect(canPaymentTransition('EXPIRED', 'PAID')).toBe(true);
    expect(canPaymentTransition('CANCELLED', 'PAID')).toBe(true);
    expect(canPaymentTransition('PAID', 'REFUNDED')).toBe(true);
    expect(canPaymentTransition('PAID', 'WAITING')).toBe(false);
    expect(canPaymentTransition('PAID', 'EXPIRED')).toBe(false);
    expect(canPaymentTransition('EXPIRED', 'CANCELLED')).toBe(false);
    expect(canPaymentTransition('REFUNDED', 'PAID')).toBe(false);
  });
});

describe('paymentDisplay', () => {
  it('shows what an agent needs to know', () => {
    const base = { status: 'WAITING' as const, failedAttempts: 0, paidLate: false, refundedMinor: 0, deliveryFailed: false };
    expect(paymentDisplay(base)).toBe('WAITING');
    expect(paymentDisplay({ ...base, failedAttempts: 1 })).toBe('FAILED_ATTEMPT');
    expect(paymentDisplay({ ...base, deliveryFailed: true })).toBe('NOT_DELIVERED');
    expect(paymentDisplay({ ...base, status: 'PAID' })).toBe('PAID');
    expect(paymentDisplay({ ...base, status: 'PAID', paidLate: true })).toBe('PAID_LATE');
    expect(paymentDisplay({ ...base, status: 'PAID', refundedMinor: 100 })).toBe('PARTLY_REFUNDED');
    expect(paymentDisplay({ ...base, status: 'REFUNDED' })).toBe('REFUNDED');
    expect(paymentDisplay({ ...base, status: 'EXPIRED' })).toBe('EXPIRED');
    expect(paymentDisplay({ ...base, status: 'CANCELLED', deliveryFailed: true })).toBe('CANCELLED');
  });
});

describe('redactStripeEvent (SC-004)', () => {
  it('removes card and customer details and keeps ids, amounts and metadata', () => {
    const event = {
      id: 'evt_1',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          payment_intent: 'pi_1',
          amount: 15000,
          amount_refunded: 7500,
          metadata: { wbm_payment_request: REQ },
          receipt_email: 'customer@example.com',
          payment_method_details: { card: { brand: 'visa', last4: '4242' } },
          billing_details: { name: 'Test Customer', email: 'customer@example.com' },
          last_payment_error: { code: 'card_declined', payment_method: { id: 'pm_1', card: { last4: '0002' } } },
          customer_details: { email: 'customer@example.com', phone: '+971500000000' },
          shipping_details: { address: { city: 'Dubai' } },
        },
      },
    };
    const redacted = redactStripeEvent(event) as typeof event;
    const text = JSON.stringify(redacted);
    expect(text).not.toMatch(/last4|4242|0002|visa|customer@example\.com|Test Customer|\+971500000000|Dubai/);
    expect(redacted.data.object).toMatchObject({ id: 'ch_1', payment_intent: 'pi_1', amount: 15000, amount_refunded: 7500, metadata: { wbm_payment_request: REQ }, last_payment_error: { code: 'card_declined' } });
    expect(event.data.object.payment_method_details).toBeDefined();
  });

  it('keeps a payment method id that is a plain string', () => {
    const redacted = redactStripeEvent({ data: { object: { payment_method: 'pm_123' } } }) as { data: { object: { payment_method: string } } };
    expect(redacted.data.object.payment_method).toBe('pm_123');
  });
});
