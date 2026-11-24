import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Feature 006 (T043): a mock WooCommerce store. Routes under /woo/{site}: the WordPress index, the
// REST v3 orders, notes and webhooks the platform uses, with Basic auth (ck_/cs_ keys). Helper routes
// under /mock/woo/{site} place orders, change their status and disable webhooks, sending signed
// deliveries (X-WC-Webhook-Signature with each webhook's secret) like WooCommerce does.

type Json = Record<string, unknown>;

interface Webhook {
  id: number;
  name: string;
  topic: string;
  delivery_url: string;
  secret: string;
  status: 'active' | 'paused' | 'disabled';
}

interface MockSite {
  key: string | null;
  orders: Map<number, Json>;
  nextOrder: number;
  webhooks: Webhook[];
  nextWebhook: number;
  notes: Array<{ order: number; note: string }>;
  deliveries: Array<{ topic: string; url: string; status: number }>;
}

const sites = new Map<string, MockSite>();

function siteOf(handle: string): MockSite {
  let site = sites.get(handle);
  if (!site) {
    site = { key: null, orders: new Map(), nextOrder: 700, webhooks: [], nextWebhook: 1, notes: [], deliveries: [] };
    sites.set(handle, site);
  }
  return site;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Json) : {};
}

/** Basic auth with a ck_/cs_ pair; the first pair a site sees becomes its key. */
function authorised(site: MockSite, req: IncomingMessage): boolean {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Basic ')) return false;
  const [ck, cs] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (!ck?.startsWith('ck_') || !cs?.startsWith('cs_')) return false;
  const pair = `${ck}:${cs}`;
  site.key ??= pair;
  return site.key === pair;
}

const gmt = () => new Date().toISOString().slice(0, 19);

async function emit(site: MockSite, topic: string, order: Json, times = 1): Promise<number> {
  const body = JSON.stringify(order);
  let count = 0;
  for (const hook of site.webhooks.filter((w) => w.topic === topic && w.status === 'active')) {
    const signature = createHmac('sha256', hook.secret).update(body).digest('base64');
    const delivery = randomUUID();
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(hook.delivery_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wc-webhook-source': 'https://mock-woo.example/',
          'x-wc-webhook-topic': topic,
          'x-wc-webhook-resource': 'order',
          'x-wc-webhook-event': topic.split('.')[1] ?? 'updated',
          'x-wc-webhook-signature': signature,
          'x-wc-webhook-id': String(hook.id),
          'x-wc-webhook-delivery-id': delivery,
        },
        body,
      }).catch(() => null);
      site.deliveries.push({ topic, url: hook.delivery_url, status: res?.status ?? 0 });
      count += 1;
    }
  }
  return count;
}

function newOrder(site: MockSite, input: Json): Json {
  const id = site.nextOrder++;
  const status = String(input.status ?? 'processing');
  const phone = typeof input.phone === 'string' ? input.phone : '';
  return {
    id,
    number: String(id),
    status,
    currency: 'AED',
    total: String(input.total ?? '89.00'),
    payment_method: input.cod ? 'cod' : 'bacs',
    date_paid_gmt: status === 'processing' && !input.cod ? gmt() : null,
    date_created_gmt: gmt(),
    date_modified_gmt: gmt(),
    billing: { first_name: String(input.firstName ?? 'Omar'), last_name: 'Customer', phone },
    shipping: { first_name: '', last_name: '', phone: '' },
    line_items: [{ name: String(input.item ?? 'Wool hat'), quantity: 1 }],
    meta_data: [],
    payment_url: `https://mock-woo.example/checkout/order-pay/${id}/?pay_for_order=true&key=wc_order_${id}`,
  };
}

/** Handles /woo/* and /mock/woo/*; false when the path is not ours. */
export async function handleWoo(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'woo' && parts[1]) {
    const site = siteOf(parts[1]);
    const rest = `/${parts.slice(2).join('/')}`;
    if (req.method === 'GET' && rest === '/wp-json') {
      send(res, 200, { name: `Mock Woo ${parts[1]}`, description: 'A mock WooCommerce site', url: `https://${parts[1]}.mock-woo.example` });
      return true;
    }
    if (!rest.startsWith('/wp-json/wc/v3/')) return send(res, 404, { code: 'rest_no_route' }), true;
    if (!authorised(site, req)) return send(res, 401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid signature - provided signature does not match.' }), true;
    const path = rest.slice('/wp-json/wc/v3'.length);

    if (req.method === 'GET' && path === '/orders') {
      const after = url.searchParams.get('modified_after');
      const list = [...site.orders.values()].filter((o) => !after || String(o.date_modified_gmt) > after.slice(0, 19));
      send(res, 200, list);
      return true;
    }
    const note = /^\/orders\/(\d+)\/notes$/.exec(path);
    if (req.method === 'POST' && note) {
      const body = await readJson(req);
      site.notes.push({ order: Number(note[1]), note: String(body.note ?? '') });
      send(res, 201, { id: site.notes.length, note: body.note });
      return true;
    }
    const one = /^\/orders\/(\d+)$/.exec(path);
    if (one && (req.method === 'PUT' || req.method === 'POST')) {
      const order = site.orders.get(Number(one[1]));
      if (!order) return send(res, 404, { code: 'woocommerce_rest_shop_order_invalid_id' }), true;
      const body = await readJson(req);
      if (typeof body.status === 'string') order.status = body.status;
      if (Array.isArray(body.meta_data)) order.meta_data = [...((order.meta_data as Json[]) ?? []), ...(body.meta_data as Json[])];
      order.date_modified_gmt = gmt();
      send(res, 200, order);
      return true;
    }
    if (path === '/webhooks' && req.method === 'GET') return send(res, 200, site.webhooks.map(({ secret: _secret, ...w }) => w)), true;
    if (path === '/webhooks' && req.method === 'POST') {
      const body = await readJson(req);
      const hook: Webhook = {
        id: site.nextWebhook++,
        name: String(body.name ?? 'webhook'),
        topic: String(body.topic),
        delivery_url: String(body.delivery_url),
        secret: String(body.secret ?? ''),
        status: (body.status as Webhook['status']) ?? 'active',
      };
      site.webhooks.push(hook);
      // WooCommerce pings a new webhook with an unsigned form body.
      void fetch(hook.delivery_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `webhook_id=${hook.id}` }).catch(() => null);
      const { secret: _secret, ...shown } = hook;
      send(res, 201, shown);
      return true;
    }
    const hookPath = /^\/webhooks\/(\d+)$/.exec(path);
    if (hookPath) {
      const hook = site.webhooks.find((w) => w.id === Number(hookPath[1]));
      if (!hook) return send(res, 404, { code: 'woocommerce_rest_webhook_invalid_id' }), true;
      if (req.method === 'DELETE') {
        site.webhooks = site.webhooks.filter((w) => w !== hook);
        send(res, 200, { id: hook.id });
        return true;
      }
      const body = await readJson(req);
      if (typeof body.status === 'string') hook.status = body.status as Webhook['status'];
      if (typeof body.delivery_url === 'string') hook.delivery_url = body.delivery_url;
      const { secret: _secret, ...shown } = hook;
      send(res, 200, shown);
      return true;
    }
    send(res, 404, { code: 'rest_no_route' });
    return true;
  }

  if (parts[0] === 'mock' && parts[1] === 'woo' && parts[2]) {
    const site = siteOf(parts[2]);
    const action = parts[3];
    if (req.method === 'GET' && !action) {
      send(res, 200, { webhooks: site.webhooks.map(({ secret: _secret, ...w }) => w), notes: site.notes, deliveries: site.deliveries, orders: [...site.orders.values()] });
      return true;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    if (action === 'order') {
      const order = newOrder(site, body);
      site.orders.set(Number(order.id), order);
      const sent = await emit(site, 'order.created', order, Number(body.times ?? 1));
      send(res, 200, { order: order.id, sent });
      return true;
    }
    if (action === 'status') {
      const order = site.orders.get(Number(body.order));
      if (!order) return send(res, 404, { error: `no order ${String(body.order)}` }), true;
      order.status = String(body.status);
      order.date_modified_gmt = gmt();
      const sent = await emit(site, 'order.updated', order, Number(body.times ?? 1));
      send(res, 200, { sent });
      return true;
    }
    const disable = action === 'webhooks' && parts[5] === 'disable' ? site.webhooks.find((w) => w.id === Number(parts[4])) : undefined;
    if (disable) {
      disable.status = 'disabled';
      send(res, 200, { id: disable.id, status: disable.status });
      return true;
    }
    send(res, 404, { error: 'unknown mock store action' });
    return true;
  }
  return false;
}
