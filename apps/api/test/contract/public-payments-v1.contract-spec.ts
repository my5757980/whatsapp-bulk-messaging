import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 008 contract tests (T048): the public payments API matches contracts/public-payments-v1.openapi.yaml.
describe('Public payments API (008) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let key: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('public-payments-v1.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearCommerce(ctx);
    new FakeStripe().install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx);
    admin = await signIn(ctx, 'ADMIN');
    const created = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Pay contract '), rateLimitPerMinute: 600 });
    key = created.body.secret;
    await admin.agent.put(`/api/api-keys/${created.body.id}/scopes`).set('X-CSRF-Token', admin.csrf).send({ scopes: ['payments.read', 'payments.write'] });
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('POST, GET and cancel payments', async () => {
    const { contact } = await seedOpenChat(ctx);
    const post = (url: string, body: object) => request(ctx.server()).post(`/api/v1${url}`).set('Authorization', `Bearer ${key}`).set('Idempotency-Key', uniq('idem-')).send(body);
    const get = (url: string) => request(ctx.server()).get(`/api/v1${url}`).set('Authorization', `Bearer ${key}`);
    const made = await post('/payments', { phone: contact.phoneE164, amountMinor: 15000, description: 'Order 1042', reference: 'REF-C1' });
    await check('post', '/payments', made, 201);
    await check('get', '/payments/{id}', await get(`/payments/${made.body.id}`), 200);
    await check('get', '/payments', await get('/payments?reference=REF-C1'), 200);
    await check('post', '/payments/{id}/cancel', await post(`/payments/${made.body.id}/cancel`, {}), 200);
    await check('post', '/payments/{id}/cancel', await post(`/payments/${made.body.id}/cancel`, {}), 409);
  });
});
