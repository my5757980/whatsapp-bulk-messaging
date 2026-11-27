import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T030 (feature 008 US2, FR-006 – FR-009, research R2, R5): requesting a payment in live chat. In the
// window the Checkout Session is made at once with the documented fields and a cta_url message is
// queued with our pay link; outside it the payment template goes through the 001 queue with the code
// in its button. Refusals: limits, roles, a gateway that is not ready, Stripe outages and refusals.

const LINK_BASE = process.env.PUBLIC_LINK_BASE_URL as string;

describe('Payment requests in live chat (008 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let stripe: FakeStripe;

  const request = (who: SignedInAgent, conversationId: string, body: object) =>
    who.agent.post(`/api/inbox/conversations/${conversationId}/payment-requests`).set('X-CSRF-Token', who.csrf).send(body);
  const order = { amountMinor: 15000, description: 'Order 1042', reference: 'REF-1042', expiresInMinutes: 120 };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
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

  it('makes the session at once and queues a Pay now message in the window', async () => {
    const { conversation, contact, number } = await seedOpenChat(ctx);
    const before = Date.now();
    const res = await request(admin, conversation.id, order);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ amountMinor: 15000, currency: 'aed', description: 'Order 1042', reference: 'REF-1042', status: 'WAITING', display: 'WAITING', source: 'INBOX', contactId: contact.id, isTest: true });
    expect(res.body.payUrl).toMatch(new RegExp(`^${LINK_BASE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/p/[A-Za-z0-9]{6,16}$`));
    const code = String(res.body.payUrl).split('/p/')[1];

    // The Checkout Session (contracts/stripe.md §2).
    const [call] = stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/);
    expect(call?.idempotencyKey).toBe(`wbm-pr-${res.body.id}-s1`);
    expect(call?.body).toMatchObject({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'aed',
      'line_items[0][price_data][unit_amount]': '15000',
      'line_items[0][price_data][product_data][name]': 'Order 1042',
      'line_items[0][quantity]': '1',
      client_reference_id: res.body.id,
      'metadata[wbm_payment_request]': res.body.id,
      'payment_intent_data[metadata][wbm_payment_request]': res.body.id,
      'payment_intent_data[description]': 'Order 1042 · REF-1042',
      success_url: `${LINK_BASE}/p/${code}?paid=1`,
      locale: 'auto',
    });
    const expiresAt = Number(call?.body.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor((before + 119 * 60_000) / 1000));
    expect(expiresAt).toBeLessThanOrEqual(Math.floor((Date.now() + 121 * 60_000) / 1000));

    // The Pay now message, on the priority send path.
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.sessionId).toBe(stripe.sessionFor(res.body.id)?.id);
    expect(row.sessionsCreated).toBe(1);
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: row.chatItemId as string } });
    expect(item).toMatchObject({ kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'PAYMENT_REQUEST', status: 'QUEUED', sentByUserId: admin.userId });
    expect(item.text).toContain('Order 1042');
    expect(item.text).toContain('AED 150.00');
    expect(item.payload).toMatchObject({ paymentRequestId: row.id, buttonText: 'Pay now', url: res.body.payUrl });
    const job = await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${item.id}`);
    expect(job).toBeTruthy();

    // The journey.
    const journey = await ctx.prisma.conversationEvent.findFirst({ where: { conversationId: conversation.id, type: 'PAYMENT_REQUESTED' } });
    expect(journey?.data).toMatchObject({ paymentRequestId: row.id, amountMinor: 15000, currency: 'aed' });
  });

  it('uses the payment template with the code in its link button outside the window', async () => {
    const { conversation } = await seedOpenChat(ctx, { minutesAgo: 25 * 60 });
    const closed = await request(admin, conversation.id, order);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('WINDOW_CLOSED_NO_TEMPLATE');

    const chat = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { number: true } });
    const template = await seedTemplate(ctx, chat.number.wabaId, {
      components: [
        { type: 'BODY', text: 'Please pay {{2}} for {{1}}.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: `${LINK_BASE}/p/{{1}}` }] },
      ],
      variables: [{ key: 'BODY.1', example: 'Order' }, { key: 'BODY.2', example: 'AED 1.00' }, { key: 'BUTTON.0.1', example: 'Ab12Cd34' }],
    });
    await seedPaymentSettings(ctx, { templateId: template.id, templateMapping: { 'BODY.1': { source: 'payment', key: 'description' }, 'BODY.2': { source: 'payment', key: 'amount' } } });

    const res = await request(admin, conversation.id, order);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const code = String(res.body.payUrl).split('/p/')[1];
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    const message = await ctx.prisma.message.findUniqueOrThrow({ where: { id: row.messageId as string } });
    expect(message).toMatchObject({ origin: 'PAYMENTS', templateId: template.id, status: 'QUEUED' });
    expect(message.resolvedParams).toEqual({ 'BODY.1': 'Order 1042', 'BODY.2': 'AED 150.00', 'BUTTON.0.1': code });
    const ref = await ctx.prisma.chatMessage.findFirstOrThrow({ where: { messageId: message.id } });
    expect(ref).toMatchObject({ kind: 'MESSAGE_REF', contentType: 'TEMPLATE', conversationId: conversation.id });
  });

  it('refuses amounts, expiries and texts outside the limits', async () => {
    const { conversation } = await seedOpenChat(ctx);
    const cases: Array<[object, string]> = [
      [{ ...order, amountMinor: 199 }, 'AMOUNT_TOO_SMALL'],
      [{ ...order, amountMinor: 1_000_001 }, 'AMOUNT_TOO_LARGE'],
      [{ ...order, expiresInMinutes: 29 }, 'VALIDATION_FAILED'],
      [{ ...order, expiresInMinutes: 43_201 }, 'VALIDATION_FAILED'],
      [{ ...order, description: 'x'.repeat(251) }, 'VALIDATION_FAILED'],
      [{ ...order, reference: 'x'.repeat(81) }, 'VALIDATION_FAILED'],
    ];
    for (const [body, code] of cases) {
      const res = await request(admin, conversation.id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe(code);
    }
    expect(await ctx.prisma.paymentRequest.count()).toBe(0);
    expect(stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/)).toHaveLength(0);
  });

  it('refuses roles the admin left out, and a gateway that is missing or has a problem', async () => {
    const { conversation } = await seedOpenChat(ctx);
    await seedPaymentSettings(ctx, { requestRoles: ['ADMIN', 'MANAGER'] });
    const role = await request(agent, conversation.id, order);
    expect(role.status).toBe(403);
    expect(role.body.code).toBe('ROLE_NOT_ALLOWED');

    await seedGateway(ctx, { status: 'ERROR' });
    expect((await request(admin, conversation.id, order)).body.code).toBe('GATEWAY_NOT_READY');
    await ctx.prisma.paymentGateway.deleteMany();
    const missing = await request(admin, conversation.id, order);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('GATEWAY_NOT_READY');
  });

  it('sends nothing when Stripe is down (502) and reports Stripe’s refusal (422)', async () => {
    const { conversation } = await seedOpenChat(ctx);
    stripe.fail('POST', /^\/v1\/checkout\/sessions$/, 503, undefined, 4);
    const down = await request(admin, conversation.id, order);
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('GATEWAY_UNAVAILABLE');
    expect(await ctx.prisma.paymentRequest.count()).toBe(0);
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: conversation.id, contentType: 'PAYMENT_REQUEST' } })).toBe(0);

    stripe.fail('POST', /^\/v1\/checkout\/sessions$/, 400, { error: { type: 'invalid_request_error', message: 'Invalid currency: aed', param: 'line_items[0][price_data][currency]' } });
    const refused = await request(admin, conversation.id, order);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('GATEWAY_REFUSED');
  });

  it('refuses a payment template without a pay link button in the settings', async () => {
    const { number } = await seedOpenChat(ctx);
    const plain = await seedTemplate(ctx, number.wabaId);
    const res = await admin.agent
      .put('/api/payments/settings')
      .set('X-CSRF-Token', admin.csrf)
      .send({ maxAmountMinor: 1_000_000, defaultExpiryMinutes: 1440, requestRoles: ['ADMIN', 'MANAGER', 'AGENT'], sessionText: '{description}: {amount}', buttonText: 'Pay now', templateId: plain.id, templateMapping: {}, reminders: [], chatOrderMode: 'REVIEW', chatOrderExpiryMinutes: 1440, chatOrderTagId: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_NOT_PAY_LINK');
    expect((await ctx.prisma.auditLog.count({ where: { action: 'payments.settings_changed' } }))).toBe(0);
  });
});
