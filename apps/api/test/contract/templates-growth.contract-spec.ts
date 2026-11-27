import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { seedAuthTemplate } from '../support/templates.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// Feature 009 contract tests: the dashboard routes match contracts/templates-growth-api.openapi.yaml.
// Each story adds its cases (T022 US1, T032 US2, T051 US4, T060 US5, T068 US6, T083 US8).
describe('Templates and growth API (009) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('templates-growth-api.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  describe('US1 one-time code settings', () => {
    it('GET and PUT /otp/settings', async () => {
      const template = await seedAuthTemplate(ctx, number.wabaId, new FakeTemplatesGraph().install());
      await check('get', '/otp/settings', await manager.agent.get('/api/otp/settings'), 200);
      const put = (body: object) => admin.agent.put('/api/otp/settings').set('X-CSRF-Token', admin.csrf).send(body);
      await check('put', '/otp/settings', await put({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15 }), 200);
      await check('put', '/otp/settings', await put({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 0, limitWindowMinutes: 15 }), 422);
    });
  });
});
