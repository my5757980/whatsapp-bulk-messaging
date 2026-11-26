import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T032 (feature 008 US2, research R2): our pay link in front of Stripe Checkout. It sends the customer
// to the open session, makes a new one (after expiring the old) while the request waits, never makes
// two at once, shows our own pages for paid, expired, cancelled and paused requests and Stripe's
// return, counts opens except previews and robots, and knows nothing of unknown codes.

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('Pay link /l/p/:code (008 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;

  const open = (code: string, query = '', ua = PHONE_UA) => request(ctx.server()).get(`/l/p/${code}${query}`).set('user-agent', ua);
  const ask = async (conversationId: string) => {
    const res = await admin.agent
      .post(`/api/inbox/conversations/${conversationId}/payment-requests`)
      .set('X-CSRF-Token', admin.csrf)
      .send({ amountMinor: 15000, description: 'Order 1042', expiresInMinutes: 600 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: String(res.body.id), code: String(res.body.payUrl).split('/p/')[1] as string };
  };
  const apply = async (event: Record<string, unknown>) => {
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx);
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('sends the customer to the open session and counts the open', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(conversation.id);
    const res = await open(req.code);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(stripe.sessionFor(req.id)?.url);
    expect(res.headers['cache-control']).toBe('no-store');
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.opens).toBe(1);
    expect(row.firstOpenedAt).not.toBeNull();
  });

  it('does not count previews and robots', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(conversation.id);
    expect((await open(req.code, '', 'WhatsApp/2.24.1.6 A')).status).toBe(302);
    expect((await open(req.code, '', 'facebookexternalhit/1.1')).status).toBe(302);
    expect((await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } })).opens).toBe(0);
  });

  it('makes a new session after the old one ended while the request waits, and only one at a time', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(conversation.id);
    const first = stripe.sessionFor(req.id)!;
    await apply(stripe.expire(first.id));
    const [a, b] = await Promise.all([open(req.code), open(req.code)]);
    const second = stripe.sessionFor(req.id)!;
    expect(second.id).not.toBe(first.id);
    expect(a.headers.location).toBe(second.url);
    expect(b.headers.location).toBe(second.url);
    const created = stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/).filter((c) => c.body['metadata[wbm_payment_request]'] === req.id);
    expect(created.map((c) => c.idempotencyKey)).toEqual([`wbm-pr-${req.id}-s1`, `wbm-pr-${req.id}-s2`]);
    expect((await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } })).sessionsCreated).toBe(2);
  });

  it('expires a still-open session past its time before making the next one', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(conversation.id);
    const first = stripe.sessionFor(req.id)!;
    await ctx.prisma.paymentRequest.update({ where: { id: req.id }, data: { sessionExpiresAt: new Date(Date.now() - 60_000) } });
    const res = await open(req.code);
    expect(res.status).toBe(302);
    expect(stripe.sessions.get(first.id)?.status).toBe('expired');
    expect(res.headers.location).toBe(stripe.sessionFor(req.id)?.url);
    expect(stripe.sessionFor(req.id)?.id).not.toBe(first.id);
  });

  it('shows our own pages for paid, expired, cancelled and paused requests, and Stripe’s return', async () => {
    const { conversation, number } = await seedOpenChat(ctx);
    const paid = await ask(conversation.id);
    await apply(stripe.pay(stripe.sessionFor(paid.id)!.id));
    const paidPage = await open(paid.code);
    expect(paidPage.status).toBe(200);
    expect(paidPage.text).toContain('Payment received');
    expect(paidPage.text).toContain(`https://wa.me/${number.displayPhoneNumber.replace(/\D/g, '')}`);
    expect(paidPage.headers['content-type']).toMatch(/text\/html/);

    const back = await open(paid.code, '?paid=1');
    expect(back.status).toBe(200);
    expect(back.text).toMatch(/Thank you/);

    const cancelled = await ask(conversation.id);
    await admin.agent.post(`/api/payments/requests/${cancelled.id}/cancel`).set('X-CSRF-Token', admin.csrf).send({});
    expect((await open(cancelled.code)).text).toMatch(/cancelled/i);

    const expired = await ask(conversation.id);
    await ctx.prisma.paymentRequest.update({ where: { id: expired.id }, data: { status: 'EXPIRED', expiredAt: new Date() } });
    expect((await open(expired.code)).text).toMatch(/expired/i);

    const paused = await ask(conversation.id);
    await apply(stripe.expire(stripe.sessionFor(paused.id)!.id));
    await ctx.prisma.paymentGateway.deleteMany();
    const pausedPage = await open(paused.code);
    expect(pausedPage.status).toBe(200);
    expect(pausedPage.text).toMatch(/paused/i);
  });

  it('answers 404 for unknown codes and never sends anyone onward', async () => {
    const res = await open('ZZZZZZZZZZ');
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
    expect((await open('bad')).status).toBe(404);
  });
});
