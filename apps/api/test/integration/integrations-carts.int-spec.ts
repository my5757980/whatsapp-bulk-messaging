import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConsentService } from '../../src/modules/contacts/consent.service.js';
import { StoreEventsProcessor } from '../../src/modules/integrations/stores/store-events.processor.js';
import { StoreTickProcessor } from '../../src/modules/integrations/stores/store-tick.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T064 (feature 006 US6, FR-039 - FR-044, research R11): abandoned cart reminders from a checkout to
// recovery, with consent, stops, once-only steps, WooCommerce unpaid orders, expiry and results.

const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10';
const SECRET = 'shopify-client-secret-for-tests';
const HOUR = 3_600_000;
type Json = Record<string, unknown>;

describe('Abandoned carts (006 US6)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let marketing: string;
  const made: string[] = [];
  const checkouts = new Map<string, Json>();
  const base = process.env.PUBLIC_LINK_BASE_URL as string;

  const dashboard = (method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});

  function fakeShop(host: string): void {
    nock(host).persist().post('/admin/oauth/access_token').reply(200, { access_token: 'shpat_carts', expires_in: 86399 });
    nock(host)
      .persist()
      .post(`/admin/api/${VERSION}/graphql.json`)
      .reply(async (req: Request) => {
        const { query } = (await req.json()) as { query: string };
        if (query.includes('webhookSubscriptionCreate')) return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: randomUUID() }, userErrors: [] } } }];
        if (query.includes('webhookSubscriptions')) return [200, { data: { webhookSubscriptions: { nodes: [] } } }];
        if (query.includes('abandonedCheckouts')) return [200, { data: { abandonedCheckouts: { nodes: [...checkouts.values()] } } }];
        if (query.includes('shop')) return [200, { data: { shop: { name: 'Cart Shop' } } }];
        return [200, { errors: [{ message: 'not faked' }] }];
      });
  }

  async function shopifyStore(consent: boolean) {
    const host = `https://${uniq('carts-')}.myshopify.com`;
    fakeShop(host);
    const res = await dashboard('post', '/stores', { platform: 'SHOPIFY', baseUrl: host, numberId: number.id, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cid', clientSecret: SECRET } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);
    if (consent) expect((await dashboard('patch', `/stores/${res.body.id}`, { consentIsWhatsapp: true })).status).toBe(200);
    const step = (waitMinutes: number) => ({ templateId: marketing, variableMapping: { 'BODY.1': { source: 'order', key: 'cart_url' } }, waitMinutes });
    const saved = await dashboard('put', `/stores/${res.body.id}/automations/CART_REMINDER`, { enabled: true, steps: [step(60), step(1440)] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return res.body.id as string;
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

  /** A checkout webhook, and the same checkout as GraphQL returns it at reminder time. */
  async function checkout(storeId: string, phone: string, over: Json = {}) {
    const id = Math.floor(Math.random() * 1e9);
    const now = new Date().toISOString();
    const rest = {
      id,
      created_at: now,
      updated_at: now,
      completed_at: null,
      total_price: '249.00',
      currency: 'AED',
      phone,
      buyer_accepts_marketing: true,
      abandoned_checkout_url: `https://shop.example/checkouts/${id}/recover`,
      line_items: [{ title: 'Shoes', quantity: 1 }],
      ...over,
    };
    checkouts.set(String(id), {
      id: `gid://shopify/AbandonedCheckout/${id}`,
      createdAt: rest.created_at,
      updatedAt: rest.updated_at,
      completedAt: null,
      abandonedCheckoutUrl: rest.abandoned_checkout_url,
      totalPriceSet: { shopMoney: { amount: '249.00', currencyCode: 'AED' } },
      customer: { phone, firstName: 'Layla' },
      lineItems: { nodes: [{ title: 'Shoes', quantity: 1 }] },
    });
    await deliver(storeId, 'checkouts/create', rest);
    return { id: String(id), cart: await ctx.prisma.storeCart.findFirstOrThrow({ where: { storeId, externalId: String(id) } }) };
  }

  const order = (n: number, phone: string, checkoutId: string, total = '249.00') => {
    const now = new Date().toISOString();
    return {
      id: 8000 + n,
      admin_graphql_api_id: `gid://shopify/Order/${8000 + n}`,
      name: `#${n}`,
      checkout_id: Number(checkoutId),
      total_price: total,
      currency: 'AED',
      financial_status: 'paid',
      created_at: now,
      updated_at: now,
      payment_gateway_names: ['shopify_payments'],
      shipping_address: { first_name: 'Layla', last_name: 'C', phone },
      line_items: [],
      fulfillments: [],
    };
  };

  const tick = (hoursLater: number) => ctx.app.get(StoreTickProcessor).tick(new Date(Date.now() + hoursLater * HOUR));
  const cartOf = (id: string) => ctx.prisma.storeCart.findUniqueOrThrow({ where: { id }, include: { reminders: { include: { message: true }, orderBy: { step: 'asc' } } } });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    marketing = (await seedTemplate(ctx, number.wabaId, { category: 'MARKETING', components: [{ type: 'BODY', text: 'You left something behind: {{1}}' }], variables: [{ key: 'BODY.1', example: 'https://x' }] })).id;
  });

  afterEach(async () => {
    nock.cleanAll();
    await ctx.prisma.storeConnection.updateMany({ where: { id: { in: made } }, data: { status: 'DISCONNECTED' } });
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('reminds at the due time with a tracked link to the cart, once per step, and recovers the cart after an order', async () => {
    const storeId = await shopifyStore(true);
    const phone = uaePhone();
    const { id, cart } = await checkout(storeId, phone);
    expect(cart).toMatchObject({ status: 'OPEN', nextStep: 1, value: expect.anything() });
    expect(cart.nextAt!.getTime() - cart.startedAt.getTime()).toBe(60 * 60_000);
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).toMatchObject({ consentStatus: 'OPTED_IN', consentSource: 'STORE' });

    await tick(0.5);
    expect((await cartOf(cart.id)).reminders).toHaveLength(0);
    await tick(1.1);
    const reminded = await cartOf(cart.id);
    expect(reminded).toMatchObject({ status: 'REMINDING', nextStep: 2 });
    expect(reminded.reminders).toHaveLength(1);
    const params = reminded.reminders[0]!.message!.resolvedParams as Record<string, string>;
    expect(params['BODY.1']).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9]{10}$`));
    const link = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { messageId: reminded.reminders[0]!.messageId! }, include: { target: true } });
    expect(link.target.destination).toBe(`https://shop.example/checkouts/${id}/recover`);
    expect(reminded.reminders[0]!.message).toMatchObject({ origin: 'STORE', storeCartId: cart.id, templateId: marketing });

    // An update of the checkout and a repeated tick send nothing more for step 1.
    await deliver(storeId, 'checkouts/update', { id: Number(id), updated_at: new Date().toISOString(), total_price: '249.00', currency: 'AED', phone, abandoned_checkout_url: `https://shop.example/checkouts/${id}/recover` });
    await tick(1.2);
    expect((await cartOf(cart.id)).reminders).toHaveLength(1);

    await deliver(storeId, 'orders/create', order(5101, phone, id, '249.00'));
    const recovered = await cartOf(cart.id);
    expect(recovered.status).toBe('RECOVERED');
    expect(recovered.recoveredValue?.toFixed(2)).toBe('249.00');
    const results = await dashboard('get', `/stores/${storeId}/automations/CART_REMINDER/results`);
    expect(results.status).toBe(200);
    expect(results.body.counts).toMatchObject({ carts: 1, recovered: 1, recoveredValue: '249.00', clicks: 0, perStep: { '1': 1 } });
    const carts = await dashboard('get', `/stores/${storeId}/carts`);
    expect(carts.body.items[0]).toMatchObject({ status: 'RECOVERED', remindersSent: 1, recoveredValue: '249.00' });
  });

  it('skips a cart without WhatsApp consent, and closes one ordered before any reminder', async () => {
    const storeId = await shopifyStore(false);
    const first = await checkout(storeId, uaePhone());
    await tick(1.1);
    expect(await cartOf(first.cart.id)).toMatchObject({ status: 'SKIPPED', stopReason: 'no_consent' });

    const consented = await shopifyStore(true);
    const phone = uaePhone();
    const second = await checkout(consented, phone);
    await deliver(consented, 'orders/create', order(5102, phone, second.id));
    expect(await cartOf(second.cart.id)).toMatchObject({ status: 'STOPPED', stopReason: 'ordered', recoveredValue: null });
  });

  it('stops on a reply on the store number, an opt-out or a block', async () => {
    const storeId = await shopifyStore(true);
    const replier = uaePhone();
    const replied = await checkout(storeId, replier);
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, replier.slice(1), 'Is the green one in stock?')));
    expect(await cartOf(replied.cart.id)).toMatchObject({ status: 'STOPPED', stopReason: 'replied' });

    const leaver = uaePhone();
    const left = await checkout(storeId, leaver);
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: leaver } });
    await ctx.app.get(ConsentService).setStatus(contact.id, 'OPTED_OUT', 'MANUAL');
    expect(await cartOf(left.cart.id)).toMatchObject({ status: 'STOPPED', stopReason: 'opted_out' });

    const blockedPhone = uaePhone();
    const blocked = await checkout(storeId, blockedPhone);
    const blockedContact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: blockedPhone } });
    expect((await dashboard('post', `/contacts/${blockedContact.id}/block`)).status).toBeLessThan(300);
    expect(await cartOf(blocked.cart.id)).toMatchObject({ status: 'STOPPED', stopReason: 'blocked' });
  });

  it('expires carts after 7 days', async () => {
    const storeId = await shopifyStore(true);
    const { cart } = await checkout(storeId, uaePhone());
    await ctx.prisma.storeCart.update({ where: { id: cart.id }, data: { startedAt: new Date(Date.now() - 8 * 24 * HOUR), nextAt: new Date(Date.now() - HOUR) } });
    await tick(0);
    expect(await cartOf(cart.id)).toMatchObject({ status: 'EXPIRED' });
  });

  it('treats a WooCommerce order left unpaid as a cart with its payment link', async () => {
    const host = `https://${uniq('woo-carts-')}.example.test`;
    const hooks: Array<{ secret: string }> = [];
    nock(host).persist().get('/wp-json/').reply(200, { name: 'Woo Carts' });
    nock(host).persist().get('/wp-json/wc/v3/orders').query(true).reply(200, []);
    nock(host).persist().get('/wp-json/wc/v3/webhooks').query(true).reply(200, []);
    nock(host)
      .persist()
      .post('/wp-json/wc/v3/webhooks')
      .reply(async (req: Request) => {
        hooks.push((await req.json()) as { secret: string });
        return [201, { id: hooks.length, status: 'active' }];
      });
    const res = await dashboard('post', '/stores', { platform: 'WOOCOMMERCE', baseUrl: host, numberId: number.id, defaultCountry: 'AE', customerTag: 'woo', credentials: { consumerKey: 'ck_test_0123456789abcdef', consumerSecret: 'cs_test_0123456789abcdef' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);
    const gmt = new Date().toISOString().slice(0, 19);
    const pending = { id: 911, number: '911', status: 'pending', currency: 'AED', total: '59.00', payment_method: 'bacs', date_created_gmt: gmt, date_modified_gmt: gmt, billing: { phone: uaePhone() }, shipping: {}, line_items: [{ name: 'Hat', quantity: 1 }], meta_data: [], payment_url: `${host}/checkout/order-pay/911` };
    const raw = JSON.stringify(pending);
    const sent = await request(ctx.server())
      .post(`/api/integrations/woocommerce/${res.body.id}/webhooks`)
      .set('content-type', 'application/json')
      .set('x-wc-webhook-topic', 'order.created')
      .set('x-wc-webhook-delivery-id', randomUUID())
      .set('x-wc-webhook-signature', createHmac('sha256', hooks[0]!.secret).update(raw).digest('base64'))
      .send(raw);
    expect(sent.status).toBe(200);
    for (const event of await ctx.prisma.storeEvent.findMany({ where: { storeId: res.body.id, status: 'RECEIVED' } })) await ctx.app.get(StoreEventsProcessor).process(event.id);
    expect(await ctx.prisma.storeCart.findFirstOrThrow({ where: { storeId: res.body.id, externalId: '911' } })).toMatchObject({ status: 'OPEN', cartUrl: `${host}/checkout/order-pay/911` });
    expect(await ctx.prisma.storeOrder.count({ where: { storeId: res.body.id } })).toBe(0);
  });
});
