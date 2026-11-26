import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { CodService } from '../../src/modules/integrations/stores/cod.service.js';
import { StoreEventsProcessor } from '../../src/modules/integrations/stores/store-events.processor.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { clearCommerce, seedGateway, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T046, store orders (feature 008 US3, FR-011, research R5): the PAY_LINK automation sends an UNPAID
// order its Pay now link once (a COD order only with includeCod; another currency gets no link), and a
// paid link shows the order paid, closes a waiting COD question and marks the order paid in the store
// (Shopify orderMarkAsPaid, WooCommerce set_paid); a store refusal is only a warning.

const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10';
const SECRET = 'shopify-client-secret-for-tests';
type Json = Record<string, unknown>;

describe('Store order pay links (008 US3)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let payTemplateId: string;
  let n = 500;

  const dashboard = (method: 'get' | 'post' | 'put', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});

  /** A fake Shopify shop on nock; `refuse` makes orderMarkAsPaid answer with a user error. */
  function fakeShop(host: string, refuse = false) {
    const markedPaid: string[] = [];
    nock(host).persist().post('/admin/oauth/access_token').reply(200, { access_token: 'shpat_pay', expires_in: 86399 });
    nock(host)
      .persist()
      .post(`/admin/api/${VERSION}/graphql.json`)
      .reply(async (req: Request) => {
        const { query, variables = {} } = (await req.json()) as { query: string; variables?: Json };
        if (query.includes('orderMarkAsPaid')) {
          if (refuse) return [200, { data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ['id'], message: 'Order cannot be marked as paid' }] } } }];
          markedPaid.push(String((variables.input as Json).id));
          return [200, { data: { orderMarkAsPaid: { order: { id: (variables.input as Json).id, displayFinancialStatus: 'PAID' }, userErrors: [] } } }];
        }
        if (query.includes('webhookSubscriptionCreate')) return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: randomUUID() }, userErrors: [] } } }];
        if (query.includes('webhookSubscriptions')) return [200, { data: { webhookSubscriptions: { nodes: [] } } }];
        if (query.includes('tagsAdd')) return [200, { data: { tagsAdd: { node: { id: variables.id }, userErrors: [] } } }];
        if (query.includes('metafieldsSet')) return [200, { data: { metafieldsSet: { metafields: [], userErrors: [] } } }];
        if (query.includes('shop')) return [200, { data: { shop: { name: 'Pay Shop' } } }];
        return [200, { errors: [{ message: 'not faked' }] }];
      });
    return { markedPaid };
  }

  async function shopifyStore(settings: Json, refuse = false) {
    const host = `https://${uniq('pay-')}.myshopify.com`;
    const shop = fakeShop(host, refuse);
    const res = await dashboard('post', '/stores', { platform: 'SHOPIFY', baseUrl: host, numberId: number.id, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cid', clientSecret: SECRET } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const step = { templateId: payTemplateId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' }, 'BODY.2': { source: 'order', key: 'total' } } };
    const saved = await dashboard('put', `/stores/${res.body.id}/automations/PAY_LINK`, { enabled: true, steps: [step], settings });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.problems).toEqual([]);
    return { id: res.body.id as string, shop };
  }

  function shopifyOrder(phone: string, over: Json = {}): Json {
    n += 1;
    const now = new Date().toISOString();
    return {
      id: 70_000 + n,
      admin_graphql_api_id: `gid://shopify/Order/${70_000 + n}`,
      name: `#${n}`,
      total_price: '199.00',
      currency: 'AED',
      financial_status: 'pending',
      cancelled_at: null,
      created_at: now,
      updated_at: now,
      payment_gateway_names: ['manual'],
      customer: { first_name: 'Layla', last_name: 'Customer', phone: null },
      shipping_address: { first_name: 'Layla', last_name: 'Customer', phone },
      line_items: [{ title: 'Shoes', quantity: 1 }],
      fulfillments: [],
      ...over,
    };
  }

  async function deliverShopify(storeId: string, payload: Json) {
    const raw = JSON.stringify(payload);
    const res = await request(ctx.server())
      .post(`/api/integrations/shopify/${storeId}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-shopify-topic', 'orders/create')
      .set('x-shopify-webhook-id', randomUUID())
      .set('x-shopify-hmac-sha256', createHmac('sha256', SECRET).update(raw).digest('base64'))
      .send(raw);
    expect(res.status).toBe(200);
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId, status: 'RECEIVED' }, orderBy: { id: 'asc' } })) await ctx.app.get(StoreEventsProcessor).process(event.id);
    return ctx.prisma.storeOrder.findFirstOrThrow({ where: { storeId, externalId: String(payload.admin_graphql_api_id ?? payload.id) } }).catch(() =>
      ctx.prisma.storeOrder.findFirstOrThrow({ where: { storeId, orderNumber: String(payload.name ?? payload.number) } }),
    );
  }

  const payLinkOf = (orderId: string) => ctx.prisma.storeOrderMessage.findFirst({ where: { orderId, kind: 'PAY_LINK' }, include: { message: true } });

  async function pay(requestId: string) {
    const event = stripe.pay(stripe.sessionFor(requestId)!.id);
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
  }

  async function markPaidJobs(orderId: string) {
    const jobs = await ctx.app.get(QueueRegistry).get(QUEUES.STORES).getJobs(['waiting', 'delayed', 'prioritized']);
    const mine = jobs.filter((j) => j.name === 'store-mark-paid' && (j.data as { orderId: string }).orderId === orderId);
    for (const job of mine) {
      await ctx.app.get(CodService).markPaid(orderId);
      await job.remove();
    }
    return mine.length;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    const base = process.env.PUBLIC_LINK_BASE_URL as string;
    payTemplateId = (
      await seedTemplate(ctx, number.wabaId, {
        components: [
          { type: 'BODY', text: 'Order {{1}} comes to {{2}}. Pay online:', example: { body_text: [['#1001', '199.00 AED']] } },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: `${base}/p/{{1}}`, example: [`${base}/p/AbCdEf1234`] }] },
        ],
        variables: [
          { key: 'BODY.1', example: '#1001' },
          { key: 'BODY.2', example: '199.00 AED' },
          { key: 'BUTTON.0.1', example: 'AbCdEf1234' },
        ],
      })
    ).id;
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

  it('refuses a PAY_LINK template without a pay link button', async () => {
    const { id } = await shopifyStore({ includeCod: false });
    const plain = await seedTemplate(ctx, number.wabaId);
    const res = await dashboard('put', `/stores/${id}/automations/PAY_LINK`, { enabled: true, steps: [{ templateId: plain.id, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/URL button/);
    expect((await dashboard('put', `/stores/${id}/automations/PAY_LINK`, { enabled: false, steps: [{ templateId: payTemplateId, variableMapping: {} }], settings: { autoCancel: true } })).status).toBe(422);
  });

  it('sends an unpaid order its link once, and a paid link shows the order paid and marks it paid in Shopify', async () => {
    const { id, shop } = await shopifyStore({ includeCod: false, expiryMinutes: 600 });
    const order = await deliverShopify(id, shopifyOrder(uaePhone()));
    const sent = await payLinkOf(order.id);
    expect(sent?.outcome).toBe('QUEUED');
    const requestRow = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { storeOrderId: order.id } });
    expect(requestRow).toMatchObject({ source: 'STORE_ORDER', status: 'WAITING', amountMinor: 19900n, currency: 'aed', reference: order.orderNumber, messageId: sent?.messageId });
    expect((sent?.message?.resolvedParams as Record<string, string>)['BUTTON.0.1']).toBe(requestRow.code);
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentRequestId).toBe(requestRow.id);

    // The same order again: no second link.
    await deliverShopify(id, { ...shopifyOrder(uaePhone()), id: Number(order.externalId.split('/').pop()), admin_graphql_api_id: order.externalId, name: order.orderNumber, updated_at: new Date(Date.now() + 1000).toISOString() });
    expect(await ctx.prisma.paymentRequest.count({ where: { storeOrderId: order.id } })).toBe(1);

    await pay(requestRow.id);
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).paidViaLinkAt).not.toBeNull();
    expect(await markPaidJobs(order.id)).toBe(1);
    expect(shop.markedPaid).toEqual([order.externalId]);
  });

  it('sends COD orders a link only with includeCod, and closes the waiting COD question when paid', async () => {
    const without = await shopifyStore({ includeCod: false });
    const codWithout = await deliverShopify(without.id, shopifyOrder(uaePhone(), { payment_gateway_names: ['Cash on Delivery (COD)'] }));
    expect(await payLinkOf(codWithout.id)).toMatchObject({ outcome: 'SKIPPED', skipReason: 'cod' });

    const withCod = await shopifyStore({ includeCod: true });
    const cod = await deliverShopify(withCod.id, shopifyOrder(uaePhone(), { payment_gateway_names: ['Cash on Delivery (COD)'] }));
    expect((await payLinkOf(cod.id))?.outcome).toBe('QUEUED');
    await ctx.prisma.storeOrder.update({ where: { id: cod.id }, data: { codStatus: 'ASKED', codAskedAt: new Date() } });
    const requestRow = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { storeOrderId: cod.id } });
    await pay(requestRow.id);
    expect(await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: cod.id } })).toMatchObject({ codStatus: 'CLOSED' });
  });

  it('gives no link for another currency, and keeps a store refusal as a warning', async () => {
    const { id } = await shopifyStore({ includeCod: false }, true);
    const usd = await deliverShopify(id, shopifyOrder(uaePhone(), { currency: 'USD' }));
    expect(await payLinkOf(usd.id)).toMatchObject({ outcome: 'SKIPPED', skipReason: 'currency_mismatch' });
    expect(await ctx.prisma.paymentRequest.count({ where: { storeOrderId: usd.id } })).toBe(0);

    const order = await deliverShopify(id, shopifyOrder(uaePhone()));
    const requestRow = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { storeOrderId: order.id } });
    await pay(requestRow.id);
    expect(await markPaidJobs(order.id)).toBe(1);
    const store = await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id } });
    expect(store.lastError).toMatch(/did not mark it paid/);
    expect(store.status).toBe('CONNECTED');
  });

  it('marks a paid WooCommerce order paid with set_paid', async () => {
    const host = `https://${uniq('woo-pay-')}.example.test`;
    const hooks: Array<{ secret: string }> = [];
    const updates: Json[] = [];
    nock(host).persist().get('/wp-json/').reply(200, { name: 'Woo Pay' });
    nock(host).persist().get('/wp-json/wc/v3/orders').query(true).reply(200, []);
    nock(host).persist().get('/wp-json/wc/v3/webhooks').query(true).reply(200, []);
    nock(host)
      .persist()
      .post('/wp-json/wc/v3/webhooks')
      .reply(async (req: Request) => {
        hooks.push((await req.json()) as { secret: string });
        return [201, { id: hooks.length, status: 'active' }];
      });
    nock(host)
      .persist()
      .put(/\/wp-json\/wc\/v3\/orders\/\d+/)
      .reply(async (req: Request) => {
        updates.push((await req.json()) as Json);
        return [200, { id: 1 }];
      });
    const res = await dashboard('post', '/stores', { platform: 'WOOCOMMERCE', baseUrl: host, numberId: number.id, defaultCountry: 'AE', customerTag: 'woo', credentials: { consumerKey: 'ck_test_0123456789abcdef', consumerSecret: 'cs_test_0123456789abcdef' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const step = { templateId: payTemplateId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' }, 'BODY.2': { source: 'order', key: 'total' } } };
    expect((await dashboard('put', `/stores/${res.body.id}/automations/PAY_LINK`, { enabled: true, steps: [step], settings: { includeCod: true } })).status).toBe(200);
    const gmt = new Date().toISOString().slice(0, 19);
    const cod = { id: 4242, number: '4242', status: 'processing', currency: 'AED', total: '75.00', payment_method: 'cod', date_created_gmt: gmt, date_modified_gmt: gmt, date_paid_gmt: null, billing: { phone: uaePhone() }, shipping: {}, line_items: [{ name: 'Cap', quantity: 1 }], meta_data: [] };
    const raw = JSON.stringify(cod);
    const sent = await request(ctx.server())
      .post(`/api/integrations/woocommerce/${res.body.id}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-wc-webhook-topic', 'order.created')
      .set('x-wc-webhook-delivery-id', randomUUID())
      .set('x-wc-webhook-signature', createHmac('sha256', hooks[0]!.secret).update(raw).digest('base64'))
      .send(raw);
    expect(sent.status).toBe(200);
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId: res.body.id, status: 'RECEIVED' } })) await ctx.app.get(StoreEventsProcessor).process(event.id);
    const order = await ctx.prisma.storeOrder.findFirstOrThrow({ where: { storeId: res.body.id, externalId: '4242' } });
    const requestRow = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { storeOrderId: order.id } });
    expect(Number(requestRow.amountMinor)).toBe(7500);
    await pay(requestRow.id);
    expect(await markPaidJobs(order.id)).toBe(1);
    expect(updates).toContainEqual({ set_paid: true });
  });
});
