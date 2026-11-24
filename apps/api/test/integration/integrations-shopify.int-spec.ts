import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StoreEventsProcessor } from '../../src/modules/integrations/stores/store-events.processor.js';
import { StoreReconcilerProcessor } from '../../src/modules/integrations/stores/store-reconciler.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T044 (feature 006 US4, FR-023 - FR-033, research R7 and R9): a Shopify store from connection to
// order notifications, with a fake Admin API on nock.

const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10';
const SECRET = 'shopify-client-secret-for-tests';
type Json = Record<string, unknown>;

interface FakeShop {
  host: string;
  tokens: number;
  down: boolean;
  subscriptions: Array<{ id: string; topic: string; uri: string }>;
  orders: Map<string, Json>;
}

/** A REST order as Shopify sends it in webhooks. */
function restOrder(n: number, over: Json = {}): Json {
  const now = new Date().toISOString();
  return {
    id: 7000 + n,
    admin_graphql_api_id: `gid://shopify/Order/${7000 + n}`,
    name: `#${n}`,
    total_price: '120.00',
    currency: 'AED',
    financial_status: 'paid',
    fulfillment_status: null,
    cancelled_at: null,
    created_at: now,
    updated_at: now,
    payment_gateway_names: ['shopify_payments'],
    buyer_accepts_marketing: false,
    customer: { first_name: 'Layla', last_name: 'Customer', phone: null },
    shipping_address: { first_name: 'Layla', last_name: 'Customer', phone: uaePhone() },
    billing_address: null,
    line_items: [{ title: 'Shoes', quantity: 1 }],
    fulfillments: [],
    ...over,
  };
}

/** The same order as the GraphQL Admin API returns it. */
function graphOrder(rest: Json): Json {
  const shipping = rest.shipping_address as Json | null;
  const customer = rest.customer as Json | null;
  return {
    id: rest.admin_graphql_api_id,
    name: rest.name,
    createdAt: rest.created_at,
    updatedAt: rest.updated_at,
    cancelledAt: rest.cancelled_at,
    displayFinancialStatus: String(rest.financial_status).toUpperCase(),
    paymentGatewayNames: rest.payment_gateway_names,
    customerAcceptsMarketing: rest.buyer_accepts_marketing,
    currentTotalPriceSet: { shopMoney: { amount: rest.total_price, currencyCode: rest.currency } },
    customer: customer ? { firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone } : null,
    shippingAddress: shipping ? { firstName: shipping.first_name, lastName: shipping.last_name, phone: shipping.phone } : null,
    billingAddress: null,
    lineItems: { nodes: [{ title: 'Shoes', quantity: 1 }] },
    fulfillments: ((rest.fulfillments as Json[]) ?? []).map((f) => ({
      trackingInfo: [{ number: f.tracking_number, url: f.tracking_url }],
      displayStatus: f.shipment_status === 'delivered' ? 'DELIVERED' : 'IN_TRANSIT',
    })),
  };
}

function fakeShop(host: string): FakeShop {
  const shop: FakeShop = { host, tokens: 0, down: false, subscriptions: [], orders: new Map() };
  nock(host)
    .persist()
    .post('/admin/oauth/access_token')
    .reply(async (request: Request) => {
      const b = (await request.json()) as Json;
      if (shop.down || b.client_secret !== SECRET || b.grant_type !== 'client_credentials') return [401, { error: 'invalid_client' }];
      shop.tokens += 1;
      return [200, { access_token: `shpat_test_${shop.tokens}`, scope: 'read_orders,write_orders,read_customers', expires_in: 86399 }];
    });
  nock(host)
    .persist()
    .post(`/admin/api/${VERSION}/graphql.json`)
    .reply(async (request: Request) => {
      if (shop.down) return [401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' }];
      const { query, variables = {} } = (await request.json()) as { query: string; variables?: Json };
      if (query.includes('webhookSubscriptionCreate')) {
        const sub = { id: `gid://shopify/WebhookSubscription/${shop.subscriptions.length + 1}${Date.now()}`, topic: String(variables.topic), uri: String((variables.webhookSubscription as Json).uri) };
        shop.subscriptions.push(sub);
        return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: sub, userErrors: [] } } }];
      }
      if (query.includes('webhookSubscriptionDelete')) {
        shop.subscriptions = shop.subscriptions.filter((s) => s.id !== variables.id);
        return [200, { data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] } } }];
      }
      if (query.includes('webhookSubscriptions')) return [200, { data: { webhookSubscriptions: { nodes: shop.subscriptions } } }];
      if (query.includes('order(id')) return [200, { data: { order: shop.orders.get(String(variables.id)) ?? null } }];
      if (query.includes('orders(')) return [200, { data: { orders: { nodes: [...shop.orders.values()], pageInfo: { hasNextPage: false, endCursor: null } } } }];
      if (query.includes('shop')) return [200, { data: { shop: { name: 'Test Shop', currencyCode: 'AED', myshopifyDomain: host.replace('https://', '') } } }];
      return [200, { errors: [{ message: `fake shop cannot answer: ${query.slice(0, 60)}` }] }];
    });
  return shop;
}

describe('Shopify stores (006 US4)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let numberId: string;
  let confirmTemplate: string;
  let trackTemplate: string;
  let processor: StoreEventsProcessor;
  let reconciler: StoreReconcilerProcessor;
  const made: string[] = [];

  const dashboard = (method: 'get' | 'post' | 'patch' | 'put', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});
  const host = () => `https://${uniq('shop-')}.myshopify.com`;

  async function connect(shopHost: string, extra: Json = {}) {
    const res = await dashboard('post', '/stores', {
      platform: 'SHOPIFY',
      baseUrl: shopHost,
      numberId,
      defaultCountry: 'AE',
      customerTag: 'shopify',
      credentials: { clientId: 'client-1', clientSecret: SECRET },
      ...extra,
    });
    if (res.status === 201) made.push(res.body.id as string);
    return res;
  }

  /** Sends a webhook to the receiver, signed like Shopify (or with another secret). */
  function deliver(storeId: string, topic: string, payload: Json, webhookId: string = randomUUID(), secret = SECRET) {
    const raw = JSON.stringify(payload);
    return request(ctx.server())
      .post(`/api/integrations/shopify/${storeId}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-shopify-topic', topic)
      .set('x-shopify-webhook-id', webhookId)
      .set('x-shopify-hmac-sha256', createHmac('sha256', secret).update(raw).digest('base64'))
      .send(raw);
  }

  async function processAll(storeId: string): Promise<void> {
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId, status: 'RECEIVED' }, orderBy: { id: 'asc' } })) await processor.process(event.id);
  }

  const enable = (storeId: string, kind: string, templateId: string, key: string) =>
    dashboard('put', `/stores/${storeId}/automations/${kind}`, { enabled: true, steps: [{ templateId, variableMapping: { 'BODY.1': { source: 'order', key } } }] });

  const outcomes = async (storeId: string, kind: string) =>
    (await ctx.prisma.storeOrderMessage.findMany({ where: { kind: kind as never, order: { storeId } }, include: { order: true } })).map((m) => ({ order: m.order.orderNumber, outcome: m.outcome, reason: m.skipReason }));

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    numberId = number.id;
    const body = (text: string) => ({ components: [{ type: 'BODY', text }], variables: [{ key: 'BODY.1', example: '#1001' }] });
    confirmTemplate = (await seedTemplate(ctx, number.wabaId, body('Your order {{1}} is confirmed'))).id;
    trackTemplate = (await seedTemplate(ctx, number.wabaId, body('On its way: {{1}}'))).id;
    processor = ctx.app.get(StoreEventsProcessor);
    reconciler = ctx.app.get(StoreReconcilerProcessor);
  });

  // At most 5 stores may be connected: each test's stores are set aside after it.
  afterEach(async () => {
    nock.cleanAll();
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: made } }, data: { status: 'DISCONNECTED' } });
  });

  afterAll(async () => {
    // At most 5 stores may be connected; leave the slots to the other test files.
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: made } }, data: { status: 'DISCONNECTED' } });
    restoreNetwork();
    await ctx.close();
  });

  it('connects with the client credentials grant, creates its webhooks and never shows the credentials', async () => {
    const shopHost = host();
    const shop = fakeShop(shopHost);
    const res = await connect(shopHost);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ platform: 'SHOPIFY', name: 'Test Shop', baseUrl: shopHost, status: 'CONNECTED', consentIsWhatsapp: false, customerTag: 'shopify' });
    expect(res.body.automations).toHaveLength(6);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify((await dashboard('get', `/stores/${res.body.id}`)).body)).not.toContain('shpat_');
    expect(shop.subscriptions.map((s) => s.topic).sort()).toEqual(
      ['CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'ORDERS_CANCELLED', 'ORDERS_CREATE', 'ORDERS_UPDATED'].sort(),
    );
    expect(shop.subscriptions.every((s) => s.uri.endsWith(`/api/integrations/shopify/${res.body.id}/webhooks`))).toBe(true);
    const row = await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.credentialsEncrypted).not.toContain(SECRET);
    expect(row.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'store.connected', targetId: res.body.id } })).toBe(1);

    const again = await connect(shopHost);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('STORE_EXISTS');
    const wrongHost = host();
    fakeShop(wrongHost);
    const refused = await connect(wrongHost, { credentials: { clientId: 'client-1', clientSecret: 'wrong' } });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('STORE_ACCESS_FAILED');
    expect((await connect(host(), { baseUrl: 'http://plain.example.test' })).status).toBe(422);
  });

  it('allows at most 5 connected stores', async () => {
    const active = await ctx.prisma.storeConnection.count({ where: { status: { not: 'DISCONNECTED' } } });
    const extra: string[] = [];
    for (let i = active; i < 5; i += 1) {
      const h = host();
      fakeShop(h);
      const res = await connect(h);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      extra.push(res.body.id as string);
    }
    const h = host();
    fakeShop(h);
    const over = await connect(h);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('TOO_MANY_STORES');
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: extra } }, data: { status: 'DISCONNECTED' } });
  });

  it('checks the signature before anything else and ignores a repeated delivery', async () => {
    const shopHost = host();
    fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    expect((await deliver(store.id, 'orders/create', restOrder(1), randomUUID(), 'not-the-secret')).status).toBe(401);
    expect(await ctx.prisma.storeEvent.count({ where: { storeId: store.id } })).toBe(0);
    expect((await deliver(randomUUID(), 'orders/create', restOrder(1))).status).toBe(404);
    const id = randomUUID();
    expect((await deliver(store.id, 'orders/create', restOrder(1), id)).status).toBe(200);
    expect((await deliver(store.id, 'orders/create', restOrder(1), id)).status).toBe(200);
    expect(await ctx.prisma.storeEvent.count({ where: { storeId: store.id } })).toBe(1);
    expect((await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } })).lastEventAt).not.toBeNull();
  });

  it('sends Order confirmed once per order, and skips no phone, opted out and stale orders with reasons', async () => {
    const shopHost = host();
    fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    expect((await enable(store.id, 'ORDER_CONFIRMED', confirmTemplate, 'order_number')).status).toBe(200);

    const paid = restOrder(1001);
    const webhookId = randomUUID();
    await deliver(store.id, 'orders/create', paid, webhookId);
    await deliver(store.id, 'orders/create', paid, webhookId);
    await deliver(store.id, 'orders/updated', { ...paid, updated_at: new Date().toISOString() });
    await deliver(store.id, 'orders/create', restOrder(1002, { shipping_address: { first_name: 'No', last_name: 'Phone', phone: null } }));
    const optedOut = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' });
    await deliver(store.id, 'orders/create', restOrder(1003, { shipping_address: { first_name: 'Out', last_name: 'Out', phone: optedOut.phoneE164 } }));
    const old = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();
    await deliver(store.id, 'orders/create', restOrder(1004, { created_at: old, updated_at: old }));
    await processAll(store.id);

    expect((await outcomes(store.id, 'ORDER_CONFIRMED')).sort((a, b) => a.order.localeCompare(b.order))).toEqual([
      { order: '#1001', outcome: 'QUEUED', reason: null },
      { order: '#1002', outcome: 'SKIPPED', reason: 'no_phone' },
      { order: '#1003', outcome: 'SKIPPED', reason: 'opted_out' },
      { order: '#1004', outcome: 'SKIPPED', reason: 'stale' },
    ]);
    const order = await ctx.prisma.storeOrder.findFirstOrThrow({ where: { storeId: store.id, orderNumber: '#1001' }, include: { sentMessages: true } });
    expect(order.sentMessages).toHaveLength(1);
    expect(order.sentMessages[0]).toMatchObject({ origin: 'STORE', templateId: confirmTemplate, numberId, status: 'QUEUED', resolvedParams: { 'BODY.1': '#1001' } });
    const results = await dashboard('get', `/stores/${store.id}/automations/ORDER_CONFIRMED/results`);
    expect(results.status).toBe(200);
    expect(results.body.skipReasons).toEqual({ no_phone: 1, opted_out: 1, stale: 1 });
    expect(results.body.counts).toMatchObject({ orders: 4, skipped: 3 });
    const orders = await dashboard('get', `/stores/${store.id}/orders`);
    expect(orders.body.total).toBe(4);
  });

  it('adds the store tag to the contact, and opts in only after the consent text is confirmed', async () => {
    const shopHost = host();
    fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    const drip = await ctx.prisma.drip.create({ data: { name: uniq('Order drip '), numberId, status: 'ACTIVE' } });
    await ctx.prisma.dripTrigger.createMany({ data: [{ dripId: drip.id, kind: 'ORDER_PLACED' }, { dripId: drip.id, kind: 'ORDER_DELIVERED' }] });
    try {
      const before = restOrder(2001, { buyer_accepts_marketing: true });
      await deliver(store.id, 'orders/create', before);
      await processAll(store.id);
      const first = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: (before.shipping_address as Json).phone as string }, include: { tags: { include: { tag: true } } } });
      expect(first.tags.map((t) => t.tag.name)).toContain('shopify');
      expect(first.consentStatus).toBe('UNKNOWN');
      expect(await ctx.prisma.dripEvent.count({ where: { contactId: first.id, kind: 'ORDER_PLACED' } })).toBe(1);

      expect((await dashboard('patch', `/stores/${store.id}`, { consentIsWhatsapp: true })).body.consentIsWhatsapp).toBe(true);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'store.consent_confirmed', targetId: store.id } })).toBe(1);
      const after = restOrder(2002, { buyer_accepts_marketing: true });
      await deliver(store.id, 'orders/create', after);
      await processAll(store.id);
      expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: (after.shipping_address as Json).phone as string } })).toMatchObject({ consentStatus: 'OPTED_IN', consentSource: 'STORE' });
    } finally {
      // At most 20 drips may be active; leave room for the other test files.
      await ctx.prisma.drip.update({ where: { id: drip.id }, data: { status: 'ARCHIVED' } });
    }
  });

  it('sends shipped with the tracking link, delivered from shipmentStatus, and cancelled', async () => {
    const shopHost = host();
    const shop = fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    expect((await enable(store.id, 'ORDER_SHIPPED', trackTemplate, 'tracking_url')).status).toBe(200);
    expect((await enable(store.id, 'ORDER_DELIVERED', confirmTemplate, 'order_number')).status).toBe(200);
    expect((await enable(store.id, 'ORDER_CANCELLED', confirmTemplate, 'order_number')).status).toBe(200);

    const order = restOrder(3001);
    await deliver(store.id, 'orders/create', order);
    const fulfillment = { id: 1, order_id: order.id, tracking_number: '1Z999', tracking_url: 'https://track.example/1Z999', shipment_status: 'in_transit' };
    shop.orders.set(order.admin_graphql_api_id as string, graphOrder({ ...order, fulfillments: [fulfillment], updated_at: new Date().toISOString() }));
    await deliver(store.id, 'fulfillments/create', fulfillment);
    await processAll(store.id);
    const shipped = await ctx.prisma.storeOrderMessage.findFirstOrThrow({ where: { kind: 'ORDER_SHIPPED', order: { storeId: store.id } }, include: { message: true } });
    expect(shipped.message?.resolvedParams).toEqual({ 'BODY.1': 'https://track.example/1Z999' });

    shop.orders.set(order.admin_graphql_api_id as string, graphOrder({ ...order, fulfillments: [{ ...fulfillment, shipment_status: 'delivered' }], updated_at: new Date().toISOString() }));
    await deliver(store.id, 'fulfillments/update', { ...fulfillment, shipment_status: 'delivered' });
    await processAll(store.id);
    expect(await outcomes(store.id, 'ORDER_DELIVERED')).toEqual([{ order: '#3001', outcome: 'QUEUED', reason: null }]);

    const cancelled = restOrder(3002);
    await deliver(store.id, 'orders/create', cancelled);
    await deliver(store.id, 'orders/cancelled', { ...cancelled, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await processAll(store.id);
    expect(await outcomes(store.id, 'ORDER_CANCELLED')).toEqual([{ order: '#3002', outcome: 'QUEUED', reason: null }]);
  });

  it('refreshes the token before it expires, repairs webhooks and fetches missed orders', async () => {
    const shopHost = host();
    const shop = fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    await enable(store.id, 'ORDER_CONFIRMED', confirmTemplate, 'order_number');
    await ctx.prisma.storeConnection.update({ where: { id: store.id }, data: { tokenExpiresAt: new Date(Date.now() + 30 * 60_000) } });
    shop.subscriptions = shop.subscriptions.filter((s) => s.topic !== 'ORDERS_CREATE');
    const missed = restOrder(4001);
    shop.orders.set(missed.admin_graphql_api_id as string, graphOrder(missed));

    const tokensBefore = shop.tokens;
    await reconciler.reconcile(store.id);
    expect(shop.tokens).toBe(tokensBefore + 1);
    const row = await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(row.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(row.lastSyncedAt).not.toBeNull();
    expect(shop.subscriptions.map((s) => s.topic)).toContain('ORDERS_CREATE');
    const synced = await ctx.prisma.storeEvent.findFirstOrThrow({ where: { storeId: store.id, externalId: { startsWith: 'sync:' } } });
    expect(synced.topic).toBe('orders/updated');
    await processAll(store.id);
    expect(await outcomes(store.id, 'ORDER_CONFIRMED')).toEqual([{ order: '#4001', outcome: 'QUEUED', reason: null }]);
    // The same order is not fetched twice.
    await reconciler.reconcile(store.id);
    expect(await ctx.prisma.storeEvent.count({ where: { storeId: store.id, externalId: { startsWith: 'sync:' } } })).toBe(1);
  });

  it('moves the store to ERROR after three failed checks with an alert, and back on success', async () => {
    const shopHost = host();
    const shop = fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    shop.down = true;
    await ctx.prisma.storeConnection.update({ where: { id: store.id }, data: { tokenExpiresAt: new Date(Date.now() + 10 * 60_000) } });
    for (let i = 0; i < 2; i += 1) await reconciler.reconcile(store.id);
    expect((await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } })).status).toBe('CONNECTED');
    await reconciler.reconcile(store.id);
    const failing = await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(failing.status).toBe('ERROR');
    expect(failing.lastError).toBeTruthy();
    expect(await ctx.prisma.notification.count({ where: { type: 'STORE_CONNECTION_ERROR', userId: admin.userId, link: `/integrations/stores/${store.id}` } })).toBe(1);
    shop.down = false;
    await reconciler.reconcile(store.id);
    expect(await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ status: 'CONNECTED', lastError: null });
  });

  it('disconnecting removes the webhooks and stops the automations', async () => {
    const shopHost = host();
    const shop = fakeShop(shopHost);
    const store = (await connect(shopHost)).body as { id: string };
    await enable(store.id, 'ORDER_CONFIRMED', confirmTemplate, 'order_number');
    const res = await dashboard('post', `/stores/${store.id}/disconnect`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISCONNECTED');
    expect(res.body.automations.every((a: { enabled: boolean }) => !a.enabled)).toBe(true);
    expect(shop.subscriptions).toHaveLength(0);
    expect((await deliver(store.id, 'orders/create', restOrder(5001))).status).toBe(404);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'store.disconnected', targetId: store.id } })).toBe(1);
  });
});
