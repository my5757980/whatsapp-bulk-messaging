import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe, STRIPE_TEST_KEY } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 008 contract tests (T024 and later stories): responses match contracts/commerce-api.openapi.yaml.
describe('Commerce API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('commerce-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = admin.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
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
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  describe('US1 gateway', () => {
    it('GET /payments/gateway before and after connecting', async () => {
      await check('get', '/payments/gateway', await call('get', '/payments/gateway'), 200);
      await check('put', '/payments/gateway', await call('put', '/payments/gateway', { secretKey: STRIPE_TEST_KEY, registerEndpoint: true }), 200);
      await check('get', '/payments/gateway', await call('get', '/payments/gateway'), 200);
    });

    it('PUT /payments/gateway refuses a rejected key', async () => {
      stripe.fail('GET', /^\/v1\/account$/, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
      await check('put', '/payments/gateway', await call('put', '/payments/gateway', { secretKey: 'rk_test_wrong00000000001', registerEndpoint: true }), 422);
    });

    it('POST recheck and notification-check, DELETE the connection', async () => {
      await call('put', '/payments/gateway', { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
      await check('post', '/payments/gateway/recheck', await call('post', '/payments/gateway/recheck'), 200);
      await check('post', '/payments/gateway/notification-check', await call('post', '/payments/gateway/notification-check'), 202);
      const res = await call('delete', '/payments/gateway');
      expect(res.status).toBe(204);
      await check('delete', '/payments/gateway', await call('delete', '/payments/gateway'), 404);
    });

    it('GET /payments/settings gives the defaults', async () => {
      await check('get', '/payments/settings', await call('get', '/payments/settings'), 200);
    });
  });

  describe('US2 payment requests', () => {
    const order = { amountMinor: 15000, description: 'Order 1042', reference: 'REF-1042', expiresInMinutes: 120 };
    const route = '/inbox/conversations/{id}/payment-requests';

    beforeEach(async () => {
      await seedGateway(ctx);
      await seedPaymentSettings(ctx);
    });

    it('POST a request: 201, 422 and 409', async () => {
      const { conversation } = await seedOpenChat(ctx);
      await check('post', route, await call('post', `/inbox/conversations/${conversation.id}/payment-requests`, order), 201);
      await check('post', route, await call('post', `/inbox/conversations/${conversation.id}/payment-requests`, { ...order, amountMinor: 100 }), 422);
      const closed = await seedOpenChat(ctx, { minutesAgo: 26 * 60 });
      await check('post', route, await call('post', `/inbox/conversations/${closed.conversation.id}/payment-requests`, order), 409);
    });

    it('GET one request, cancel, resend, and the contact history', async () => {
      const { conversation, contact } = await seedOpenChat(ctx);
      const made = await call('post', `/inbox/conversations/${conversation.id}/payment-requests`, order);
      const id = String(made.body.id);
      await check('get', '/payments/requests/{id}', await call('get', `/payments/requests/${id}`), 200);
      await check('get', '/payments/requests/{id}', await call('get', '/payments/requests/0196f1f0-0000-7000-8000-00000000dead'), 404);
      await check('get', '/contacts/{id}/payments', await call('get', `/contacts/${contact.id}/payments`), 200);
      await check('post', '/payments/requests/{id}/cancel', await call('post', `/payments/requests/${id}/cancel`), 200);
      await check('post', '/payments/requests/{id}/cancel', await call('post', `/payments/requests/${id}/cancel`), 409);
      await check('post', '/payments/requests/{id}/resend', await call('post', `/payments/requests/${id}/resend`), 409);
    });

    it('PUT /payments/settings: 200 and 422', async () => {
      const base = { maxAmountMinor: 500_000, defaultExpiryMinutes: 720, requestRoles: ['ADMIN', 'MANAGER'], sessionText: '{description}: {amount}', buttonText: 'Pay now', templateId: null, templateMapping: {}, reminders: [], chatOrderMode: 'REVIEW', chatOrderExpiryMinutes: 1440, chatOrderTagId: null };
      await check('put', '/payments/settings', await call('put', '/payments/settings', base), 200);
      await check('put', '/payments/settings', await call('put', '/payments/settings', { ...base, buttonText: 'x'.repeat(21) }), 422);
    });

    it('the Stripe webhook: 200 and 400, and the pay link: 302, 200 and 404', async () => {
      const { conversation } = await seedOpenChat(ctx);
      const made = await call('post', `/inbox/conversations/${conversation.id}/payment-requests`, order);
      const code = String(made.body.payUrl).split('/p/')[1];
      const session = stripe.sessionFor(String(made.body.id))!;
      expect((await request(ctx.server()).get(`/l/p/${code}`)).status).toBe(302);
      const paid = stripe.pay(session.id);
      const ok = await stripe.deliver(ctx, paid);
      await check('post', '/payments/stripe/webhook', ok, 200);
      await check('post', '/payments/stripe/webhook', await stripe.deliver(ctx, paid, { secret: 'whsec_wrong0000000000000001' }), 400);
      const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(paid.id) } });
      await ctx.app.get(PaymentEventsProcessor).process(row.id);
      expect((await request(ctx.server()).get(`/l/p/${code}`)).status).toBe(200);
      expect((await request(ctx.server()).get('/l/p/ZZZZZZZZZZ')).status).toBe(404);
    });
  });
});
