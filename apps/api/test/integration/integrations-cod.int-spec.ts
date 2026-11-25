import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { CodService, type StoreActionData } from '../../src/modules/integrations/stores/cod.service.js';
import { StoreEventsProcessor } from '../../src/modules/integrations/stores/store-events.processor.js';
import { StoreTickProcessor } from '../../src/modules/integrations/stores/store-tick.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T057 (feature 006 US5, FR-034 - FR-038, research R10): COD confirmation from the question to the
// store actions, against fake stores on nock.

const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10';
const SECRET = 'shopify-client-secret-for-tests';
type Json = Record<string, unknown>;

interface FakeShop {
  tags: Array<{ id: string; tags: string[] }>;
  metafields: Json[];
  cancelled: string[];
}

function fakeShop(host: string): FakeShop {
  const shop: FakeShop = { tags: [], metafields: [], cancelled: [] };
  nock(host).persist().post('/admin/oauth/access_token').reply(200, { access_token: 'shpat_cod', expires_in: 86399 });
  nock(host)
    .persist()
    .post(`/admin/api/${VERSION}/graphql.json`)
    .reply(async (req: Request) => {
      const { query, variables = {} } = (await req.json()) as { query: string; variables?: Json };
      if (query.includes('webhookSubscriptionCreate')) return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: randomUUID() }, userErrors: [] } } }];
      if (query.includes('webhookSubscriptions')) return [200, { data: { webhookSubscriptions: { nodes: [] } } }];
      if (query.includes('tagsAdd')) {
        shop.tags.push({ id: String(variables.id), tags: variables.tags as string[] });
        return [200, { data: { tagsAdd: { node: { id: variables.id }, userErrors: [] } } }];
      }
      if (query.includes('metafieldsSet')) {
        shop.metafields.push(...(variables.metafields as Json[]));
        return [200, { data: { metafieldsSet: { metafields: [], userErrors: [] } } }];
      }
      if (query.includes('orderCancel')) {
        shop.cancelled.push(String(variables.orderId));
        return [200, { data: { orderCancel: { job: { id: 'job-1' }, orderCancelUserErrors: [] } } }];
      }
      if (query.includes('shop')) return [200, { data: { shop: { name: 'COD Shop' } } }];
      return [200, { errors: [{ message: 'not faked' }] }];
    });
  return shop;
}

function codOrder(n: number, phone: string, over: Json = {}): Json {
  const now = new Date().toISOString();
  return {
    id: 9000 + n,
    admin_graphql_api_id: `gid://shopify/Order/${9000 + n}`,
    name: `#${n}`,
    total_price: '199.00',
    currency: 'AED',
    financial_status: 'pending',
    cancelled_at: null,
    created_at: now,
    updated_at: now,
    payment_gateway_names: ['Cash on Delivery (COD)'],
    customer: { first_name: 'Layla', last_name: 'Customer', phone: null },
    shipping_address: { first_name: 'Layla', last_name: 'Customer', phone },
    line_items: [{ title: 'Shoes', quantity: 1 }],
    fulfillments: [],
    ...over,
  };
}

describe('COD confirmation (006 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let templateId: string;
  let confirmId: string;
  const made: string[] = [];

  const dashboard = (method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});

  async function shopifyStore(autoCancel: boolean) {
    const host = `https://${uniq('cod-')}.myshopify.com`;
    const shop = fakeShop(host);
    const res = await dashboard('post', '/stores', { platform: 'SHOPIFY', baseUrl: host, numberId: number.id, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cid', clientSecret: SECRET } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);
    const settings = { reminderMinutes: 30, finalMinutes: 60, autoCancel, confirmedReply: 'Confirmed, thank you!', cancelledReply: 'Cancelled as you asked.', alreadyAnsweredReply: 'We already have your answer.' };
    const step = { templateId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } };
    expect((await dashboard('put', `/stores/${res.body.id}/automations/COD_CONFIRMATION`, { enabled: true, steps: [step], settings })).status).toBe(200);
    const plain = { enabled: true, steps: [{ templateId: confirmId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] };
    expect((await dashboard('put', `/stores/${res.body.id}/automations/ORDER_CONFIRMED`, plain)).status).toBe(200);
    return { id: res.body.id as string, shop };
  }

  async function deliver(storeId: string, topic: string, payload: Json) {
    const raw = JSON.stringify(payload);
    const res = await request(ctx.server())
      .post(`/api/integrations/shopify/${storeId}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-shopify-topic', topic)
      .set('x-shopify-webhook-id', randomUUID())
      .set('x-shopify-hmac-sha256', createHmac('sha256', SECRET).update(raw).digest('base64'))
      .send(raw);
    expect(res.status).toBe(200);
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId, status: 'RECEIVED' }, orderBy: { id: 'asc' } })) await ctx.app.get(StoreEventsProcessor).process(event.id);
  }

  async function place(storeId: string, n: number) {
    const phone = uaePhone();
    await deliver(storeId, 'orders/create', codOrder(n, phone));
    const order = await ctx.prisma.storeOrder.findFirstOrThrow({ where: { storeId, orderNumber: `#${n}` } });
    return { order, phone };
  }

  /** The customer taps a quick-reply button. */
  async function tap(phone: string, payload: string) {
    const from = phone.slice(1);
    const message = { from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', button: { payload, text: payload.endsWith(':Y') ? 'Yes' : 'No' } };
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [message] } }] }] };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, body));
  }

  /** Store actions are retried jobs; the test runs the waiting ones of an order. */
  async function runActions(orderId: string): Promise<void> {
    const jobs = await ctx.app.get(QueueRegistry).get(QUEUES.STORES).getJobs(['waiting', 'delayed', 'prioritized']);
    for (const job of jobs.filter((j) => j.name === 'store-action' && (j.data as StoreActionData).orderId === orderId)) {
      await ctx.app.get(CodService).runAction(job.data as StoreActionData);
      await job.remove();
    }
  }

  const replies = async (phone: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { kind: 'SESSION_OUT', origin: 'AUTOMATIC', conversation: { contact: { phoneE164: phone } } }, orderBy: { occurredAt: 'asc' } })).map((m) => m.text);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    templateId = (
      await seedTemplate(ctx, number.wabaId, {
        components: [{ type: 'BODY', text: 'Please confirm your order {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'No' }] }],
        variables: [{ key: 'BODY.1', example: '#1001' }],
      })
    ).id;
    confirmId = (await seedTemplate(ctx, number.wabaId, { components: [{ type: 'BODY', text: 'Order {{1}} confirmed' }], variables: [{ key: 'BODY.1', example: '#1001' }] })).id;
  });

  afterEach(async () => {
    nock.cleanAll();
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: made } }, data: { status: 'DISCONNECTED' } });
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('asks a COD order to confirm with one payload per button, instead of the plain confirmation', async () => {
    const store = await shopifyStore(false);
    const { order } = await place(store.id, 7001);
    expect(order.codStatus).toBe('ASKED');
    expect(order.codNextAt!.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    const asked = await ctx.prisma.storeOrderMessage.findFirstOrThrow({ where: { orderId: order.id, kind: 'COD_CONFIRMATION' }, include: { message: true } });
    expect(asked.message?.resolvedParams).toEqual({ 'BODY.1': '#7001', 'BUTTON.0.payload': `cod1:${order.id}:Y`, 'BUTTON.1.payload': `cod1:${order.id}:N` });
    expect(await ctx.prisma.storeOrderMessage.findFirst({ where: { orderId: order.id, kind: 'ORDER_CONFIRMED' } })).toMatchObject({ outcome: 'SKIPPED', skipReason: 'cod' });
    expect((await dashboard('put', `/stores/${store.id}/automations/COD_CONFIRMATION`, { enabled: true, steps: [{ templateId: confirmId, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] })).status).toBe(422);
  });

  it('confirms with the tag, the metafield and the reply; a repeated tap gets the "already answered" reply', async () => {
    const store = await shopifyStore(false);
    const { order, phone } = await place(store.id, 7002);
    await tap(phone, `cod1:${order.id}:Y`);
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).codStatus).toBe('CONFIRMED');
    await runActions(order.id);
    expect(store.shop.tags).toEqual([{ id: 'gid://shopify/Order/16002', tags: ['whatsapp-cod-confirmed'] }]);
    expect(store.shop.metafields).toEqual([expect.objectContaining({ namespace: 'whatsapp', key: 'cod_status', value: 'confirmed' })]);
    await tap(phone, `cod1:${order.id}:N`);
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).codStatus).toBe('CONFIRMED');
    expect(await replies(phone)).toEqual(['Confirmed, thank you!', 'We already have your answer.']);
    expect(await ctx.prisma.conversationEvent.count({ where: { type: 'COD_ANSWERED', conversation: { contact: { phoneE164: phone } } } })).toBe(1);
  });

  it('cancels in the store with automatic cancel on; with it off, tags only and alerts admins', async () => {
    const auto = await shopifyStore(true);
    const first = await place(auto.id, 7003);
    await tap(first.phone, `cod1:${first.order.id}:N`);
    await runActions(first.order.id);
    expect(auto.shop.cancelled).toEqual(['gid://shopify/Order/16003']);
    expect(await replies(first.phone)).toEqual(['Cancelled as you asked.']);

    const manual = await shopifyStore(false);
    const second = await place(manual.id, 7004);
    await tap(second.phone, `cod1:${second.order.id}:N`);
    await runActions(second.order.id);
    expect(manual.shop.cancelled).toEqual([]);
    expect(manual.shop.tags.map((t) => t.tags[0])).toEqual(['whatsapp-cod-cancelled']);
    expect(await ctx.prisma.notification.count({ where: { type: 'COD_CANCELLED', userId: admin.userId, link: `/integrations/stores/${manual.id}` } })).toBe(1);
  });

  it('reminds once, then marks the order "no answer" with its tag', async () => {
    const store = await shopifyStore(false);
    const { order } = await place(store.id, 7005);
    const tick = ctx.app.get(StoreTickProcessor);
    await tick.tick(new Date(Date.now() + 31 * 60_000));
    const reminder = await ctx.prisma.storeOrderMessage.findFirstOrThrow({ where: { orderId: order.id, kind: 'COD_REMINDER' }, include: { message: true } });
    expect(reminder.message?.resolvedParams).toMatchObject({ 'BUTTON.0.payload': `cod1:${order.id}:Y` });
    await tick.tick(new Date(Date.now() + 61 * 60_000));
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).codStatus).toBe('NO_ANSWER');
    await runActions(order.id);
    expect(store.shop.tags.map((t) => t.tags[0])).toEqual(['whatsapp-cod-no-answer']);
    const results = await dashboard('get', `/stores/${store.id}/automations/COD_CONFIRMATION/results`);
    expect(results.body.counts).toMatchObject({ asked: 1, confirmed: 0, cancelled: 0, notConfirmed: 1 });
  });

  it('closes the question when the store cancels the order first, with no reminder', async () => {
    const store = await shopifyStore(false);
    const { order, phone } = await place(store.id, 7006);
    await deliver(store.id, 'orders/cancelled', codOrder(7006, phone, { cancelled_at: new Date().toISOString(), updated_at: new Date(Date.now() + 1000).toISOString() }));
    expect((await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).codStatus).toBe('CLOSED');
    await ctx.app.get(StoreTickProcessor).tick(new Date(Date.now() + 31 * 60_000));
    expect(await ctx.prisma.storeOrderMessage.count({ where: { orderId: order.id, kind: 'COD_REMINDER' } })).toBe(0);
  });
});
