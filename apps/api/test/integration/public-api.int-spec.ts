import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { sendJobId } from '../../src/modules/sending/dispatch-planner.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { digits, mockMetaSends, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T182: public API v1 - sends, refusals, idempotency, rate limits and status lookups (FR-033-FR-037).
describe('Public API v1', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let secret: string;
  let numberId: string;
  let phoneNumberId: string;
  let utility: { name: string; language: string };
  let marketing: { name: string; language: string };
  let pending: { name: string; language: string };

  const createKey = async (body: Record<string, unknown> = {}) =>
    (await admin.agent.post('/api/api-keys').set('x-csrf-token', admin.csrf).send({ name: `Key ${digits(4)}`, ...body })).body as { id: string; secret: string };
  const send = (body: Record<string, unknown>, key = secret, idempotencyKey?: string) => {
    const req = request(ctx.server()).post('/api/v1/messages').set('authorization', `Bearer ${key}`);
    if (idempotencyKey) req.set('idempotency-key', idempotencyKey);
    return req.send(body);
  };
  const base = (overrides: Record<string, unknown> = {}) => ({ numberId, to: uaePhone(), template: utility, params: { 'BODY.1': 'Sara' }, ...overrides });

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx);
    numberId = number.id;
    phoneNumberId = number.phoneNumberId;
    const ref = (t: { name: string; language: string }) => ({ name: t.name, language: t.language });
    utility = ref(await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' }));
    marketing = ref(await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' }));
    pending = ref(await seedTemplate(ctx, number.wabaId, { status: 'PENDING' }));
    secret = (await createKey()).secret;
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('accepts a valid send, queues it and records an API message', async () => {
    const res = await send(base());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'QUEUED', createdAt: expect.any(String) });
    const message = await ctx.prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(message).toMatchObject({ origin: 'API', status: 'QUEUED', numberId, resolvedParams: { 'BODY.1': 'Sara' } });
    expect(message.apiKeyId).toBeTruthy();
    expect(await ctx.app.get(QueueRegistry).sendQueue(numberId).getJob(sendJobId(res.body.id))).toBeTruthy();
  });

  it('rejects missing, invalid and revoked keys with 401', async () => {
    expect((await request(ctx.server()).post('/api/v1/messages').send(base())).status).toBe(401);
    expect((await send(base(), 'wbk_notarealkeynotarealkeynotareal1')).status).toBe(401);
    const revoked = await createKey();
    await admin.agent.delete(`/api/api-keys/${revoked.id}`).set('x-csrf-token', admin.csrf);
    expect((await send(base(), revoked.secret)).status).toBe(401);
  });

  it('explains why a message cannot be sent', async () => {
    const code = async (body: Record<string, unknown>) => {
      const res = await send(body);
      return `${res.status} ${res.body.code}`;
    };
    expect(await code(base({ template: { name: 'no_such_template', language: 'en_US' } }))).toBe('404 TEMPLATE_NOT_FOUND');
    expect(await code(base({ template: pending }))).toBe('422 TEMPLATE_NOT_APPROVED');
    expect(await code(base({ to: '12345' }))).toBe('422 INVALID_NUMBER');
    expect(await code(base({ params: {} }))).toBe('422 PARAMS_MISMATCH');
    expect(await code(base({ params: { 'BODY.1': 'Sara', 'BODY.9': 'extra' } }))).toBe('422 PARAMS_MISMATCH');

    const optedOut = uaePhone();
    await seedContact(ctx, optedOut, { consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });
    expect(await code(base({ to: optedOut }))).toBe('422 CONTACT_OPTED_OUT');
    // An API call can never undo an opt-out (only the customer or an admin can).
    expect(await code(base({ to: optedOut, contact: { optIn: true, optInSourceNote: 'checkout form' } }))).toBe('422 CONTACT_OPTED_OUT');
    expect(await code(base({ template: marketing }))).toBe('422 NO_OPT_IN');

    await ctx.prisma.whatsAppNumber.update({ where: { id: numberId }, data: { sendingEnabled: false } });
    expect(await code(base())).toBe('422 NUMBER_UNAVAILABLE');
    await ctx.prisma.whatsAppNumber.update({ where: { id: numberId }, data: { sendingEnabled: true } });
    expect(await code(base({ numberId: '0190a000-0000-7000-8000-000000000000' }))).toBe('404 NUMBER_NOT_FOUND');
  });

  it('answers malformed requests with 400 and unknown message ids with 404', async () => {
    const missingTo = await send({ numberId, template: utility });
    expect(missingTo.status).toBe(400);
    expect(missingTo.body).toMatchObject({ code: 'BAD_REQUEST', details: expect.arrayContaining([expect.objectContaining({ field: 'to' })]) });
    expect((await send(base({ unexpected: true }))).status).toBe(400);
    expect((await send(base(), secret, 'k'.repeat(256))).status).toBe(400);
    expect((await request(ctx.server()).get('/api/v1/messages/not-a-uuid').set('authorization', `Bearer ${secret}`)).status).toBe(404);
  });

  it('records an opt-in for new contacts when a source is given', async () => {
    const to = uaePhone();
    const missingNote = await send(base({ to, template: marketing, contact: { name: 'Huda', optIn: true } }));
    expect(missingNote.status).toBe(400);
    expect(missingNote.body.details).toContainEqual({ field: 'contact.optInSourceNote', issue: 'is required to record an opt-in' });
    const res = await send(base({ to, template: marketing, contact: { name: 'Huda', optIn: true, optInSourceNote: 'Website checkout' } }));
    expect(res.status).toBe(202);
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: to } })).toMatchObject({ name: 'Huda', consentStatus: 'OPTED_IN', consentSource: 'API' });
  });

  it('returns the original message for a repeated Idempotency-Key and 409 for a different body', async () => {
    const body = base();
    const key = `order-${digits(8)}`;
    const first = await send(body, secret, key);
    const again = await send(body, secret, key);
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await ctx.prisma.message.count({ where: { phoneE164: body.to as string } })).toBe(1);
    const conflict = await send({ ...body, params: { 'BODY.1': 'Someone else' } }, secret, key);
    expect(conflict.status).toBe(409);
  });

  it('limits requests per key with 429 and Retry-After', async () => {
    const limited = await createKey({ rateLimitPerMinute: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(base(), limited.secret)).status);
    expect(statuses).toEqual([202, 202, 429]);
    const blocked = await send(base(), limited.secret);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('reports status and history only to the key that sent the message', async () => {
    const to = uaePhone();
    const sent = await send(base({ to }));
    mockMetaSends(phoneNumberId, [to]);
    expect(await ctx.app.get(SendProcessor).process(sent.body.id, 1)).toMatchObject({ result: 'sent' });

    const res = await request(ctx.server()).get(`/api/v1/messages/${sent.body.id}`).set('authorization', `Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: sent.body.id, status: 'SENT', failureCode: null, failureReason: null });
    expect(res.body.history.map((h: { status: string }) => h.status)).toEqual(['QUEUED', 'SENT']);

    const other = await createKey();
    expect((await request(ctx.server()).get(`/api/v1/messages/${sent.body.id}`).set('authorization', `Bearer ${other.secret}`)).status).toBe(404);
    nock.cleanAll();
  });

  it('lists approved templates with their variable keys', async () => {
    const res = await request(ctx.server()).get('/api/v1/templates').set('authorization', `Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ name: utility.name, language: utility.language, category: 'UTILITY', variables: ['BODY.1'] });
    expect(res.body.find((t: { name: string }) => t.name === pending.name)).toBeUndefined();
  });

  it('shows API messages in the dashboard log, masked for agents', async () => {
    const admins = await admin.agent.get('/api/api-messages');
    expect(admins.status).toBe(200);
    expect(admins.body.items.length).toBeGreaterThan(0);
    expect(admins.body.items[0].phone).toMatch(/^\+971/);
    const agent = await signIn(ctx, 'AGENT');
    const masked = await agent.agent.get('/api/api-messages');
    expect(masked.body.items[0].phone).toMatch(/^•••• \d{4}$/);
  });
});
