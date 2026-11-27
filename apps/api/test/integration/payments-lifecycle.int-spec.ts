import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { PaymentsReconcileProcessor } from '../../src/modules/payments/events/payments-reconcile.processor.js';
import { PaymentsTickProcessor } from '../../src/modules/payments/tick/payments-tick.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T031 (feature 008 US2, FR-011 – FR-016, research R3, R6): what happens after a request is sent:
// paid (once, whatever the order), failed attempts, delayed payments, expiry by the tick with the
// session expired at Stripe, paid late, cancel and resend, the other mode ignored, the reconciler,
// and who may see what.

type Json = Record<string, unknown>;

describe('Payment request lifecycle (008 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let stripe: FakeStripe;

  const ask = async (who: SignedInAgent, conversationId: string, extra: object = {}) => {
    const res = await who.agent
      .post(`/api/inbox/conversations/${conversationId}/payment-requests`)
      .set('X-CSRF-Token', who.csrf)
      .send({ amountMinor: 15000, description: 'Order 1042', expiresInMinutes: 120, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; payUrl: string };
  };
  /** Delivers a Stripe event and applies it as the worker would. */
  const deliver = async (event: Json) => {
    const res = await stripe.deliver(ctx, event);
    expect(res.status).toBe(200);
    const row = await ctx.prisma.paymentEvent.findFirst({ where: { stripeEventId: String(event.id) } });
    if (row) await ctx.app.get(PaymentEventsProcessor).process(row.id);
    return row;
  };
  const get = async (id: string) => (await admin.agent.get(`/api/payments/requests/${id}`)).body as Json;
  const session = (requestId: string) => stripe.sessionFor(requestId)!;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const endpoint = await admin.agent
      .post('/api/webhook-endpoints')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: uniq('Payments hook '), url: `https://${uniq('pay')}.example.test/hooks`, eventTypes: ['payment.requested', 'payment.paid', 'payment.failed', 'payment.expired', 'payment.cancelled', 'payment.refunded'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
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

  it('marks a paid request once, tells the agent who asked, and records the journey and the event', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const paid = stripe.pay(session(req.id).id);
    await deliver(paid);
    const after = await get(req.id);
    expect(after).toMatchObject({ status: 'PAID', display: 'PAID', paidLate: false });
    expect(after.paidAt).toBeTruthy();
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.paymentIntentId).toBe(session(req.id).payment_intent);
    expect(Number(row.paidAmountMinor)).toBe(15000);

    const notes = await ctx.prisma.notification.findMany({ where: { type: 'PAYMENT_RECEIVED', userId: admin.userId } });
    expect(notes).toHaveLength(1);
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: 'PAYMENT_PAID' } })).toBe(1);
    const event = await ctx.prisma.outboundEvent.findFirst({ where: { type: 'payment.paid' }, orderBy: { createdAt: 'desc' } });
    expect(event?.data).toMatchObject({ payment: { id: req.id, status: 'PAID', amountMinor: 15000, currency: 'aed' } });
    expect(JSON.stringify(event?.data)).not.toMatch(/last4|4242|whsec_|rk_test_/);

    // A repeat and a later expired session change nothing.
    expect((await stripe.deliver(ctx, paid)).status).toBe(200);
    await deliver(stripe.expire(session(req.id).id));
    expect((await get(req.id)).status).toBe('PAID');
    expect(await ctx.prisma.notification.count({ where: { type: 'PAYMENT_RECEIVED', userId: admin.userId } })).toBe(1);
  });

  it('counts failed attempts, keeps the request payable and stores no card details', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const row = await deliver(stripe.decline(session(req.id).id, 'insufficient_funds'));
    expect(await get(req.id)).toMatchObject({ status: 'WAITING', display: 'FAILED_ATTEMPT', failedAttempts: 1, lastFailureCode: 'insufficient_funds' });
    const stored = await ctx.prisma.paymentEvent.findUniqueOrThrow({ where: { id: row!.id } });
    expect(JSON.stringify(stored.body)).not.toMatch(/last4|0002|visa|Test Customer|customer@example\.com/);
    expect(stored.result).toBe('APPLIED');
    expect(stored.paymentRequestId).toBe(req.id);
  });

  it('waits for a delayed payment, then applies the async success', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const s = session(req.id);
    await deliver(stripe.event('checkout.session.completed', { ...stripe.publicSession(s), status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_delayed_1' }));
    expect((await get(req.id)).status).toBe('WAITING');
    await deliver(stripe.event('checkout.session.async_payment_succeeded', { ...stripe.publicSession(s), status: 'complete', payment_status: 'paid', payment_intent: 'pi_delayed_1' }));
    expect((await get(req.id)).status).toBe('PAID');
  });

  it('expires on time, expiring the session at Stripe (retried), and marks a later payment paid late', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id, { expiresInMinutes: 30 });
    const s = session(req.id);
    stripe.fail('POST', /\/expire$/, 503, undefined, 4);
    const tick = ctx.app.get(PaymentsTickProcessor);
    await tick.runTick(new Date(Date.now() + 31 * 60_000));
    let row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('EXPIRED');
    expect(row.sessionExpirePending).toBe(true);
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: 'PAYMENT_EXPIRED' } })).toBe(1);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'payment.expired' } })).toBeGreaterThan(0);

    await tick.runTick(new Date(Date.now() + 32 * 60_000));
    row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.sessionExpirePending).toBe(false);
    expect(stripe.sessions.get(s.id)?.status).toBe('expired');

    // A payment that still lands (the session was paid before Stripe expired it).
    await deliver(stripe.pay(s.id));
    expect(await get(req.id)).toMatchObject({ status: 'PAID', display: 'PAID_LATE', paidLate: true });
    expect(await ctx.prisma.notification.count({ where: { type: 'PAYMENT_PAID_LATE', userId: manager.userId } })).toBe(1);
  });

  it('cancels a waiting request (expiring its session), and sends it again after a failed delivery', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    await ctx.prisma.chatMessage.update({ where: { id: row.chatItemId as string }, data: { status: 'FAILED', failureReason: 'test', failedAt: new Date() } });
    expect((await get(req.id)).display).toBe('NOT_DELIVERED');
    const resent = await admin.agent.post(`/api/payments/requests/${req.id}/resend`).set('X-CSRF-Token', admin.csrf).send({});
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    const after = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.chatItemId).not.toBe(row.chatItemId);

    const cancel = await admin.agent.post(`/api/payments/requests/${req.id}/cancel`).set('X-CSRF-Token', admin.csrf).send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ status: 'CANCELLED', display: 'CANCELLED' });
    expect(stripe.sessions.get(session(req.id).id)?.status).toBe('expired');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'payment_request.cancelled', targetId: req.id } })).toBe(1);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'payment.cancelled' } })).toBeGreaterThan(0);
    const again = await admin.agent.post(`/api/payments/requests/${req.id}/cancel`).set('X-CSRF-Token', admin.csrf).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_WAITING');
  });

  it('applies partial and full refunds', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const s = session(req.id);
    await deliver(stripe.pay(s.id));
    await deliver(stripe.refund(s.id, 5000));
    expect(await get(req.id)).toMatchObject({ status: 'PAID', display: 'PARTLY_REFUNDED', refundedMinor: 5000 });
    await deliver(stripe.refund(s.id, 10000));
    expect(await get(req.id)).toMatchObject({ status: 'REFUNDED', display: 'REFUNDED', refundedMinor: 15000 });
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: 'PAYMENT_REFUNDED' } })).toBeGreaterThan(0);
  });

  it('ignores events from the other mode', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    const live = stripe.pay(session(req.id).id);
    const row = await deliver({ ...live, id: `${String(live.id)}_live`, livemode: true });
    expect((await ctx.prisma.paymentEvent.findUniqueOrThrow({ where: { id: row!.id } })).result).toBe('IGNORED');
    expect((await get(req.id)).status).toBe('WAITING');
  });

  it('finds events the webhook missed, and falls back to reading sessions without Events access', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const first = await ask(admin, conversation.id);
    stripe.pay(session(first.id).id); // recorded at Stripe, never delivered
    const reconcile = ctx.app.get(PaymentsReconcileProcessor);
    await reconcile.reconcile();
    const applied = await ctx.prisma.paymentEvent.findFirst({ where: { paymentRequestId: first.id, source: 'RECONCILE' } });
    expect(applied?.result).toBe('APPLIED');
    expect((await get(first.id)).status).toBe('PAID');

    const second = await ask(admin, conversation.id);
    const s = session(second.id);
    s.status = 'complete';
    s.payment_status = 'paid';
    s.payment_intent = 'pi_fallback_1';
    stripe.eventsStatus = 403;
    await ctx.prisma.paymentRequest.update({ where: { id: second.id }, data: { firstOpenedAt: new Date(), sessionExpiresAt: new Date(Date.now() - 20 * 60_000) } });
    await reconcile.reconcile();
    expect((await get(second.id)).status).toBe('PAID');
  });

  it('shows agents a chat’s payments but not the list of all payments', async () => {
    const { conversation, contact } = await seedOpenChat(ctx);
    const req = await ask(admin, conversation.id);
    expect((await agent.agent.get('/api/payments/requests')).status).toBe(403);
    const history = await agent.agent.get(`/api/contacts/${contact.id}/payments`);
    expect(history.status).toBe(200);
    expect(history.body.requests.map((r: Json) => r.id)).toContain(req.id);
    const items = await admin.agent.get(`/api/inbox/conversations/${conversation.id}/items`);
    const item = (items.body.items as Json[]).find((i) => i.contentType === 'PAYMENT_REQUEST');
    expect(item?.payment).toMatchObject({ id: req.id, status: 'WAITING', display: 'WAITING', amountMinor: 15000, currency: 'aed' });
  });
});
