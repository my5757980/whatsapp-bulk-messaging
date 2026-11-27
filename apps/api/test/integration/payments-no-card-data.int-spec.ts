import { Logger } from '@nestjs/common';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T093 (feature 008, SC-004): a payment, a half refund and a failed attempt whose Stripe events carry
// card and customer details (card number, last4, brand, CVC check, billing and customer addresses).
// Afterwards no payment, order or event table, no log line and no outbound event holds any of it.

type Json = Record<string, unknown>;

const PAN = '4242424242424242';
const ADDRESS = 'Villa 42 Jumeirah Bay Lane';
const BRANDS = /\b(visa|mastercard|amex|american express|discover|diners|jcb|unionpay)\b/i;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What card data a text holds: Luhn-valid 13–19 digit numbers, last4, CVC, brands, the address. */
function cardData(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?<![\w-])\d{13,19}(?![\w-])/g)) {
    // Millisecond timestamps (2017 to 2036) are not card numbers.
    const timestamp = m[0].length === 13 && Number(m[0]) > 1.5e12 && Number(m[0]) < 2.1e12;
    if (!timestamp && luhn(m[0])) found.push(`card number ${m[0]}`);
  }
  if (/last4/i.test(text)) found.push('last4');
  if (/\bcvc/i.test(text)) found.push('cvc');
  const brand = BRANDS.exec(text);
  if (brand) found.push(`brand ${brand[0]}`);
  if (text.includes(ADDRESS)) found.push('address');
  return found;
}

const serialize = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause } : v)) ?? '';

const card = { brand: 'visa', last4: '4242', number: PAN, cvc: '123', exp_month: 12, exp_year: 2030, checks: { cvc_check: 'pass', address_line1_check: 'pass' } };
const billing = { name: 'Test Customer', email: 'customer@example.com', phone: '+971501234567', address: { line1: ADDRESS, city: 'Dubai', country: 'AE', postal_code: '00000' } };

describe('No card data is stored, logged or sent (008 SC-004)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;
  let endpointId: string;
  const logs: string[] = [];
  const startedAt = new Date();

  const ask = async (conversationId: string, amountMinor: number) => {
    const res = await admin.agent
      .post(`/api/inbox/conversations/${conversationId}/payment-requests`)
      .set('X-CSRF-Token', admin.csrf)
      .send({ amountMinor, description: `Order ${amountMinor}`, expiresInMinutes: 120 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  };
  const deliver = async (event: Json) => {
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
  };
  const objectOf = (event: Json) => (event.data as { object: Json }).object;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx);
    const endpoint = await admin.agent
      .post('/api/webhook-endpoints')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: uniq('Card scan hook '), url: `https://${uniq('scan')}.example.test/hooks`, eventTypes: ['payment.requested', 'payment.paid', 'payment.failed', 'payment.refunded'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    endpointId = endpoint.body.id as string;
    ctx.app.get(OutboundEvents).invalidate();
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logs.push(serialize(args));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    restoreNetwork();
    await ctx.prisma.webhookEndpoint.delete({ where: { id: endpointId } }).catch(() => undefined);
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('keeps no card number, last4, CVC, brand or address after a payment, a refund and a failed attempt', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const paid = await ask(conversation.id, 20_000);
    const failed = await ask(conversation.id, 9_000);

    // Paid, with the customer's details on the session and card details where Stripe would expand them.
    const paidEvent = stripe.pay(stripe.sessionFor(paid.id)!.id);
    Object.assign(objectOf(paidEvent), { customer_details: billing, shipping_details: { name: 'Test Customer', address: billing.address }, payment_method_details: { type: 'card', card } });
    await deliver(paidEvent);

    // Half refunded: the charge carries the card and the billing address.
    const refundEvent = stripe.refund(stripe.sessionFor(paid.id)!.id, 10_000);
    Object.assign(objectOf(refundEvent), { payment_method_details: { type: 'card', card }, billing_details: billing });
    await deliver(refundEvent);

    // A failed attempt: the error carries the expanded payment method.
    const failEvent = stripe.decline(stripe.sessionFor(failed.id)!.id);
    Object.assign((objectOf(failEvent).last_payment_error as Json).payment_method as Json, { card, billing_details: billing });
    await deliver(failEvent);

    const ids = [paid.id, failed.id];
    expect((await ctx.prisma.paymentRequest.findMany({ where: { id: { in: ids } }, orderBy: { amountMinor: 'desc' } })).map((r) => [r.status, r.refundedMinor, r.failedAttempts])).toEqual([
      ['PAID', 10_000n, 0],
      ['WAITING', 0n, 1],
    ]);

    // What was stored, logged and sent.
    const mentions = (rows: unknown[]) => rows.filter((r) => ids.some((id) => serialize(r).includes(id)));
    const stored: Record<string, unknown[]> = {
      payment_requests: await ctx.prisma.paymentRequest.findMany({ where: { id: { in: ids } } }),
      payment_events: await ctx.prisma.paymentEvent.findMany({ where: { receivedAt: { gte: startedAt } } }),
      chat_orders: await ctx.prisma.chatOrder.findMany({ where: { createdAt: { gte: startedAt } } }),
      outbound_events: mentions(await ctx.prisma.outboundEvent.findMany({ where: { createdAt: { gte: startedAt }, type: { startsWith: 'payment.' } } })),
      conversation_events: await ctx.prisma.conversationEvent.findMany({ where: { conversationId: conversation.id } }),
      chat_messages: await ctx.prisma.chatMessage.findMany({ where: { conversationId: conversation.id } }),
      notifications: mentions(await ctx.prisma.notification.findMany({ where: { createdAt: { gte: startedAt } } })),
      audit_logs: mentions(await ctx.prisma.auditLog.findMany({ where: { createdAt: { gte: startedAt } } })),
    };
    expect(stored.payment_events!.length).toBeGreaterThanOrEqual(3);
    expect(stored.outbound_events!.length).toBeGreaterThanOrEqual(3);
    const findings = Object.entries(stored).flatMap(([table, rows]) => rows.flatMap((row) => cardData(serialize(row)).map((what) => `${table}: ${what}`)));
    findings.push(...logs.flatMap((line) => cardData(line).map((what) => `log: ${what} in ${line.slice(0, 200)}`)));
    expect(findings).toEqual([]);

    // The scan itself finds what it looks for.
    expect(cardData(serialize({ card, billing })).sort()).toEqual(['address', 'brand visa', `card number ${PAN}`, 'cvc', 'last4'].sort());
  });
});
