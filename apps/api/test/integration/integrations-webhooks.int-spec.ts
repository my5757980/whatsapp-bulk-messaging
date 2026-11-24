import { createHmac } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhook, type Hmac } from '@wbm/shared';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhookDeliveryProcessor } from '../../src/modules/integrations/webhooks/webhook-delivery.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T018 (feature 006, US1, FR-001 - FR-009, research R1 - R3): signed outbound webhooks with retries,
// a delivery log, resend, the test event and auto-pause.
const hmac: Hmac = (key, content) => createHmac('sha256', key).update(content).digest('base64');
const HOUR = 3_600_000;

interface Caught {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

describe('Outbound webhooks (006 US1)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let events: OutboundEvents;
  let processor: WebhookDeliveryProcessor;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) =>
    method === 'get' ? who.agent.get(`/api${url}`) : who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});

  /** A nock endpoint that records each request's signature headers and body. */
  const endpointHost = () => `https://${uniq('crm')}.example.test`;
  function catching(host: string, path: string, status: number, times: number, caught: Caught[], delayMs = 0) {
    const headers: Record<string, string> = {};
    const keep = (name: string) => (value: string | null) => {
      headers[name] = value ?? '';
      return true;
    };
    const scope = nock(host, { reqheaders: { 'webhook-id': keep('webhook-id'), 'webhook-timestamp': keep('webhook-timestamp'), 'webhook-signature': keep('webhook-signature') } })
      .post(path, (body: Record<string, unknown>) => {
        caught.push({ headers: { ...headers }, body });
        return true;
      })
      .times(times);
    return delayMs ? scope.delay(delayMs).reply(status, 'ok') : scope.reply(status, 'ok');
  }

  // Endpoints made by a test are removed after it, so later tests (and other test files sharing the
  // database) never fan out to them.
  const made: string[] = [];
  async function createEndpoint(eventTypes: string[], extra: Record<string, unknown> = {}) {
    const host = endpointHost();
    const res = await api(admin, 'post', '/webhook-endpoints', { name: uniq('Endpoint '), url: `${host}/hooks`, eventTypes, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);
    return { id: res.body.id as string, secret: res.body.secret as string, host };
  }

  /** Records an event and returns only this endpoint's deliveries that are due now. */
  async function recordFor(endpoint: { id: string }, type: Parameters<OutboundEvents['record']>[1], data: Record<string, unknown>): Promise<string[]> {
    const due = await events.record(ctx.prisma, type, data);
    const own = await ctx.prisma.webhookDelivery.findMany({ where: { id: { in: due }, endpointId: endpoint.id }, select: { id: true } });
    return due.filter((id) => own.some((d) => d.id === id));
  }

  const deliveriesOf = (endpointId: string) =>
    ctx.prisma.webhookDelivery.findMany({ where: { endpointId }, include: { event: true }, orderBy: { createdAt: 'asc' } });

  const verify = (c: Caught, secret: string) =>
    verifyWebhook({
      hmac,
      secrets: [secret],
      id: c.headers['webhook-id']!,
      timestamp: c.headers['webhook-timestamp']!,
      body: JSON.stringify(c.body),
      header: c.headers['webhook-signature']!,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    events = ctx.app.get(OutboundEvents);
    processor = ctx.app.get(WebhookDeliveryProcessor);
    processor.timeoutMs = 300;
  });

  afterEach(async () => {
    if (made.length) await ctx.prisma.webhookEndpoint.deleteMany({ where: { id: { in: made.splice(0) } } });
    events.invalidate();
    nock.cleanAll();
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('creates an endpoint with its secret shown once, and refuses http, private and local addresses', async () => {
    const created = await createEndpoint(['message.status']);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const read = await api(admin, 'get', `/webhook-endpoints/${created.id}`);
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('secret');
    expect(read.body.secretHint).toBe(`…${created.secret.slice(-4)}`);
    expect(JSON.stringify(read.body)).not.toContain(created.secret);
    const stored = await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.secretEncrypted).not.toContain(created.secret.slice(6, 20));

    for (const url of ['http://crm.example.test/hooks', 'https://10.0.0.1/hooks', 'https://localhost/hooks', 'https://169.254.169.254/latest']) {
      const refused = await api(admin, 'post', '/webhook-endpoints', { name: uniq('Bad '), url, eventTypes: ['message.status'] });
      expect(refused.status, url).toBe(422);
    }
    expect((await api(admin, 'post', '/webhook-endpoints', { name: uniq('None '), url: `${endpointHost()}/x`, eventTypes: [] })).status).toBe(422);
    expect((await api(manager, 'post', '/webhook-endpoints', { name: uniq('Manager '), url: `${endpointHost()}/x`, eventTypes: ['message.status'] })).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'webhook_endpoint.created', targetId: created.id } })).toBe(1);
  });

  it('sends a signed test event and shows the answer', async () => {
    const endpoint = await createEndpoint(['contact.opted_out']);
    const caught: Caught[] = [];
    catching(endpoint.host, '/hooks', 200, 1, caught);
    const res = await api(admin, 'post', `/webhook-endpoints/${endpoint.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(caught).toHaveLength(1);
    expect(caught[0]!.body).toMatchObject({ type: 'test.ping', api_version: '2026-11', data: { endpointId: endpoint.id } });
    expect(caught[0]!.headers['webhook-id']).toBe(caught[0]!.body.id);
    expect(verify(caught[0]!, endpoint.secret)).toBe(true);

    nock(endpoint.host).post('/hooks').reply(503, 'busy');
    const failed = await api(admin, 'post', `/webhook-endpoints/${endpoint.id}/test`);
    expect(failed.body).toMatchObject({ ok: false, statusCode: 503, error: 'HTTP_5XX' });
  });

  it('delivers each chosen event once with its own id, and leaves out content when asked', async () => {
    const statuses = await createEndpoint(['message.status', 'message.received'], { includeContent: false });
    const optOuts = await createEndpoint(['contact.opted_out']);
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const people = [await seedContact(ctx, uaePhone(), { name: 'Sara' }), await seedContact(ctx, uaePhone(), { name: 'Omar' })];
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: people });
    for (const person of people) {
      await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: person.id }, data: { status: 'QUEUED', waMessageId: `wamid.wh.${person.id}` } });
      for (const status of ['sent', 'delivered', 'read']) {
        await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, `wamid.wh.${person.id}`, person.phoneE164.slice(1), status)));
      }
    }
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, people[0]!.phoneE164.slice(1), 'Please call me back')));

    const rows = await deliveriesOf(statuses.id);
    expect(rows.filter((r) => r.event.type === 'message.status')).toHaveLength(6);
    expect(rows.filter((r) => r.event.type === 'message.received')).toHaveLength(1);
    expect(await deliveriesOf(optOuts.id)).toHaveLength(0);

    const caught: Caught[] = [];
    catching(statuses.host, '/hooks', 200, rows.length, caught);
    for (const row of rows) expect(await processor.deliver(row.id)).toBe('delivered');
    expect(caught).toHaveLength(7);
    expect(new Set(caught.map((c) => c.body.id)).size).toBe(7);
    for (const c of caught) expect(verify(c, statuses.secret)).toBe(true);
    const status = caught.find((c) => c.body.type === 'message.status')!.body.data as Record<string, unknown>;
    expect(status).toMatchObject({ message: { origin: 'CAMPAIGN', campaignId: campaign.id }, status: expect.stringMatching(/^(sent|delivered|read)$/) });
    expect((status.contact as Record<string, unknown>).phone).toMatch(/^\+971/);
    const received = caught.find((c) => c.body.type === 'message.received')!.body.data as Record<string, unknown>;
    expect(received).toMatchObject({ contact: { id: people[0]!.id }, message: { type: 'text' } });
    expect(received).not.toHaveProperty('text');
    // A delivery that is done is never sent again by a stray job.
    expect(await processor.deliver(rows[0]!.id)).toBe('skipped');
    expect((await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: rows[0]!.id } })).status).toBe('DELIVERED');
  });

  it('retries a failure with the research waits, and a success makes waiting deliveries due at once', async () => {
    const endpoint = await createEndpoint(['contact.opted_out']);
    const contact = await seedContact(ctx, uaePhone());
    const [first] = await recordFor(endpoint, 'contact.opted_out', { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'MANUAL' });
    const [second] = await recordFor(endpoint, 'contact.opted_out', { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'API' });
    nock(endpoint.host).post('/hooks').reply(500, 'down');
    const before = Date.now();
    expect(await processor.deliver(first!)).toBe('retry');
    const failed = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: first! } });
    expect(failed).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500, lastError: 'HTTP_5XX' });
    expect(failed.nextAttemptAt!.getTime() - before).toBeGreaterThanOrEqual(9_000);
    expect(failed.nextAttemptAt!.getTime() - before).toBeLessThan(12_000);

    // A timeout is a failure too, and the wait grows.
    nock(endpoint.host).post('/hooks').delay(1_000).reply(200, 'late');
    expect(await processor.deliver(first!)).toBe('retry');
    const timedOut = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: first! } });
    expect(timedOut).toMatchObject({ attempts: 2, lastError: 'TIMEOUT' });
    expect(timedOut.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(50_000);

    nock(endpoint.host).post('/hooks').reply(500, 'down');
    expect(await processor.deliver(second!)).toBe('retry');
    expect((await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).consecutiveFailures).toBe(3);

    nock(endpoint.host).post('/hooks').reply(200, 'ok');
    expect(await processor.deliver(first!)).toBe('delivered');
    const after = await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(after).toMatchObject({ consecutiveFailures: 0, failingSince: null });
    expect(after.lastSuccessAt).not.toBeNull();
    const waiting = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: second! } });
    expect(waiting.status).toBe('PENDING');
    expect(waiting.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('pauses an endpoint after 24 hours of failures, tells admins, and resume sends the waiting events', async () => {
    const endpoint = await createEndpoint(['contact.opted_out']);
    const contact = await seedContact(ctx, uaePhone());
    const data = { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'MANUAL' };
    await ctx.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failingSince: new Date(Date.now() - 25 * HOUR), consecutiveFailures: 9 } });
    const [failing] = await recordFor(endpoint, 'contact.opted_out', data);
    nock(endpoint.host).post('/hooks').reply(502, 'gateway');
    expect(await processor.deliver(failing!)).toBe('retry');
    expect((await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).status).toBe('FAILING');
    expect(await ctx.prisma.notification.count({ where: { type: 'WEBHOOK_ENDPOINT_FAILING', userId: admin.userId, link: `/settings/webhooks/${endpoint.id}` } })).toBe(1);

    // Events keep queuing while it is paused, and nothing is sent.
    // A paused endpoint's delivery is not due, so record() does not return it.
    expect(await recordFor(endpoint, 'contact.opted_out', data)).toEqual([]);
    const queued = (await ctx.prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id, id: { not: failing! } }, orderBy: { createdAt: 'desc' } })).id;
    expect((await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: queued } })).nextAttemptAt).toBeNull();
    expect(await processor.deliver(queued)).toBe('paused');

    const resumed = await api(admin, 'post', `/webhook-endpoints/${endpoint.id}/resume`);
    expect(resumed.body).toMatchObject({ status: 'ACTIVE' });
    const caught: Caught[] = [];
    catching(endpoint.host, '/hooks', 200, 2, caught);
    for (const id of [failing!, queued]) {
      expect((await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await processor.deliver(id)).toBe('delivered');
    }
    expect(caught).toHaveLength(2);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'webhook_endpoint.resumed', targetId: endpoint.id } })).toBe(1);
  });

  it('resends with the same event id, and deleting an endpoint cancels its waiting deliveries', async () => {
    const endpoint = await createEndpoint(['contact.opted_out']);
    const contact = await seedContact(ctx, uaePhone());
    const data = { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'MANUAL' };
    const [id] = await recordFor(endpoint, 'contact.opted_out', data);
    const caught: Caught[] = [];
    catching(endpoint.host, '/hooks', 200, 2, caught);
    expect(await processor.deliver(id!)).toBe('delivered');
    const resent = await api(admin, 'post', `/webhook-deliveries/${id}/resend`);
    expect(resent.status).toBe(202);
    expect(resent.body).toMatchObject({ status: 'PENDING' });
    expect(await processor.deliver(id!)).toBe('delivered');
    expect(caught[1]!.headers['webhook-id']).toBe(caught[0]!.headers['webhook-id']);

    const log = await api(admin, 'get', `/webhook-endpoints/${endpoint.id}/deliveries?status=DELIVERED`);
    expect(log.body.total).toBe(1);
    expect(log.body.items[0]).toMatchObject({ id, type: 'contact.opted_out', status: 'DELIVERED', attempts: 2, lastStatusCode: 200 });

    const [waiting] = await recordFor(endpoint, 'contact.opted_out', data);
    expect((await api(admin, 'delete', `/webhook-endpoints/${endpoint.id}`)).status).toBe(204);
    expect(await ctx.prisma.webhookDelivery.count({ where: { id: waiting! } })).toBe(0);
    expect(await processor.deliver(waiting!)).toBe('skipped');
  });

  it('keeps at most 5 deliveries in flight per endpoint, and a slow endpoint does not delay another', async () => {
    const slow = await createEndpoint(['contact.opted_out']);
    const fast = await createEndpoint(['contact.opted_in']);
    const contact = await seedContact(ctx, uaePhone());
    const person = { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'MANUAL' };
    const slowIds: string[] = [];
    for (let i = 0; i < 6; i += 1) slowIds.push(...(await recordFor(slow, 'contact.opted_out', person)));
    const [fastId] = await recordFor(fast, 'contact.opted_in', { ...person, note: 'web form' });
    catching(slow.host, '/hooks', 200, 6, [], 250);
    catching(fast.host, '/hooks', 200, 1, []);

    const slowRuns = slowIds.map((id) => processor.deliver(id));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    expect(await processor.deliver(fastId!)).toBe('delivered');
    expect(Date.now() - started).toBeLessThan(200);
    const outcomes = await Promise.all(slowRuns);
    expect(outcomes.filter((o) => o === 'delivered')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'deferred')).toHaveLength(1);
    const deferred = await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: slowIds[outcomes.indexOf('deferred')]! } });
    expect(deferred).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await processor.inFlight(slow.id)).toBe(0);
  });
});
