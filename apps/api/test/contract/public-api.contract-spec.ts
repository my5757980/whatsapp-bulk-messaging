import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T183: responses match contracts/public-api.openapi.yaml (and the dashboard key endpoints).
describe('Public API v1 contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let secret: string;
  let numberId: string;
  let template: { name: string; language: string };

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('public-api.openapi.yaml', method, route, res.status, res.body);
  };
  const send = (body: unknown, key = secret, idempotencyKey?: string) => {
    const req = request(ctx.server()).post('/api/v1/messages').set('authorization', `Bearer ${key}`);
    if (idempotencyKey) req.set('idempotency-key', idempotencyKey);
    return req.send(body as object);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx);
    numberId = number.id;
    const seeded = await seedTemplate(ctx, number.wabaId);
    template = { name: seeded.name, language: seeded.language };
    const created = await admin.agent.post('/api/api-keys').set('x-csrf-token', admin.csrf).send({ name: 'Contract key', rateLimitPerMinute: 8 });
    await expectMatchesContract('dashboard-api.openapi.yaml', 'post', '/api-keys', created.status, created.body);
    await expectMatchesContract('dashboard-api.openapi.yaml', 'get', '/api-keys', 200, (await admin.agent.get('/api/api-keys')).body);
    secret = created.body.secret;
  });
  afterAll(async () => ctx.close());

  it('send, duplicate, refusals and status', async () => {
    const body = { numberId, to: uaePhone(), template, params: { 'BODY.1': 'Sara' } };
    const key = `idem-${digits(6)}`;
    const accepted = await send(body, secret, key);
    await check('post', '/messages', accepted, 202);
    await check('post', '/messages', await send(body, secret, key), 200);
    await check('post', '/messages', await send({ ...body, params: { 'BODY.1': 'Other' } }, secret, key), 409);
    await check('post', '/messages', await send({ ...body, to: '123' }), 422);
    await check('post', '/messages', await send({ ...body, to: undefined }), 400);
    await check('post', '/messages', await send({ ...body, template: { name: 'missing', language: 'en' } }), 404);
    await check('post', '/messages', await send(body, 'wbk_invalidinvalidinvalidinvalid12'), 401);
    await check('get', '/messages/{id}', await request(ctx.server()).get(`/api/v1/messages/${accepted.body.id}`).set('authorization', `Bearer ${secret}`), 200);
    await check('get', '/templates', await request(ctx.server()).get('/api/v1/templates').set('authorization', `Bearer ${secret}`), 200);
  });

  it('rate limit', async () => {
    let res = await send({ to: 'x', template });
    for (let i = 0; i < 10 && res.status !== 429; i++) res = await send({ to: 'x', template });
    await check('post', '/messages', res, 429);
  });

  it('dashboard API message log', async () => {
    await expectMatchesContract('dashboard-api.openapi.yaml', 'get', '/api-messages', 200, (await admin.agent.get('/api/api-messages')).body);
  });
});
