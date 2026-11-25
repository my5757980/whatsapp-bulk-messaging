import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Feature 006 (T043): a mock Shopify store for e2e tests and local runs. Routes under
// /shopify/{shop}: the client-credentials token exchange and the GraphQL Admin API calls the platform
// makes. Helper routes under /mock/shopify/{shop} place, fulfil, deliver and cancel orders and start
// checkouts, sending signed webhooks (X-Shopify-Hmac-Sha256 with the app's client secret) to every
// subscription of the topic.

type Json = Record<string, unknown>;

interface Subscription {
  id: string;
  topic: string;
  uri: string;
}

interface MockShop {
  handle: string;
  clientSecret: string | null;
  tokens: Set<string>;
  subscriptions: Subscription[];
  orders: Map<number, Json>;
  nextOrder: number;
  tags: Map<string, string[]>;
  metafields: Map<string, Json[]>;
  cancelled: string[];
  checkouts: Json[];
  deliveries: Array<{ topic: string; uri: string; status: number }>;
}

const shops = new Map<string, MockShop>();

function shopOf(handle: string): MockShop {
  let shop = shops.get(handle);
  if (!shop) {
    shop = { handle, clientSecret: null, tokens: new Set(), subscriptions: [], orders: new Map(), nextOrder: 1001, tags: new Map(), metafields: new Map(), cancelled: [], checkouts: [], deliveries: [] };
    shops.set(handle, shop);
  }
  return shop;
}

const TOPIC_HEADER: Record<string, string> = {
  ORDERS_CREATE: 'orders/create',
  ORDERS_UPDATED: 'orders/updated',
  ORDERS_CANCELLED: 'orders/cancelled',
  FULFILLMENTS_CREATE: 'fulfillments/create',
  FULFILLMENTS_UPDATE: 'fulfillments/update',
  CHECKOUTS_CREATE: 'checkouts/create',
  CHECKOUTS_UPDATE: 'checkouts/update',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text) as Json;
}

/** Sends one signed delivery per subscription of the topic; `times` repeats it with the same webhook id. */
async function emit(shop: MockShop, topic: keyof typeof TOPIC_HEADER, payload: Json, times = 1): Promise<number> {
  if (!shop.clientSecret) return 0;
  const body = JSON.stringify(payload);
  const hmac = createHmac('sha256', shop.clientSecret).update(body).digest('base64');
  let sentCount = 0;
  for (const sub of shop.subscriptions.filter((s) => s.topic === topic)) {
    const webhookId = randomUUID();
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(sub.uri, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': TOPIC_HEADER[topic]!,
          'x-shopify-hmac-sha256': hmac,
          'x-shopify-shop-domain': `${shop.handle}.myshopify.com`,
          'x-shopify-webhook-id': webhookId,
          'x-shopify-api-version': '2026-10',
          'x-shopify-triggered-at': new Date().toISOString(),
        },
        body,
      }).catch(() => null);
      shop.deliveries.push({ topic, uri: sub.uri, status: res?.status ?? 0 });
      sentCount += 1;
    }
  }
  return sentCount;
}

function restOrder(shop: MockShop, input: Json): Json {
  const number = shop.nextOrder++;
  const id = 5000 + number;
  const phone = typeof input.phone === 'string' ? input.phone : null;
  const now = new Date().toISOString();
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${number}`,
    order_number: number,
    total_price: String(input.total ?? '120.00'),
    currency: String(input.currency ?? 'AED'),
    financial_status: input.cod ? 'pending' : 'paid',
    fulfillment_status: null,
    cancelled_at: null,
    created_at: now,
    updated_at: now,
    payment_gateway_names: input.cod ? ['Cash on Delivery (COD)'] : ['shopify_payments'],
    buyer_accepts_marketing: Boolean(input.marketing),
    customer: { first_name: String(input.firstName ?? 'Layla'), last_name: 'Customer', phone: null },
    shipping_address: phone ? { first_name: String(input.firstName ?? 'Layla'), last_name: 'Customer', phone } : null,
    billing_address: null,
    line_items: [{ title: String(input.item ?? 'Leather shoes'), quantity: 1 }],
    fulfillments: [],
  };
}

const orderByNumber = (shop: MockShop, n: unknown) => shop.orders.get(Number(String(n).replace('#', '')));

/** GraphQL order node built from the stored REST order (the fields the platform reads). */
function graphOrder(order: Json): Json {
  const fulfillments = (order.fulfillments as Json[]) ?? [];
  return {
    id: order.admin_graphql_api_id,
    name: order.name,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    cancelledAt: order.cancelled_at,
    displayFinancialStatus: String(order.financial_status).toUpperCase(),
    displayFulfillmentStatus: order.fulfillment_status ? String(order.fulfillment_status).toUpperCase() : 'UNFULFILLED',
    paymentGatewayNames: order.payment_gateway_names,
    customerAcceptsMarketing: order.buyer_accepts_marketing === true,
    currentTotalPriceSet: { shopMoney: { amount: order.total_price, currencyCode: order.currency } },
    customer: order.customer ? { firstName: (order.customer as Json).first_name, lastName: (order.customer as Json).last_name, phone: (order.customer as Json).phone } : null,
    shippingAddress: order.shipping_address
      ? { firstName: (order.shipping_address as Json).first_name, lastName: (order.shipping_address as Json).last_name, phone: (order.shipping_address as Json).phone }
      : null,
    billingAddress: null,
    lineItems: { nodes: ((order.line_items as Json[]) ?? []).map((l) => ({ title: l.title, quantity: l.quantity })) },
    fulfillments: fulfillments.map((f) => ({ trackingInfo: [{ number: f.tracking_number, url: f.tracking_url }], displayStatus: f.shipment_status === 'delivered' ? 'DELIVERED' : 'IN_TRANSIT' })),
  };
}

function graphql(shop: MockShop, query: string, variables: Json): Json {
  if (query.includes('webhookSubscriptionCreate')) {
    const input = (variables.webhookSubscription ?? {}) as Json;
    const sub = { id: `gid://shopify/WebhookSubscription/${randomBytes(4).readUInt32BE()}`, topic: String(variables.topic), uri: String(input.uri ?? input.callbackUrl) };
    shop.subscriptions.push(sub);
    return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: sub.id, topic: sub.topic, uri: sub.uri }, userErrors: [] } } };
  }
  if (query.includes('webhookSubscriptionDelete')) {
    shop.subscriptions = shop.subscriptions.filter((s) => s.id !== variables.id);
    return { data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] } } };
  }
  if (query.includes('webhookSubscriptions')) return { data: { webhookSubscriptions: { nodes: shop.subscriptions.map((s) => ({ id: s.id, topic: s.topic, uri: s.uri })) } } };
  if (query.includes('tagsAdd')) {
    const id = String(variables.id);
    shop.tags.set(id, [...(shop.tags.get(id) ?? []), ...((variables.tags as string[]) ?? [])]);
    return { data: { tagsAdd: { node: { id }, userErrors: [] } } };
  }
  if (query.includes('metafieldsSet')) {
    const list = (variables.metafields as Json[]) ?? [];
    for (const m of list) shop.metafields.set(String(m.ownerId), [...(shop.metafields.get(String(m.ownerId)) ?? []), m]);
    return { data: { metafieldsSet: { metafields: list.map((m) => ({ key: m.key, namespace: m.namespace, value: m.value })), userErrors: [] } } };
  }
  if (query.includes('orderCancel')) {
    shop.cancelled.push(String(variables.orderId));
    return { data: { orderCancel: { job: { id: `gid://shopify/Job/${randomUUID()}` }, orderCancelUserErrors: [] } } };
  }
  if (query.includes('abandonedCheckouts')) return { data: { abandonedCheckouts: { nodes: shop.checkouts } } };
  if (query.includes('order(id')) {
    const node = [...shop.orders.values()].find((o) => o.admin_graphql_api_id === variables.id);
    return { data: { order: node ? graphOrder(node) : null } };
  }
  if (query.includes('orders(')) {
    return { data: { orders: { nodes: [...shop.orders.values()].map(graphOrder), pageInfo: { hasNextPage: false, endCursor: null } } } };
  }
  if (query.includes('shop')) return { data: { shop: { name: `Mock shop ${shop.handle}`, currencyCode: 'AED', myshopifyDomain: `${shop.handle}.myshopify.com` } } };
  return { errors: [{ message: 'mock: query not supported' }] };
}

/** Handles /shopify/* and /mock/shopify/*; false when the path is not ours. */
export async function handleShopify(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'shopify' && parts[1]) {
    const shop = shopOf(parts[1]);
    const rest = `/${parts.slice(2).join('/')}`;
    if (req.method === 'POST' && rest === '/admin/oauth/access_token') {
      const body = await readJson(req);
      if (body.grant_type !== 'client_credentials' || !body.client_id || !body.client_secret) {
        send(res, 400, { error: 'invalid_request', error_description: 'client_credentials with client_id and client_secret required' });
        return true;
      }
      if (shop.clientSecret && shop.clientSecret !== body.client_secret) {
        send(res, 401, { error: 'invalid_client', error_description: 'wrong client secret' });
        return true;
      }
      shop.clientSecret = String(body.client_secret);
      const token = `shpat_${randomBytes(16).toString('hex')}`;
      shop.tokens.add(token);
      send(res, 200, { access_token: token, scope: 'read_orders,write_orders,read_customers', expires_in: 86399 });
      return true;
    }
    if (req.method === 'POST' && /^\/admin\/api\/[^/]+\/graphql\.json$/.test(rest)) {
      const token = String(req.headers['x-shopify-access-token'] ?? '');
      if (!shop.tokens.has(token)) {
        send(res, 401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
        return true;
      }
      const { query, variables } = (await readJson(req)) as { query?: string; variables?: Json };
      send(res, 200, graphql(shop, String(query ?? ''), variables ?? {}));
      return true;
    }
    send(res, 404, { errors: 'Not Found' });
    return true;
  }

  if (parts[0] === 'mock' && parts[1] === 'shopify' && parts[2]) {
    const shop = shopOf(parts[2]);
    const action = parts[3];
    if (req.method === 'GET' && !action) {
      send(res, 200, { subscriptions: shop.subscriptions, tags: Object.fromEntries(shop.tags), metafields: Object.fromEntries(shop.metafields), cancelled: shop.cancelled, deliveries: shop.deliveries, orders: [...shop.orders.values()] });
      return true;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    const times = Number(body.times ?? 1);
    if (action === 'order') {
      const order = restOrder(shop, body);
      shop.orders.set(Number(order.order_number), order);
      const sent = await emit(shop, 'ORDERS_CREATE', order, times);
      send(res, 200, { order: order.order_number, id: order.admin_graphql_api_id, sent });
      return true;
    }
    const order = orderByNumber(shop, body.order);
    if (!order && action !== 'checkout') {
      send(res, 404, { error: `no order ${String(body.order)}` });
      return true;
    }
    if (action === 'fulfil' && order) {
      const fulfillment = { id: Date.now(), order_id: order.id, tracking_number: String(body.tracking ?? '1Z999'), tracking_url: `https://track.example/${String(body.tracking ?? '1Z999')}`, shipment_status: 'in_transit', status: 'success' };
      order.fulfillments = [...((order.fulfillments as Json[]) ?? []), fulfillment];
      order.fulfillment_status = 'fulfilled';
      order.updated_at = new Date().toISOString();
      const sent = (await emit(shop, 'FULFILLMENTS_CREATE', fulfillment, times)) + (await emit(shop, 'ORDERS_UPDATED', order, 1));
      send(res, 200, { sent });
      return true;
    }
    if (action === 'deliver' && order) {
      const fulfillments = (order.fulfillments as Json[]) ?? [];
      const last = fulfillments[fulfillments.length - 1];
      if (!last) {
        send(res, 409, { error: 'fulfil the order first' });
        return true;
      }
      last.shipment_status = 'delivered';
      order.updated_at = new Date().toISOString();
      const sent = (await emit(shop, 'FULFILLMENTS_UPDATE', last, times)) + (await emit(shop, 'ORDERS_UPDATED', order, 1));
      send(res, 200, { sent });
      return true;
    }
    if (action === 'cancel' && order) {
      order.cancelled_at = new Date().toISOString();
      order.updated_at = order.cancelled_at;
      const sent = await emit(shop, 'ORDERS_CANCELLED', order, times);
      send(res, 200, { sent });
      return true;
    }
    if (action === 'checkout') {
      const id = Date.now();
      const checkout = {
        id,
        token: randomUUID().replace(/-/g, ''),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        total_price: String(body.value ?? '249.00'),
        currency: 'AED',
        phone: typeof body.phone === 'string' ? body.phone : null,
        abandoned_checkout_url: `https://${shop.handle}.myshopify.com/checkouts/${id}/recover`,
        line_items: [{ title: 'Leather shoes', quantity: 1 }],
        completed_at: null,
      };
      shop.checkouts.push({
        id: `gid://shopify/AbandonedCheckout/${id}`,
        createdAt: checkout.created_at,
        updatedAt: checkout.updated_at,
        completedAt: null,
        abandonedCheckoutUrl: checkout.abandoned_checkout_url,
        totalPriceSet: { shopMoney: { amount: checkout.total_price, currencyCode: 'AED' } },
        customer: checkout.phone ? { phone: checkout.phone, firstName: 'Layla' } : null,
        lineItems: { nodes: [{ title: 'Leather shoes', quantity: 1 }] },
      });
      const sent = await emit(shop, 'CHECKOUTS_CREATE', checkout, times);
      send(res, 200, { checkout: id, sent });
      return true;
    }
    send(res, 404, { error: 'unknown mock store action' });
    return true;
  }
  return false;
}
