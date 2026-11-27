import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { restoreNetwork, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { apiKeyWithScopes, codeStatus, seedAuthTemplate, sendCode } from '../support/templates.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T022 (feature 009 US1): the one-time code API matches contracts/public-otp-v1.openapi.yaml.
describe('One-time codes API (009) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let key: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('public-otp-v1.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    const fake = new FakeTemplatesGraph().install();
    const template = await seedAuthTemplate(ctx, number.wabaId, fake);
    await admin.agent.put('/api/otp/settings').set('X-CSRF-Token', admin.csrf).send({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15 });
    key = await apiKeyWithScopes(ctx, admin, ['otp.send']);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  it('POST /v1/otp, GET /v1/otp/{id} and the errors', async () => {
    const made = await sendCode(ctx, key, { to: uaePhone(), code: '482913' });
    await check('post', '/v1/otp', made, 202);
    await check('get', '/v1/otp/{id}', await codeStatus(ctx, key, made.body.id), 200);
    await check('get', '/v1/otp/{id}', await codeStatus(ctx, key, '0190a000-0000-7000-8000-000000000000'), 404);
    await check('post', '/v1/otp', await sendCode(ctx, key, { to: '12', code: '482913' }), 422);
    const otherKey = await apiKeyWithScopes(ctx, admin, ['messages.send']);
    await check('post', '/v1/otp', await sendCode(ctx, otherKey, { to: uaePhone(), code: '482913' }), 403);
  });
});
