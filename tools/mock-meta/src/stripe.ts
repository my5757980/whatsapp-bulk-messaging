// Feature 008 (T004, T026; contracts/stripe.md "Mock gateway"): a small Stripe for local runs and e2e,
// selected with STRIPE_API_BASE_URL=http://localhost:4010/stripe. State is in memory.
//   rk_test_mockOK1234      every permission
//   rk_test_mockOKnoperm    cannot register webhook endpoints or read events (403)
//   rk_test_mockXXnockout   rejected (401)
//   rk_live_mockOK1234      every permission, live mode (sessions and events carry livemode: true)
// A pay link opens /stripe/pay/<session> with Pay, Decline and Refund half; each sends a signed event
// (Stripe-Signature t=…,v1=…) to the registered endpoint, or to MOCK_STRIPE_WEBHOOK_URL with
// MOCK_STRIPE_WEBHOOK_SECRET when none is registered. Control routes: POST /mock/stripe/pay, /refund,
// /replay, /withhold, /reset and GET /mock/stripe/sessions.
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './env.js';

const KEY = /^(rk|sk)_(test|live)_mock[A-Za-z0-9]{6,}$/;
/** Stripe's minimum charge per currency in minor units (AED 2.00); others are not needed in tests. */
const MINIMUM: Record<string, number> = { aed: 200, usd: 50 };

interface Session {
  id: string;
  object: 'checkout.session';
  mode: 'payment';
  status: 'open' | 'complete' | 'expired';
  payment_status: 'unpaid' | 'paid';
  amount_total: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
  client_reference_id: string | null;
  payment_intent: string | null;
  url: string;
  success_url: string;
  expires_at: number;
  created: number;
  livemode: boolean;
  /** Not a Stripe field: the payment intent metadata, copied onto payment intent events. */
  piMetadata: Record<string, string>;
  refunded: number;
}

interface Endpoint {
  id: string;
  object: 'webhook_endpoint';
  url: string;
  secret: string;
  enabled_events: string[];
  api_version: string | null;
  status: 'enabled';
}

interface StripeEvent {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  api_version: string;
  data: { object: unknown };
}

const sessions = new Map<string, Session>();
const endpoints = new Map<string, Endpoint>();
const events: StripeEvent[] = [];
const idempotent = new Map<string, { status: number; body: unknown }>();
let withhold = false;

const rand = (n = 14) => randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const now = () => Math.floor(Date.now() / 1000);

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function stripeError(res: ServerResponse, status: number, type: string, message: string, code?: string): true {
  return send(res, status, { error: { type, message, ...(code ? { code } : {}) } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** application/x-www-form-urlencoded with bracketed keys, kept flat ("metadata[x]" → value). */
function form(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(raw)) out.set(key, [...(out.get(key) ?? []), value]);
  return out;
}
const one = (f: Map<string, string[]>, key: string) => f.get(key)?.[0];
function prefixed(f: Map<string, string[]>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of f) {
    if (key.startsWith(`${prefix}[`) && key.endsWith(']')) out[key.slice(prefix.length + 1, -1)] = values[0] ?? '';
  }
  return out;
}

function sign(secret: string, raw: string): string {
  const t = now();
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

async function deliver(event: StripeEvent): Promise<void> {
  if (withhold) return;
  const raw = JSON.stringify(event);
  const targets = [...endpoints.values()].filter((e) => e.enabled_events.includes(event.type) || e.enabled_events.includes('*'));
  if (targets.length === 0 && process.env.MOCK_STRIPE_WEBHOOK_URL) {
    targets.push({ url: process.env.MOCK_STRIPE_WEBHOOK_URL, secret: process.env.MOCK_STRIPE_WEBHOOK_SECRET ?? '' } as Endpoint);
  }
  for (const target of targets) {
    try {
      await fetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(target.secret, raw) }, body: raw });
    } catch (error) {
      console.warn(`mock-stripe: delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function emit(type: string, object: unknown, livemode = false): StripeEvent {
  const event: StripeEvent = { id: `evt_${rand(20)}`, object: 'event', type, created: now(), livemode, api_version: process.env.STRIPE_API_VERSION ?? '2026-09-30.endive', data: { object } };
  events.push(event);
  void deliver(event);
  return event;
}

const publicSession = (s: Session) => {
  const { piMetadata: _pi, refunded: _r, ...rest } = s;
  return rest;
};

function pay(session: Session): void {
  if (session.status !== 'open') return;
  session.status = 'complete';
  session.payment_status = 'paid';
  session.payment_intent = `pi_${rand(20)}`;
  emit('checkout.session.completed', publicSession(session), session.livemode);
}

function decline(session: Session): void {
  emit('payment_intent.payment_failed', {
    id: session.payment_intent ?? `pi_${rand(20)}`,
    object: 'payment_intent',
    amount: session.amount_total,
    currency: session.currency,
    metadata: session.piMetadata,
    // Card details on purpose: the platform must strip them before storing (T093, SC-004).
    last_payment_error: {
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
      payment_method: { id: `pm_${rand(14)}`, card: { brand: 'visa', last4: '0002', exp_month: 12, exp_year: 2030 }, billing_details: { name: 'Test Customer' } },
    },
  }, session.livemode);
}

function refund(session: Session, amount: number): boolean {
  if (session.payment_status !== 'paid' || !session.payment_intent) return false;
  session.refunded = Math.min(session.amount_total, session.refunded + amount);
  emit('charge.refunded', {
    id: `ch_${rand(20)}`,
    object: 'charge',
    payment_intent: session.payment_intent,
    amount: session.amount_total,
    amount_refunded: session.refunded,
    refunded: session.refunded >= session.amount_total,
    currency: session.currency,
    metadata: {},
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
    billing_details: { name: 'Test Customer', email: 'customer@example.com', address: { city: 'Dubai', country: 'AE' } },
  }, session.livemode);
  return true;
}

function expireSession(session: Session): void {
  session.status = 'expired';
  emit('checkout.session.expired', publicSession(session), session.livemode);
}

function page(session: Session): string {
  const amount = `${session.currency.toUpperCase()} ${(session.amount_total / 100).toFixed(2)}`;
  const button = (action: string, label: string) =>
    `<form method="post" action="/stripe/pay/${session.id}/${action}"><button type="submit">${label}</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock checkout</title></head><body>
<h1>Mock checkout</h1><p data-testid="amount">${amount}</p><p>${session.description.replace(/</g, '&lt;')}</p>
<p data-testid="status">${session.status} / ${session.payment_status}</p>
${session.status === 'open' ? button('pay', 'Pay') + button('decline', 'Decline') : ''}
${session.payment_status === 'paid' ? button('refund-half', 'Refund half') : ''}
</body></html>`;
}

function redirect(res: ServerResponse, location: string): true {
  res.writeHead(303, { location });
  res.end();
  return true;
}

async function controls(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean | true> {
  if (req.method === 'GET' && url.pathname === '/mock/stripe/sessions') {
    return send(res, 200, { data: [...sessions.values()].map(publicSession), endpoints: [...endpoints.values()].map(({ secret: _s, ...e }) => e) });
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/mock/stripe/')) return false;
  const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string; amount?: number; eventId?: string; on?: boolean };
  const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
  switch (url.pathname) {
    case '/mock/stripe/pay':
      if (!session) return send(res, 404, { error: 'unknown session' });
      pay(session);
      return send(res, 200, publicSession(session));
    case '/mock/stripe/decline':
      if (!session) return send(res, 404, { error: 'unknown session' });
      decline(session);
      return send(res, 200, publicSession(session));
    case '/mock/stripe/refund':
      if (!session || !refund(session, Number(body.amount ?? session.amount_total))) return send(res, 409, { error: 'not paid' });
      return send(res, 200, publicSession(session));
    case '/mock/stripe/replay': {
      const event = events.find((e) => e.id === body.eventId);
      if (!event) return send(res, 404, { error: 'unknown event' });
      const was = withhold;
      withhold = false;
      await deliver(event);
      withhold = was;
      return send(res, 200, { replayed: event.id });
    }
    case '/mock/stripe/withhold':
      withhold = body.on === true;
      return send(res, 200, { withhold });
    case '/mock/stripe/reset':
      sessions.clear();
      endpoints.clear();
      events.length = 0;
      idempotent.clear();
      withhold = false;
      return send(res, 200, { reset: true });
    default:
      return send(res, 404, { error: 'unknown control route' });
  }
}

export async function handleStripe(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const control = await controls(req, res, url);
  if (control) return true;

  // The fake hosted payment page (contracts/stripe.md).
  const hosted = /^\/stripe\/pay\/([^/]+)(?:\/(pay|decline|refund-half))?$/.exec(url.pathname);
  if (hosted) {
    const session = sessions.get(hosted[1] ?? '');
    if (!session) return send(res, 404, { error: 'unknown session' });
    if (req.method === 'GET' && !hosted[2]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(session));
      return true;
    }
    await readBody(req);
    if (hosted[2] === 'pay') {
      if (session.status === 'open' && session.expires_at <= now()) expireSession(session);
      pay(session);
      return redirect(res, session.status === 'complete' ? session.success_url : `/stripe/pay/${session.id}`);
    }
    if (hosted[2] === 'decline') decline(session);
    if (hosted[2] === 'refund-half') refund(session, Math.floor(session.amount_total / 2));
    return redirect(res, `/stripe/pay/${session.id}`);
  }

  if (!url.pathname.startsWith('/stripe/v1/')) return false;
  const auth = req.headers.authorization ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!KEY.test(key) || key.endsWith('nockout')) return stripeError(res, 401, 'invalid_request_error', `Invalid API Key provided: ${key.slice(0, 8)}****`);
  const noPerm = key.endsWith('noperm');
  const path = url.pathname.slice('/stripe/v1/'.length).split('/');
  const raw = req.method === 'POST' ? await readBody(req) : '';
  const idemKey = req.headers['idempotency-key'];
  const remembered = typeof idemKey === 'string' ? idempotent.get(`${key}:${idemKey}`) : undefined;
  if (remembered) return send(res, remembered.status, remembered.body);
  const answer = (status: number, body: unknown): true => {
    if (typeof idemKey === 'string' && req.method === 'POST') idempotent.set(`${key}:${idemKey}`, { status, body });
    return send(res, status, body);
  };

  if (req.method === 'GET' && path[0] === 'account' && path.length === 1) {
    return send(res, 200, {
      id: 'acct_mock000000001',
      object: 'account',
      country: 'AE',
      default_currency: 'aed',
      charges_enabled: true,
      details_submitted: true,
      settings: { dashboard: { display_name: 'Mock Store LLC' } },
      business_profile: { name: 'Mock Store LLC' },
      requirements: { currently_due: [] },
    });
  }

  if (path[0] === 'checkout' && path[1] === 'sessions') {
    const id = path[2];
    if (req.method === 'POST' && !id) {
      const f = form(raw);
      const currency = (one(f, 'line_items[0][price_data][currency]') ?? '').toLowerCase();
      const amount = Number(one(f, 'line_items[0][price_data][unit_amount]') ?? 'NaN');
      const quantity = Number(one(f, 'line_items[0][quantity]') ?? '1');
      if (one(f, 'mode') !== 'payment') return answer(400, { error: { type: 'invalid_request_error', message: 'mode must be payment', param: 'mode' } });
      if (!currency || !Number.isInteger(amount)) return answer(400, { error: { type: 'invalid_request_error', message: 'Missing line_items price_data', param: 'line_items' } });
      if (amount * quantity < (MINIMUM[currency] ?? 50)) {
        return answer(400, { error: { type: 'invalid_request_error', code: 'amount_too_small', message: `Amount must be at least ${(MINIMUM[currency] ?? 50) / 100} ${currency}`, param: 'line_items[0][price_data][unit_amount]' } });
      }
      const created = now();
      const expiresAt = Number(one(f, 'expires_at') ?? created + 86_400);
      if (expiresAt < created + 1800 - 5 || expiresAt > created + 86_400 + 5) {
        return answer(400, { error: { type: 'invalid_request_error', message: 'expires_at must be between 30 minutes and 24 hours from now', param: 'expires_at' } });
      }
      const sessionId = `cs_test_${rand(24)}`;
      const session: Session = {
        id: sessionId,
        object: 'checkout.session',
        mode: 'payment',
        status: 'open',
        payment_status: 'unpaid',
        amount_total: amount * quantity,
        currency,
        description: one(f, 'line_items[0][price_data][product_data][name]') ?? '',
        metadata: prefixed(f, 'metadata'),
        client_reference_id: one(f, 'client_reference_id') ?? null,
        payment_intent: null,
        url: `${env.baseUrl}/stripe/pay/${sessionId}`,
        success_url: one(f, 'success_url') ?? `${env.baseUrl}/`,
        expires_at: expiresAt,
        created,
        livemode: key.includes('_live_'),
        piMetadata: prefixed(f, 'payment_intent_data[metadata]'),
        refunded: 0,
      };
      sessions.set(sessionId, session);
      return answer(200, publicSession(session));
    }
    const session = id ? sessions.get(id) : undefined;
    if (!session) return stripeError(res, 404, 'invalid_request_error', `No such checkout.session: '${id ?? ''}'`, 'resource_missing');
    if (req.method === 'GET' && !path[3]) return send(res, 200, publicSession(session));
    if (req.method === 'POST' && path[3] === 'expire') {
      if (session.status !== 'open') {
        return answer(400, { error: { type: 'invalid_request_error', message: `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".` } });
      }
      expireSession(session);
      return answer(200, publicSession(session));
    }
  }

  if (path[0] === 'webhook_endpoints') {
    if (noPerm) return stripeError(res, 403, 'invalid_request_error', 'The provided key does not have the required permissions for this endpoint (rak_webhook_write).');
    if (req.method === 'POST' && !path[1]) {
      const f = form(raw);
      const endpoint: Endpoint = {
        id: `we_${rand(24)}`,
        object: 'webhook_endpoint',
        url: one(f, 'url') ?? '',
        secret: `whsec_mock${rand(24)}`,
        enabled_events: f.get('enabled_events[]') ?? [],
        api_version: one(f, 'api_version') ?? null,
        status: 'enabled',
      };
      endpoints.set(endpoint.id, endpoint);
      return answer(200, endpoint);
    }
    if (req.method === 'DELETE' && path[1]) {
      if (!endpoints.delete(path[1])) return stripeError(res, 404, 'invalid_request_error', `No such webhook endpoint: '${path[1]}'`, 'resource_missing');
      return send(res, 200, { id: path[1], object: 'webhook_endpoint', deleted: true });
    }
  }

  if (req.method === 'GET' && path[0] === 'events' && path.length === 1) {
    if (noPerm) return stripeError(res, 403, 'invalid_request_error', 'The provided key does not have the required permissions for this endpoint (rak_event_read).');
    const types = url.searchParams.getAll('types[]');
    const after = Number(url.searchParams.get('created[gt]') ?? '0');
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '10'));
    const data = events.filter((e) => (types.length === 0 || types.includes(e.type)) && e.created > after).reverse();
    return send(res, 200, { object: 'list', data: data.slice(0, limit), has_more: data.length > limit, url: '/v1/events' });
  }

  return stripeError(res, 404, 'invalid_request_error', `Unrecognized request URL (${req.method} ${url.pathname})`);
}
