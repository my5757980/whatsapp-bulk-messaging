import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CatalogService } from '../../src/modules/commerce/catalog/catalog.service.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearCommerce, orderMessage, seedCatalog, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FAKE_CATALOG_ID, FakeCommerceGraph } from '../support/fake-commerce-graph.js';
import { FakeStripe, STRIPE_TEST_KEY } from '../support/fake-stripe.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
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

  describe('US4 reports', () => {
    beforeEach(async () => {
      await seedGateway(ctx);
      await seedPaymentSettings(ctx);
    });

    it('GET /payments/requests, /payments/summary and /payments/export.csv', async () => {
      const zone = (await ctx.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } }))?.defaultTimezone ?? 'UTC';
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const { conversation } = await seedOpenChat(ctx);
      await call('post', `/inbox/conversations/${conversation.id}/payment-requests`, { amountMinor: 15000, description: 'Order 1042' });
      await check('get', '/payments/requests', await call('get', '/payments/requests?status=WAITING&includeTest=true'), 200);
      await check('get', '/payments/summary', await call('get', `/payments/summary?from=${day}&to=${day}`), 200);
      await check('get', '/payments/summary', await call('get', '/payments/summary?from=2026-11-20&to=2026-11-01'), 422);
      const csv = await call('get', `/payments/export.csv?from=${day}&to=${day}`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
    });
  });

  describe('US5 catalog', () => {
    it('the catalog routes and product messages', async () => {
      new FakeCommerceGraph(40).install();
      const number = await seedNumber(ctx);
      await check('get', '/catalog/connection', await call('get', '/catalog/connection'), 200);
      await check('post', '/catalog/connection', await call('post', '/catalog/connection', { catalogId: '123456789012' }), 422);
      await check('post', '/catalog/connection', await call('post', '/catalog/connection', { catalogId: FAKE_CATALOG_ID }), 201);
      await check('post', '/catalog/connection', await call('post', '/catalog/connection', { catalogId: FAKE_CATALOG_ID }), 409);
      await check('post', '/catalog/sync', await call('post', '/catalog/sync'), 409);
      await ctx.app.get(CatalogService).copy();
      await check('post', '/catalog/sync', await call('post', '/catalog/sync'), 202);
      await ctx.app.get(CatalogService).copy();
      await check('put', '/catalog/numbers/{id}/commerce-settings', await call('put', `/catalog/numbers/${number.id}/commerce-settings`, { cartEnabled: true, catalogVisible: true }), 200);
      await check('put', '/catalog/fill', await call('put', '/catalog/fill', { enabled: true, storeId: null }), 409);
      await check('post', '/catalog/fill/run', await call('post', '/catalog/fill/run'), 409);
      await check('get', '/catalog/products', await call('get', '/catalog/products?search=Product&pageSize=5'), 200);
      const { conversation } = await seedOpenChat(ctx, { numberId: number.id });
      const route = '/inbox/conversations/{id}/products';
      await check('post', route, await call('post', `/inbox/conversations/${conversation.id}/products`, { kind: 'product', retailerId: 'shp-101' }), 201);
      await check('post', route, await call('post', `/inbox/conversations/${conversation.id}/products`, { kind: 'product', retailerId: 'shp-103' }), 422);
      await check('delete', '/catalog/connection', await call('delete', '/catalog/connection'), 204);
      await check('delete', '/catalog/connection', await call('delete', '/catalog/connection'), 404);
      await check('get', '/catalog/products', await call('get', '/catalog/products'), 409);
    });
  });

  describe('US6 chat orders', () => {
    it('list, read, edit, send the link and cancel', async () => {
      await seedGateway(ctx);
      await seedPaymentSettings(ctx, { chatOrderMode: 'REVIEW' });
      await seedCatalog(ctx, { count: 3 });
      const number = await seedNumber(ctx);
      await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, orderMessage(number.phoneNumberId, `97150${Date.now().toString().slice(-7)}`, [{ retailerId: 'shp-101', quantity: 2, price: 51 }, { retailerId: 'shp-102', quantity: 1, price: 52 }])));
      const order = await ctx.prisma.chatOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      await check('get', '/chat-orders', await call('get', '/chat-orders?status=RECEIVED'), 200);
      await check('get', '/chat-orders/{id}', await call('get', `/chat-orders/${order.id}`), 200);
      await check('get', '/chat-orders/{id}', await call('get', '/chat-orders/0196f1f0-0000-7000-8000-00000000dead'), 404);
      await check('patch', '/chat-orders/{id}', await call('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-101', quantity: 1 }] }), 200);
      await check('patch', '/chat-orders/{id}', await call('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-999', quantity: 1 }] }), 422);
      await check('post', '/chat-orders/{id}/send-link', await call('post', `/chat-orders/${order.id}/send-link`), 201);
      await check('patch', '/chat-orders/{id}', await call('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-101', quantity: 2 }] }), 409);
      await check('post', '/chat-orders/{id}/cancel', await call('post', `/chat-orders/${order.id}/cancel`), 200);
      await check('post', '/chat-orders/{id}/cancel', await call('post', `/chat-orders/${order.id}/cancel`), 409);
    });
  });

  describe('US7 forms', () => {
    it('the forms routes and sending a form', async () => {
      new FakeCommerceGraph(0).install();
      const number = await seedNumber(ctx);
      const name = `Contract form ${Date.now()}`;
      const made = await call('post', '/forms', { name, category: 'SIGN_UP' });
      await check('post', '/forms', made, 201);
      await check('post', '/forms', await call('post', '/forms', { name, category: 'SIGN_UP' }), 409);
      const id = String(made.body.id);
      const draft = { screens: [{ title: 'Join', button: 'Submit', fields: [{ key: 'name', type: 'shortText', label: 'Name', required: true }] }] };
      await check('put', '/forms/{id}', await call('put', `/forms/${id}`, { name, category: 'SIGN_UP', draft, mapping: [], tagIds: [] }), 200);
      await check('get', '/forms/{id}', await call('get', `/forms/${id}`), 200);
      await check('post', '/forms/{id}/check', await call('post', `/forms/${id}/check`), 200);
      await check('post', '/forms/{id}/publish', await call('post', `/forms/${id}/publish`), 201);
      await check('post', '/forms/{id}/publish', await call('post', `/forms/${id}/publish`), 409);
      await check('get', '/forms', await call('get', '/forms'), 200);
      const { conversation } = await seedOpenChat(ctx, { numberId: number.id });
      await check('post', '/inbox/conversations/{id}/forms', await call('post', `/inbox/conversations/${conversation.id}/forms`, { formId: id, body: 'Join us', cta: 'Join' }), 201);
      const closed = await seedOpenChat(ctx, { numberId: number.id, minutesAgo: 25 * 60 });
      await check('post', '/inbox/conversations/{id}/forms', await call('post', `/inbox/conversations/${closed.conversation.id}/forms`, { formId: id, body: 'Join us', cta: 'Join' }), 409);
      await check('get', '/forms/{id}/answers', await call('get', `/forms/${id}/answers`), 200);
      await check('delete', '/forms/{id}', await call('delete', `/forms/${id}`), 409);
      await check('post', '/forms/{id}/archive', await call('post', `/forms/${id}/archive`), 200);
      await check('get', '/forms/{id}', await call('get', '/forms/0196f1f0-0000-7000-8000-00000000dead'), 404);
    });
  });

  describe('US3 test results', () => {
    beforeEach(async () => {
      await seedGateway(ctx);
      await seedPaymentSettings(ctx);
    });

    it('POST /payments/requests/{id}/test-result: 200, 409 and 404', async () => {
      const { contact, conversation } = await seedOpenChat(ctx);
      const base = { contactId: contact.id, conversationId: conversation.id, amountMinor: 9900n, currency: 'aed', description: 'Test booking', expiresAt: new Date(Date.now() + 3_600_000), status: 'WAITING' as const };
      const test = await ctx.prisma.paymentRequest.create({ data: { ...base, code: 'TstRes0001', source: 'FLOW', isTest: true } });
      const real = await ctx.prisma.paymentRequest.create({ data: { ...base, code: 'TstRes0002', source: 'INBOX', isTest: false } });
      const route = '/payments/requests/{id}/test-result';
      await check('post', route, await call('post', `/payments/requests/${test.id}/test-result`, { result: 'notPaid' }), 200);
      await check('post', route, await call('post', `/payments/requests/${test.id}/test-result`, { result: 'paid' }), 409);
      await check('post', route, await call('post', `/payments/requests/${real.id}/test-result`, { result: 'paid' }), 409);
      await check('post', route, await call('post', '/payments/requests/0196f1f0-0000-7000-8000-00000000dead/test-result', { result: 'paid' }), 404);
    });
  });
});
