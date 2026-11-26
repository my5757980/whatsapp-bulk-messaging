import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T047 (feature 008 US3, FR-010, FR-015, contracts/public-payments-v1.openapi.yaml): payment requests
// through the public API: made and sent (in the window or not sent), the same Idempotency-Key giving the
// same answer and a different body refused, scopes, reading by id, reference and phone, cancelling, and
// the outbound events.

describe('Public payments API (008 US3)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;
  let writeKey: string;
  let readKey: string;
  let sendOnlyKey: string;

  const post = (key: string, url: string, body: object, idem?: string) => {
    const req = request(ctx.server()).post(`/api/v1${url}`).set('Authorization', `Bearer ${key}`);
    return (idem ? req.set('Idempotency-Key', idem) : req).send(body);
  };
  const get = (key: string, url: string) => request(ctx.server()).get(`/api/v1${url}`).set('Authorization', `Bearer ${key}`);
  const makeKey = async (scopes: string[]) => {
    const res = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Pay key '), rateLimitPerMinute: 600 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const scoped = await admin.agent.put(`/api/api-keys/${res.body.id}/scopes`).set('X-CSRF-Token', admin.csrf).send({ scopes });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    return String(res.body.secret);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    writeKey = await makeKey(['payments.write', 'payments.read']);
    readKey = await makeKey(['payments.read']);
    sendOnlyKey = await makeKey(['messages.send']);
    const endpoint = await admin.agent.post('/api/webhook-endpoints').set('X-CSRF-Token', admin.csrf).send({ name: uniq('API pay hook '), url: `https://${uniq('apipay')}.example.test/hooks`, eventTypes: ['payment.requested', 'payment.paid'] });
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

  it('makes and sends a request in the window, once per Idempotency-Key', async () => {
    const { contact } = await seedOpenChat(ctx);
    const body = { phone: contact.phoneE164, amountMinor: 25000, description: 'Invoice 77', reference: 'INV-77' };
    const idem = uniq('idem-');
    const res = await post(writeKey, '/payments', body, idem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ contactId: contact.id, amountMinor: 25000, currency: 'aed', status: 'WAITING', reference: 'INV-77', test: true });
    const items = await ctx.prisma.chatMessage.count({ where: { contentType: 'PAYMENT_REQUEST', conversation: { contactId: contact.id } } });
    expect(items).toBe(1);

    const again = await post(writeKey, '/payments', body, idem);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(res.body.id);
    expect(await ctx.prisma.paymentRequest.count({ where: { reference: 'INV-77' } })).toBe(1);
    const changed = await post(writeKey, '/payments', { ...body, amountMinor: 1 }, idem);
    expect(changed.status).toBe(409);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'payment.requested' } })).toBeGreaterThan(0);
  });

  it('makes a new contact and returns only the link when send is false', async () => {
    const phone = uaePhone();
    const res = await post(writeKey, '/payments', { phone, name: 'Omar', amountMinor: 9900, description: 'Deposit', send: false }, uniq('idem-'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.payUrl).toMatch(/\/p\/[A-Za-z0-9]{10}$/);
    expect(await ctx.prisma.contact.count({ where: { phoneE164: phone } })).toBe(1);
    expect(await ctx.prisma.message.count({ where: { phoneE164: phone } })).toBe(0);
  });

  it('needs the scopes and an Idempotency-Key', async () => {
    const { contact } = await seedOpenChat(ctx);
    const body = { phone: contact.phoneE164, amountMinor: 9900, description: 'Deposit' };
    expect((await post(readKey, '/payments', body, uniq('idem-'))).status).toBe(403);
    expect((await post(sendOnlyKey, '/payments', body, uniq('idem-'))).status).toBe(403);
    expect((await post(writeKey, '/payments', body)).status).toBe(400);
    expect((await get(sendOnlyKey, '/payments?reference=x')).status).toBe(403);
  });

  it('reads requests by id, reference and phone, cancels them, and reports the payment', async () => {
    const { contact } = await seedOpenChat(ctx);
    const made = await post(writeKey, '/payments', { phone: contact.phoneE164, amountMinor: 12000, description: 'Order', reference: 'ORD-9' }, uniq('idem-'));
    const id = String(made.body.id);
    expect((await get(readKey, `/payments/${id}`)).body).toMatchObject({ id, status: 'WAITING' });
    expect((await get(readKey, '/payments/not-a-uuid')).status).toBe(404);
    const byRef = await get(readKey, '/payments?reference=ORD-9');
    expect(byRef.body.data.map((p: { id: string }) => p.id)).toEqual([id]);
    const byPhone = await get(readKey, `/payments?phone=${encodeURIComponent(contact.phoneE164)}`);
    expect(byPhone.body.data.map((p: { id: string }) => p.id)).toContain(id);

    const event = stripe.pay(stripe.sessionFor(id)!.id);
    await stripe.deliver(ctx, event);
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
    expect((await get(readKey, `/payments/${id}`)).body.status).toBe('PAID');
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'payment.paid' } })).toBeGreaterThan(0);
    const cancelPaid = await post(writeKey, `/payments/${id}/cancel`, {}, uniq('idem-'));
    expect(cancelPaid.status).toBe(409);

    const second = await post(writeKey, '/payments', { phone: contact.phoneE164, amountMinor: 3000, description: 'Extra' }, uniq('idem-'));
    const cancelled = await post(writeKey, `/payments/${String(second.body.id)}/cancel`, {}, uniq('idem-'));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});
