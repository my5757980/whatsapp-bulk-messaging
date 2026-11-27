import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { PaymentGatewayService } from '../../src/modules/payments/gateway/payment-gateway.service.js';
import { clearCommerce } from '../support/commerce.js';
import { FakeStripe, STRIPE_SECRET_KEY, STRIPE_TEST_KEY, STRIPE_WEBHOOK_SECRET } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T023 (feature 008 US1, FR-001 – FR-005, research R3, R4): connecting Stripe against FakeStripe:
// the checks with fixes, automatic and manual notification addresses, keys and secrets encrypted and
// never returned, the notification check (pass and time-out), running the checks again, replacing
// keys, disconnecting, bad webhook signatures, permissions and audit entries without keys.

type Json = Record<string, unknown>;
const byName = (checks: Array<{ check: string }>) => Object.fromEntries(checks.map((c) => [c.check, c])) as Record<string, Json>;

describe('Payments gateway (008 US1)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let stripe: FakeStripe;

  const put = (who: SignedInAgent, body: object) => who.agent.put('/api/payments/gateway').set('X-CSRF-Token', who.csrf).send(body);
  const post = (who: SignedInAgent, url: string) => who.agent.post(`/api${url}`).set('X-CSRF-Token', who.csrf).send({});

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('saves a restricted test key, registers the notification address and never returns the secrets', async () => {
    const res = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'STRIPE', mode: 'TEST', accountName: 'Acme Trading', country: 'AE', currency: 'aed', keyKind: 'restricted', endpointRegistered: true, status: 'CONNECTED' });
    expect(res.body.webhookUrl).toMatch(/\/api\/payments\/stripe\/webhook$/);
    const checks = byName(res.body.checks);
    for (const name of ['KEY_FORMAT', 'KEY_KIND', 'ACCOUNT_READ', 'ACCOUNT_COUNTRY', 'ACCOUNT_CURRENCY', 'CHARGES_ENABLED', 'CHECKOUT_ACCESS', 'WEBHOOK_ENDPOINT']) {
      expect(checks[name]?.result).toBe('PASSED');
    }
    // The endpoint subscribes to the six events on the pinned version.
    const [created] = stripe.callsTo('POST', /^\/v1\/webhook_endpoints$/);
    expect(created?.body['enabled_events[]']).toHaveLength(6);
    expect(created?.body.api_version).toBe('2026-09-30.endive');
    expect(String(created?.body.url)).toMatch(/\/api\/payments\/stripe\/webhook$/);
    // A check session proved the key may make payment pages, and was expired at once.
    const [session] = stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/);
    expect(session?.body['metadata[wbm_check]']).toBe('1');
    expect(stripe.callsTo('POST', /^\/v1\/checkout\/sessions\/.+\/expire$/)).toHaveLength(1);

    const row = await ctx.prisma.paymentGateway.findFirstOrThrow();
    expect(row.secretKeyEnc).not.toContain(STRIPE_TEST_KEY);
    expect(row.webhookSecretEnc).not.toContain(STRIPE_WEBHOOK_SECRET);
    const text = JSON.stringify((await manager.agent.get('/api/payments/gateway')).body) + JSON.stringify(res.body);
    expect(text).not.toContain(STRIPE_TEST_KEY);
    expect(text).not.toContain(STRIPE_WEBHOOK_SECRET);
    expect(text).not.toContain(row.secretKeyEnc);
  });

  it('warns about a secret key and refuses a key Stripe rejects without saving it', async () => {
    const secret = await put(admin, { secretKey: STRIPE_SECRET_KEY, registerEndpoint: true });
    expect(secret.status).toBe(200);
    expect(byName(secret.body.checks).KEY_KIND?.result).toBe('WARNING');

    await clearCommerce(ctx);
    stripe.fail('GET', /^\/v1\/account$/, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: rk_test_****' } });
    const rejected = await put(admin, { secretKey: 'rk_test_wrong00000000001', registerEndpoint: true });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('KEY_INVALID');
    expect(await ctx.prisma.paymentGateway.count()).toBe(0);
  });

  it('saves with ERROR when Stripe cannot take payments yet, naming what is missing', async () => {
    stripe.account = { ...stripe.account, charges_enabled: false, requirements: { currently_due: ['external_account'] } };
    const res = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ERROR');
    expect(byName(res.body.checks).CHARGES_ENABLED).toMatchObject({ result: 'FAILED' });
    expect(String(byName(res.body.checks).CHARGES_ENABLED?.detail)).toContain('external_account');
  });

  it('only warns when the restricted key may not read the account', async () => {
    stripe.accountStatus = 403;
    const res = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONNECTED');
    expect(byName(res.body.checks).ACCOUNT_READ?.result).toBe('WARNING');
  });

  it('fails the address check when the key may not register it, and accepts a pasted signing secret instead', async () => {
    stripe.endpointStatus = 403;
    const refused = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    expect(refused.body.status).toBe('ERROR');
    expect(String(byName(refused.body.checks).WEBHOOK_ENDPOINT?.fix)).toMatch(/signing secret/);

    const missing = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: false });
    expect(missing.status).toBe(422);

    const manual = await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: false, webhookSecret: STRIPE_WEBHOOK_SECRET });
    expect(manual.body).toMatchObject({ status: 'CONNECTED', endpointRegistered: false });
    expect(byName(manual.body.checks).WEBHOOK_ENDPOINT?.result).toBe('PASSED');
  });

  it('passes the notification check when the check session’s expired event arrives signed', async () => {
    await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    const started = await post(admin, '/payments/gateway/notification-check');
    expect(started.status).toBe(202);
    expect(started.body.notificationCheck.status).toBe('PENDING');

    const expired = stripe.events.filter((e) => e.type === 'checkout.session.expired').at(-1)!;
    const delivered = await stripe.deliver(ctx, expired);
    expect(delivered.status).toBe(200);
    expect(delivered.body).toEqual({ received: true });
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(expired.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
    const after = await admin.agent.get('/api/payments/gateway');
    expect(after.body.gateway.notificationCheck.status).toBe('PASSED');
    expect(after.body.gateway.lastEventAt).not.toBeNull();
  });

  it('fails the notification check after two minutes without an event, with the fix', async () => {
    await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    const started = await post(admin, '/payments/gateway/notification-check');
    const row = await ctx.prisma.paymentGateway.findFirstOrThrow();
    const sessionId = (row.notificationCheck as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();
    expect(started.body.notificationCheck.status).toBe('PENDING');
    await ctx.app.get(PaymentGatewayService).notificationCheckTimeout(sessionId);
    const after = (await admin.agent.get('/api/payments/gateway')).body.gateway;
    expect(after.notificationCheck.status).toBe('FAILED');
    expect(after.notificationCheck.fix).toMatch(/signing secret|six events|address/i);
  });

  it('rejects a webhook with a bad signature, records it and changes nothing', async () => {
    await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    const event = stripe.event('checkout.session.completed', { id: 'cs_x', metadata: {} });
    const wrong = await stripe.deliver(ctx, event, { secret: 'whsec_wrong0000000000000001' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('SIGNATURE_INVALID');
    const stale = await stripe.deliver(ctx, event, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.status).toBe(400);
    const missing = await stripe.deliver(ctx, event, { header: '' });
    expect(missing.status).toBe(400);
    const rejected = await ctx.prisma.paymentEvent.findMany({ where: { signatureValid: false } });
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.result === 'REJECTED' && r.stripeEventId === null)).toBe(true);
    expect(await ctx.prisma.paymentEvent.count({ where: { signatureValid: true } })).toBe(0);
  });

  it('stores a repeated event once', async () => {
    await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    const event = stripe.event('customer.created', { id: 'cus_1' });
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    expect(await ctx.prisma.paymentEvent.count({ where: { stripeEventId: String(event.id) } })).toBe(1);
  });

  it('runs the checks again, replaces keys, and disconnects (deleting only the endpoint it made)', async () => {
    await put(admin, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true });
    stripe.account = { ...stripe.account, charges_enabled: false };
    const recheck = await post(admin, '/payments/gateway/recheck');
    expect(recheck.status).toBe(200);
    expect(recheck.body.status).toBe('ERROR');
    const alerts = await ctx.prisma.notification.findMany({ where: { type: 'PAYMENTS_CONNECTION_ERROR', userId: admin.userId } });
    expect(alerts.length).toBeGreaterThan(0);

    stripe.account = { ...stripe.account, charges_enabled: true };
    const replaced = await put(admin, { secretKey: 'rk_test_fake0000000002', registerEndpoint: true });
    expect(replaced.body.status).toBe('CONNECTED');
    const endpoints = [...stripe.endpoints.keys()];
    expect(endpoints).toHaveLength(1);

    const res = await admin.agent.delete('/api/payments/gateway').set('X-CSRF-Token', admin.csrf);
    expect(res.status).toBe(204);
    expect(stripe.endpoints.size).toBe(0);
    expect((await manager.agent.get('/api/payments/gateway')).body).toEqual({ gateway: null });
    expect((await admin.agent.delete('/api/payments/gateway').set('X-CSRF-Token', admin.csrf)).status).toBe(404);

    const audits = await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: 'payments.gateway' }, actorUserId: admin.userId } });
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['payments.gateway_connected', 'payments.gateway_keys_replaced', 'payments.gateway_disconnected']));
    expect(JSON.stringify(audits)).not.toContain(STRIPE_TEST_KEY);
    expect(JSON.stringify(audits)).not.toContain(STRIPE_WEBHOOK_SECRET);
  });

  it('lets only admins change the connection; managers and agents may read it', async () => {
    expect((await put(manager, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true })).status).toBe(403);
    expect((await put(agent, { secretKey: STRIPE_TEST_KEY, registerEndpoint: true })).status).toBe(403);
    expect((await post(manager, '/payments/gateway/notification-check')).status).toBe(403);
    expect((await manager.agent.get('/api/payments/gateway')).status).toBe(200);
    expect((await agent.agent.get('/api/payments/gateway')).status).toBe(403);
    expect((await manager.agent.get('/api/payments/settings')).status).toBe(200);
  });
});
