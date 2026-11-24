import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StoreEventsProcessor } from '../../src/modules/integrations/stores/store-events.processor.js';
import { StoreReconcilerProcessor } from '../../src/modules/integrations/stores/store-reconciler.processor.js';
import { restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T045 (feature 006 US4, research R8 and R9): a WooCommerce store with REST v3 keys, signed
// webhooks with a per-store secret, status-based stages and the reconciler, against a fake site.

type Json = Record<string, unknown>;
const KEY = { consumerKey: 'ck_test_0123456789abcdef', consumerSecret: 'cs_test_0123456789abcdef' };

interface FakeSite {
  host: string;
  webhooks: Array<{ id: number; topic: string; delivery_url: string; secret: string; status: string }>;
  orders: Json[];
  modifiedAfter: string[];
}

const gmt = (at = new Date()) => at.toISOString().slice(0, 19);

function wooOrder(id: number, over: Json = {}): Json {
  return {
    id,
    number: String(id),
    status: 'processing',
    currency: 'AED',
    total: '89.00',
    payment_method: 'bacs',
    date_paid_gmt: gmt(),
    date_created_gmt: gmt(),
    date_modified_gmt: gmt(),
    billing: { first_name: 'Omar', last_name: 'Customer', phone: uaePhone() },
    shipping: { first_name: '', last_name: '', phone: '' },
    line_items: [{ name: 'Hat', quantity: 1 }],
    meta_data: [],
    ...over,
  };
}

function fakeSite(host: string): FakeSite {
  const site: FakeSite = { host, webhooks: [], orders: [], modifiedAfter: [] };
  const authorised = (auth: string | undefined) => auth === `Basic ${Buffer.from(`${KEY.consumerKey}:${KEY.consumerSecret}`).toString('base64')}`;
  nock(host).persist().get('/wp-json/').reply(200, { name: 'Test Woo', url: host });
  nock(host)
    .persist()
    .get('/wp-json/wc/v3/orders')
    .query(true)
    .reply(function (uri) {
      if (!authorised(this.req.headers.authorization as string | undefined)) return [401, { code: 'woocommerce_rest_cannot_view' }];
      const after = new URL(uri, host).searchParams.get('modified_after');
      if (after) site.modifiedAfter.push(after);
      return [200, after ? site.orders : []];
    });
  nock(host)
    .persist()
    .get('/wp-json/wc/v3/webhooks')
    .query(true)
    .reply(() => [200, site.webhooks.map(({ secret: _secret, ...w }) => w)]);
  nock(host)
    .persist()
    .post('/wp-json/wc/v3/webhooks')
    .reply((_uri, body) => {
      const b = (typeof body === 'string' ? JSON.parse(body) : body) as Json;
      const hook = { id: site.webhooks.length + 1, topic: String(b.topic), delivery_url: String(b.delivery_url), secret: String(b.secret), status: String(b.status ?? 'active') };
      site.webhooks.push(hook);
      return [201, hook];
    });
  nock(host)
    .persist()
    .put(/\/wp-json\/wc\/v3\/webhooks\/\d+/)
    .reply((uri, body) => {
      const hook = site.webhooks.find((w) => w.id === Number(uri.split('/').pop()));
      if (hook) hook.status = String(((typeof body === 'string' ? JSON.parse(body) : body) as Json).status ?? hook.status);
      return [200, hook ?? {}];
    });
  nock(host)
    .persist()
    .delete(/\/wp-json\/wc\/v3\/webhooks\/\d+/)
    .query(true)
    .reply((uri) => {
      const id = Number(new URL(uri, host).pathname.split('/').pop());
      site.webhooks = site.webhooks.filter((w) => w.id !== id);
      return [200, { id }];
    });
  return site;
}

describe('WooCommerce stores (006 US4)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let numberId: string;
  let templateId: string;
  let processor: StoreEventsProcessor;
  let reconciler: StoreReconcilerProcessor;
  const made: string[] = [];

  const dashboard = (method: 'get' | 'post' | 'patch' | 'put', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});
  const host = () => `https://${uniq('woo-')}.example.test`;

  async function connect(siteHost: string) {
    const res = await dashboard('post', '/stores', { platform: 'WOOCOMMERCE', baseUrl: siteHost, numberId, defaultCountry: 'AE', customerTag: 'woo', credentials: KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);
    return res.body as { id: string };
  }

  function deliver(storeId: string, topic: string, order: Json, secret: string, deliveryId: string = randomUUID()) {
    const raw = JSON.stringify(order);
    return request(ctx.server())
      .post(`/api/integrations/woocommerce/${storeId}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-wc-webhook-topic', topic)
      .set('x-wc-webhook-delivery-id', deliveryId)
      .set('x-wc-webhook-signature', createHmac('sha256', secret).update(raw).digest('base64'))
      .send(raw);
  }

  async function processAll(storeId: string): Promise<void> {
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId, status: 'RECEIVED' }, orderBy: { id: 'asc' } })) await processor.process(event.id);
  }

  const kinds = async (storeId: string) =>
    (await ctx.prisma.storeOrderMessage.findMany({ where: { order: { storeId } }, include: { order: true }, orderBy: { createdAt: 'asc' } })).map((m) => `${m.order.orderNumber}:${m.kind}:${m.outcome}`);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    numberId = number.id;
    templateId = (await seedTemplate(ctx, number.wabaId, { components: [{ type: 'BODY', text: 'Order {{1}} update' }], variables: [{ key: 'BODY.1', example: '700' }] })).id;
    processor = ctx.app.get(StoreEventsProcessor);
    reconciler = ctx.app.get(StoreReconcilerProcessor);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: made } }, data: { status: 'DISCONNECTED' } });
    restoreNetwork();
    await ctx.close();
  });

  it('tests the keys and creates its webhooks with a secret of its own', async () => {
    const one = fakeSite(host());
    const store = await connect(one.host);
    expect((await dashboard('get', `/stores/${store.id}`)).body).toMatchObject({ platform: 'WOOCOMMERCE', name: 'Test Woo', status: 'CONNECTED', shippedStatus: 'completed', deliveredStatus: null });
    expect(one.webhooks.map((w) => w.topic).sort()).toEqual(['order.created', 'order.updated']);
    expect(one.webhooks.every((w) => w.delivery_url.endsWith(`/api/integrations/woocommerce/${store.id}/webhooks`) && w.secret.length >= 32)).toBe(true);
    const two = fakeSite(host());
    await connect(two.host);
    expect(two.webhooks[0]!.secret).not.toBe(one.webhooks[0]!.secret);
    const row = await ctx.prisma.storeConnection.findUniqueOrThrow({ where: { id: store.id } });
    expect(row.credentialsEncrypted).not.toContain(KEY.consumerSecret);
    expect(row.webhookSecretEncrypted).not.toContain(one.webhooks[0]!.secret);

    const wrong = host();
    nock(wrong).persist().get('/wp-json/').reply(200, { name: 'Wrong keys' });
    nock(wrong).persist().get('/wp-json/wc/v3/orders').query(true).reply(401, { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' });
    const refused = await dashboard('post', '/stores', { platform: 'WOOCOMMERCE', baseUrl: wrong, numberId, defaultCountry: 'AE', customerTag: 'woo', credentials: KEY });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('STORE_ACCESS_FAILED');
  });

  it('refuses a bad signature, and answers and ignores the activation ping', async () => {
    const site = fakeSite(host());
    const store = await connect(site.host);
    const secret = site.webhooks[0]!.secret;
    expect((await deliver(store.id, 'order.created', wooOrder(700), 'wrong-secret')).status).toBe(401);
    const ping = await request(ctx.server()).post(`/api/integrations/woocommerce/${store.id}/webhooks`).set('content-type', 'application/x-www-form-urlencoded').send('webhook_id=1');
    expect(ping.status).toBe(200);
    expect(await ctx.prisma.storeEvent.count({ where: { storeId: store.id } })).toBe(0);
    expect((await deliver(store.id, 'order.created', wooOrder(700), secret)).status).toBe(200);
    expect(await ctx.prisma.storeEvent.count({ where: { storeId: store.id } })).toBe(1);
  });

  it('reads processing as confirmed, completed as shipped, and a chosen status as delivered', async () => {
    const site = fakeSite(host());
    const store = await connect(site.host);
    const secret = site.webhooks[0]!.secret;
    for (const kind of ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED']) {
      const saved = await dashboard('put', `/stores/${store.id}/automations/${kind}`, { enabled: true, steps: [{ templateId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    const order = wooOrder(710);
    await deliver(store.id, 'order.created', order, secret);
    await deliver(store.id, 'order.updated', { ...order, status: 'completed', date_modified_gmt: gmt(new Date(Date.now() + 1000)) }, secret);
    await processAll(store.id);
    expect(await kinds(store.id)).toEqual(['710:ORDER_CONFIRMED:QUEUED', '710:ORDER_SHIPPED:QUEUED']);

    expect((await dashboard('patch', `/stores/${store.id}`, { deliveredStatus: 'delivered' })).body.deliveredStatus).toBe('delivered');
    await deliver(store.id, 'order.updated', { ...order, status: 'delivered', date_modified_gmt: gmt(new Date(Date.now() + 2000)) }, secret);
    await processAll(store.id);
    expect(await kinds(store.id)).toEqual(['710:ORDER_CONFIRMED:QUEUED', '710:ORDER_SHIPPED:QUEUED', '710:ORDER_DELIVERED:QUEUED']);
  });

  it('sets disabled webhooks active again and fetches orders changed since the last sync', async () => {
    const site = fakeSite(host());
    const store = await connect(site.host);
    await dashboard('put', `/stores/${store.id}/automations/ORDER_CONFIRMED`, { enabled: true, steps: [{ templateId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] });
    site.webhooks[0]!.status = 'disabled';
    site.orders.push(wooOrder(720));
    await reconciler.reconcile(store.id);
    expect(site.webhooks.every((w) => w.status === 'active')).toBe(true);
    expect(site.modifiedAfter).toHaveLength(1);
    await processAll(store.id);
    expect(await kinds(store.id)).toEqual(['720:ORDER_CONFIRMED:QUEUED']);
  });
});
