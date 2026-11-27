import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import type { TestContext } from './test-context.js';

// Feature 008 (T018, contracts/stripe.md): a stateful Stripe for integration tests. It answers the
// seven calls of StripeClient on STRIPE_API_BASE_URL (test/setup/env.ts) and makes signed events that
// tests deliver to POST /api/payments/stripe/webhook. Card details are put on events on purpose, so the
// platform's redaction is exercised (SC-004).

export const STRIPE_BASE = 'https://api.stripe.test';
export const STRIPE_TEST_KEY = 'rk_test_fake0000000001';
export const STRIPE_SECRET_KEY = 'sk_test_fake0000000001';
export const STRIPE_WEBHOOK_SECRET = 'whsec_fake000000000000000001';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface FakeSession {
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
  piMetadata: Record<string, string>;
  refunded: number;
}

export interface StripeCall {
  method: string;
  path: string;
  body: Record<string, string | string[]>;
  idempotencyKey: string | null;
  key: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

export class FakeStripe {
  readonly sessions = new Map<string, FakeSession>();
  readonly endpoints = new Map<string, Json>();
  readonly events: Json[] = [];
  readonly calls: StripeCall[] = [];
  private readonly idempotent = new Map<string, [number, unknown]>();
  /** Answers to force: the next `times` calls matching method and path get this status and body. */
  readonly failures: Array<{ method: string; path: RegExp; status: number; body?: unknown; times: number }> = [];
  account: Json = {
    id: 'acct_fake0001',
    object: 'account',
    country: 'AE',
    default_currency: 'aed',
    charges_enabled: true,
    details_submitted: true,
    settings: { dashboard: { display_name: 'Acme Trading' } },
    business_profile: { name: 'Acme LLC' },
    requirements: { currently_due: [] },
  };
  /** Set to 403 to act like a restricted key without that permission. */
  accountStatus = 200;
  endpointStatus = 200;
  eventsStatus = 200;
  livemode = false;
  private n = 0;

  install(): this {
    for (const method of ['get', 'post', 'delete'] as const) {
      const scope = nock(STRIPE_BASE).persist();
      scope[method]((p: string) => p.startsWith('/v1/'))
        .query(true)
        .reply(async (req: Request) => this.route(req));
    }
    return this;
  }

  /** Makes the next matching call fail (e.g. a 503 for a gateway outage). */
  fail(method: string, path: RegExp, status: number, body?: unknown, times = 1): void {
    this.failures.push({ method, path, status, body, times });
  }

  callsTo(method: string, path: RegExp): StripeCall[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.livemode ? '' : 'test_'}${randomUUID().replace(/-/g, '').slice(0, 20)}${this.n}`;
  }

  private async route(req: Request): Promise<[number, unknown]> {
    const url = new URL(req.url);
    const method = req.method;
    const raw = method === 'GET' ? '' : await req.text();
    const body: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(raw)) {
      const prev = body[k];
      body[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const idempotencyKey = req.headers.get('idempotency-key');
    const key = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '') || null;
    this.calls.push({ method, path: url.pathname, body, idempotencyKey, key });

    const failure = this.failures.find((f) => f.method === method && f.path.test(url.pathname) && f.times > 0);
    if (failure) {
      failure.times -= 1;
      return [failure.status, failure.body ?? { error: { type: 'api_error', message: 'Stripe is having trouble' } }];
    }
    const remembered = idempotencyKey ? this.idempotent.get(`${key}:${idempotencyKey}`) : undefined;
    if (remembered) return remembered;
    const answer = (status: number, value: unknown): [number, unknown] => {
      if (idempotencyKey && method === 'POST') this.idempotent.set(`${key}:${idempotencyKey}`, [status, value]);
      return [status, value];
    };
    const one = (k: string) => {
      const v = body[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const prefixed = (prefix: string) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) if (k.startsWith(`${prefix}[`) && k.endsWith(']')) out[k.slice(prefix.length + 1, -1)] = Array.isArray(v) ? (v[0] ?? '') : v;
      return out;
    };
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "v1"

    if (method === 'GET' && parts[0] === 'account') {
      return this.accountStatus === 200 ? [200, this.account] : [this.accountStatus, { error: { type: 'invalid_request_error', message: 'The provided key does not have access to account details' } }];
    }
    if (parts[0] === 'checkout' && parts[1] === 'sessions') {
      if (method === 'POST' && !parts[2]) {
        const amount = Number(one('line_items[0][price_data][unit_amount]'));
        const currency = String(one('line_items[0][price_data][currency]') ?? '');
        if (currency === 'aed' && amount < 200) {
          return answer(400, { error: { type: 'invalid_request_error', code: 'amount_too_small', message: 'Amount must be at least AED 2.00', param: 'line_items[0][price_data][unit_amount]' } });
        }
        const id = this.id('cs');
        const session: FakeSession = {
          id,
          object: 'checkout.session',
          mode: 'payment',
          status: 'open',
          payment_status: 'unpaid',
          amount_total: amount,
          currency,
          description: String(one('line_items[0][price_data][product_data][name]') ?? ''),
          metadata: prefixed('metadata'),
          client_reference_id: (one('client_reference_id') as string | undefined) ?? null,
          payment_intent: null,
          url: `https://checkout.stripe.test/c/pay/${id}`,
          success_url: String(one('success_url') ?? ''),
          expires_at: Number(one('expires_at') ?? now() + 86_400),
          created: now(),
          livemode: this.livemode,
          piMetadata: prefixed('payment_intent_data[metadata]'),
          refunded: 0,
        };
        this.sessions.set(id, session);
        return answer(200, this.publicSession(session));
      }
      const session = parts[2] ? this.sessions.get(parts[2]) : undefined;
      if (!session) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such checkout.session: '${parts[2] ?? ''}'` } }];
      if (method === 'GET') return [200, this.publicSession(session)];
      if (method === 'POST' && parts[3] === 'expire') {
        if (session.status !== 'open') {
          return answer(400, { error: { type: 'invalid_request_error', message: `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".` } });
        }
        session.status = 'expired';
        this.event('checkout.session.expired', this.publicSession(session));
        return answer(200, this.publicSession(session));
      }
    }
    if (parts[0] === 'webhook_endpoints') {
      if (this.endpointStatus !== 200) return [this.endpointStatus, { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions for this endpoint.' } }];
      if (method === 'POST') {
        const endpoint = {
          id: this.id('we'),
          object: 'webhook_endpoint',
          url: one('url'),
          secret: STRIPE_WEBHOOK_SECRET,
          enabled_events: body['enabled_events[]'] ?? [],
          api_version: one('api_version') ?? null,
          status: 'enabled',
        };
        this.endpoints.set(endpoint.id, endpoint);
        return answer(200, endpoint);
      }
      if (method === 'DELETE' && parts[1]) {
        if (!this.endpoints.delete(parts[1])) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such webhook endpoint' } }];
        return [200, { id: parts[1], object: 'webhook_endpoint', deleted: true }];
      }
    }
    if (method === 'GET' && parts[0] === 'events') {
      if (this.eventsStatus !== 200) return [this.eventsStatus, { error: { type: 'invalid_request_error', message: 'The provided key does not have access to events' } }];
      const types = url.searchParams.getAll('types[]');
      const after = Number(url.searchParams.get('created[gt]') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const data = this.events.filter((e) => (types.length === 0 || types.includes(String(e.type))) && Number(e.created) > after).reverse();
      return [200, { object: 'list', data: data.slice(0, limit), has_more: data.length > limit }];
    }
    return [404, { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${method} ${url.pathname})` } }];
  }

  publicSession(session: FakeSession): Json {
    const { piMetadata: _pi, refunded: _r, description: _d, ...rest } = session;
    return rest;
  }

  /** Records an event as Stripe would keep it (for /v1/events) and returns it. */
  event(type: string, object: Json, overrides: Json = {}): Json {
    const event = { id: this.id('evt'), object: 'event', type, created: now(), livemode: this.livemode, api_version: '2026-09-30.endive', data: { object }, ...overrides };
    this.events.push(event);
    return event;
  }

  /** The newest open session made for a payment request. */
  sessionFor(requestId: string): FakeSession | undefined {
    return [...this.sessions.values()].filter((s) => s.metadata.wbm_payment_request === requestId).at(-1);
  }

  pay(sessionId: string): Json {
    const session = this.must(sessionId);
    session.status = 'complete';
    session.payment_status = 'paid';
    session.payment_intent ??= this.id('pi');
    return this.event('checkout.session.completed', this.publicSession(session));
  }

  decline(sessionId: string, declineCode = 'generic_decline'): Json {
    const session = this.must(sessionId);
    return this.event('payment_intent.payment_failed', {
      id: session.payment_intent ?? this.id('pi'),
      object: 'payment_intent',
      amount: session.amount_total,
      currency: session.currency,
      metadata: session.piMetadata,
      last_payment_error: {
        code: 'card_declined',
        decline_code: declineCode,
        message: 'Your card was declined.',
        payment_method: { id: this.id('pm'), card: { brand: 'visa', last4: '0002', exp_month: 12, exp_year: 2030 }, billing_details: { name: 'Test Customer', email: 'customer@example.com' } },
      },
    });
  }

  refund(sessionId: string, amount: number): Json {
    const session = this.must(sessionId);
    session.refunded = Math.min(session.amount_total, session.refunded + amount);
    return this.event('charge.refunded', {
      id: this.id('ch'),
      object: 'charge',
      payment_intent: session.payment_intent,
      amount: session.amount_total,
      amount_refunded: session.refunded,
      refunded: session.refunded >= session.amount_total,
      currency: session.currency,
      metadata: {},
      receipt_email: 'customer@example.com',
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
      billing_details: { name: 'Test Customer', email: 'customer@example.com', address: { city: 'Dubai', country: 'AE' } },
    });
  }

  expire(sessionId: string): Json {
    const session = this.must(sessionId);
    session.status = 'expired';
    return this.event('checkout.session.expired', this.publicSession(session));
  }

  /** The raw body and a valid Stripe-Signature header for an event. */
  signed(event: Json, secret = STRIPE_WEBHOOK_SECRET, timestamp = now()): { raw: string; header: string } {
    const raw = JSON.stringify(event);
    return { raw, header: `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}` };
  }

  /** Posts an event to the webhook route, signed unless a header is given. */
  async deliver(ctx: TestContext, event: Json, opts: { secret?: string; header?: string; timestamp?: number } = {}) {
    const { raw, header } = this.signed(event, opts.secret, opts.timestamp);
    return request(ctx.server())
      .post('/api/payments/stripe/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', opts.header ?? header)
      .send(raw);
  }

  private must(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`FakeStripe: no session ${sessionId}`);
    return session;
  }
}
