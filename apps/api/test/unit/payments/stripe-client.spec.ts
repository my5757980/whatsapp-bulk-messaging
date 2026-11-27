import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/common/config/config.js';
import { STRIPE_WEBHOOK_EVENTS, StripeApiError, StripeClient, StripeNetworkError, encodeStripeForm } from '../../../src/modules/payments/stripe.client.js';

// T016 (feature 008, contracts/stripe.md): the seven Stripe calls, the form encoding, retries with the
// same idempotency key, and error mapping.
const BASE = 'https://api.stripe.test';
const config = { STRIPE_API_BASE_URL: BASE, STRIPE_API_VERSION: '2026-09-30.endive' } as AppConfig;
const client = new StripeClient(config, { timeoutMs: 500, retryDelaysMs: [1, 1, 1] });
const KEY = 'rk_test_unit0000000001';
const REQ = '0196f1f0-0000-7000-8000-000000000001';

/** nock hands form bodies to matchers as parsed objects (repeated keys as arrays). */
function asParams(body: unknown): URLSearchParams {
  if (typeof body === 'string') return new URLSearchParams(body);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v));
  }
  return params;
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs_test_1',
  object: 'checkout.session',
  url: 'https://checkout.stripe.test/c/pay/cs_test_1',
  status: 'open',
  payment_status: 'unpaid',
  amount_total: 15000,
  currency: 'aed',
  payment_intent: null,
  expires_at: 1_795_003_600,
  metadata: { wbm_payment_request: REQ },
  livemode: false,
  ...overrides,
});

describe('encodeStripeForm', () => {
  it('writes nested objects with brackets and scalar arrays with []', () => {
    const body = encodeStripeForm({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'aed', unit_amount: 15000, product_data: { name: 'Order 1042' } }, quantity: 1 }],
      metadata: { wbm_payment_request: REQ },
      enabled_events: ['checkout.session.completed', 'charge.refunded'],
      skip: undefined,
    });
    expect(decodeURIComponent(body)).toBe(
      [
        'mode=payment',
        'line_items[0][price_data][currency]=aed',
        'line_items[0][price_data][unit_amount]=15000',
        'line_items[0][price_data][product_data][name]=Order+1042',
        'line_items[0][quantity]=1',
        `metadata[wbm_payment_request]=${REQ}`,
        'enabled_events[]=checkout.session.completed',
        'enabled_events[]=charge.refunded',
      ].join('&'),
    );
  });
});

describe('StripeClient', () => {
  it('reads the account', async () => {
    nock(BASE)
      .get('/v1/account')
      .matchHeader('authorization', `Bearer ${KEY}`)
      .matchHeader('stripe-version', '2026-09-30.endive')
      .reply(200, {
        id: 'acct_1',
        country: 'AE',
        default_currency: 'aed',
        charges_enabled: true,
        details_submitted: true,
        settings: { dashboard: { display_name: 'Acme Trading' } },
        business_profile: { name: 'Acme LLC' },
        requirements: { currently_due: [] },
      });
    expect(await client.account(KEY)).toEqual({ id: 'acct_1', name: 'Acme Trading', country: 'AE', defaultCurrency: 'aed', chargesEnabled: true, detailsSubmitted: true, currentlyDue: [] });
  });

  it('creates a Checkout Session with the documented fields and an idempotency key', async () => {
    let sent = '';
    nock(BASE)
      .post('/v1/checkout/sessions', (body: unknown) => {
        sent = asParams(body).toString();
        return true;
      })
      .matchHeader('idempotency-key', `wbm-pr-${REQ}-s1`)
      .matchHeader('content-type', /application\/x-www-form-urlencoded/)
      .reply(200, session());
    const result = await client.createCheckoutSession(KEY, {
      requestId: REQ,
      amountMinor: 15000,
      currency: 'aed',
      description: 'Order 1042',
      reference: 'REF-1042',
      expiresAt: 1_795_003_600,
      successUrl: 'https://go.example.com/l/p/Ab12Cd34?paid=1',
      idempotencyKey: `wbm-pr-${REQ}-s1`,
    });
    expect(result).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1', status: 'open', paymentStatus: 'unpaid', amountTotal: 15000, currency: 'aed', paymentIntentId: null, expiresAt: 1_795_003_600, metadata: { wbm_payment_request: REQ }, livemode: false });
    const fields = new URLSearchParams(sent);
    expect(Object.fromEntries(fields)).toEqual({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'aed',
      'line_items[0][price_data][unit_amount]': '15000',
      'line_items[0][price_data][product_data][name]': 'Order 1042',
      'line_items[0][quantity]': '1',
      client_reference_id: REQ,
      'metadata[wbm_payment_request]': REQ,
      'payment_intent_data[metadata][wbm_payment_request]': REQ,
      'payment_intent_data[description]': 'Order 1042 · REF-1042',
      expires_at: '1795003600',
      success_url: 'https://go.example.com/l/p/Ab12Cd34?paid=1',
      locale: 'auto',
    });
  });

  it('marks the connection check session in its metadata', async () => {
    let sent = '';
    nock(BASE)
      .post('/v1/checkout/sessions', (body: unknown) => {
        sent = asParams(body).toString();
        return true;
      })
      .reply(200, session({ amount_total: 200, metadata: { wbm_check: '1' } }));
    await client.createCheckoutSession(KEY, { requestId: null, check: true, amountMinor: 200, currency: 'aed', description: 'Connection check', expiresAt: 1_795_003_600, successUrl: 'https://go.example.com/l', idempotencyKey: 'wbm-check-1' });
    const fields = Object.fromEntries(new URLSearchParams(sent));
    expect(fields['metadata[wbm_check]']).toBe('1');
    expect(fields.client_reference_id).toBeUndefined();
  });

  it('retrieves and expires sessions; an already-ended session answers with Stripe’s 400', async () => {
    nock(BASE).get('/v1/checkout/sessions/cs_test_1').reply(200, session({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }));
    expect(await client.retrieveCheckoutSession(KEY, 'cs_test_1')).toMatchObject({ status: 'complete', paymentStatus: 'paid', paymentIntentId: 'pi_1' });
    nock(BASE).post('/v1/checkout/sessions/cs_test_1/expire').matchHeader('idempotency-key', 'k-x1').reply(200, session({ status: 'expired' }));
    expect((await client.expireCheckoutSession(KEY, 'cs_test_1', 'k-x1')).status).toBe('expired');
    nock(BASE)
      .post('/v1/checkout/sessions/cs_test_1/expire')
      .reply(400, { error: { type: 'invalid_request_error', message: 'Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "complete".' } });
    const error = await client.expireCheckoutSession(KEY, 'cs_test_1', 'k-x2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect((error as StripeApiError).status).toBe(400);
  });

  it('registers and deletes the webhook endpoint; a missing endpoint counts as deleted', async () => {
    let sent = '';
    nock(BASE)
      .post('/v1/webhook_endpoints', (body: unknown) => {
        sent = asParams(body).toString();
        return true;
      })
      .reply(200, { id: 'we_1', object: 'webhook_endpoint', url: 'https://app.example.com/api/payments/stripe/webhook', secret: 'whsec_abc123def456' });
    expect(await client.createWebhookEndpoint(KEY, { url: 'https://app.example.com/api/payments/stripe/webhook', idempotencyKey: 'wbm-endpoint-1' })).toEqual({ id: 'we_1', secret: 'whsec_abc123def456', url: 'https://app.example.com/api/payments/stripe/webhook' });
    const fields = new URLSearchParams(sent);
    expect(fields.getAll('enabled_events[]')).toEqual([...STRIPE_WEBHOOK_EVENTS]);
    expect(fields.get('api_version')).toBe('2026-09-30.endive');
    nock(BASE).delete('/v1/webhook_endpoints/we_1').reply(200, { id: 'we_1', deleted: true });
    await expect(client.deleteWebhookEndpoint(KEY, 'we_1')).resolves.toBeUndefined();
    nock(BASE).delete('/v1/webhook_endpoints/we_gone').reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such webhook endpoint' } });
    await expect(client.deleteWebhookEndpoint(KEY, 'we_gone')).resolves.toBeUndefined();
  });

  it('lists events by type after a time', async () => {
    nock(BASE)
      .get('/v1/events')
      .query((q) => q['created[gt]'] === '1795000000' && Array.isArray(q['types[]']) && (q['types[]'] as string[]).length === STRIPE_WEBHOOK_EVENTS.length && q.limit === '100')
      .reply(200, { object: 'list', data: [{ id: 'evt_2' }, { id: 'evt_1' }], has_more: true });
    expect(await client.listEvents(KEY, { createdAfter: 1_795_000_000 })).toEqual({ data: [{ id: 'evt_2' }, { id: 'evt_1' }], hasMore: true });
  });

  it('retries 429, 5xx and network errors with the same idempotency key, then gives up', async () => {
    const keys: string[] = [];
    nock(BASE)
      .post('/v1/checkout/sessions/cs_test_1/expire')
      .times(2)
      .reply(async (request: Request) => {
        keys.push(String(request.headers.get('idempotency-key')));
        return [keys.length === 1 ? 429 : 503, { error: { type: 'api_error', message: 'busy' } }];
      })
      .post('/v1/checkout/sessions/cs_test_1/expire')
      .reply(async (request: Request) => {
        keys.push(String(request.headers.get('idempotency-key')));
        return [200, session({ status: 'expired' })];
      });
    expect((await client.expireCheckoutSession(KEY, 'cs_test_1', 'k-retry')).status).toBe('expired');
    expect(keys).toEqual(['k-retry', 'k-retry', 'k-retry']);

    nock(BASE).get('/v1/account').times(4).replyWithError({ code: 'ECONNRESET' });
    await expect(client.account(KEY)).rejects.toBeInstanceOf(StripeNetworkError);
  });

  it('maps Stripe errors with their type, code, decline code and param, without retrying 4xx', async () => {
    nock(BASE)
      .post('/v1/checkout/sessions')
      .once()
      .reply(400, { error: { type: 'invalid_request_error', code: 'amount_too_small', message: 'Amount must be at least AED 2.00', param: 'line_items[0][price_data][unit_amount]' } });
    const error = (await client
      .createCheckoutSession(KEY, { requestId: REQ, amountMinor: 100, currency: 'aed', description: 'x', expiresAt: 1, successUrl: 'https://x', idempotencyKey: 'k' })
      .catch((e: unknown) => e)) as StripeApiError;
    expect(error).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'amount_too_small', param: 'line_items[0][price_data][unit_amount]', declineCode: null });
    expect(error.message).toContain('AED 2.00');
    nock(BASE).get('/v1/account').reply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: rk_test_****' } });
    await expect(client.account(KEY)).rejects.toMatchObject({ status: 401 });
  });
});
