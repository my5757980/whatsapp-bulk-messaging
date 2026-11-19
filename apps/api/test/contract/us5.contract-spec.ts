import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T156: report, rate card and retarget responses match contracts/dashboard-api.openapi.yaml.
describe('US5 dashboard API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let campaignId: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('dashboard-api.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    campaignId = campaign.id;
    await ctx.prisma.message.updateMany({ where: { campaignId }, data: { status: 'FAILED', failureCode: 131026, failureReason: 'Message undeliverable' } });
    await ctx.prisma.campaign.update({ where: { id: campaignId }, data: { state: 'COMPLETED', completedAt: new Date() } });
  });
  afterAll(async () => ctx.close());

  it('rate card', async () => {
    const put = await admin.agent
      .put('/api/rate-card')
      .set('x-csrf-token', admin.csrf)
      .send([{ category: 'UTILITY', countryCode: '*', priceUsd: 0.01, effectiveFrom: '2026-01-01' }]);
    await check('put', '/rate-card', put, 200);
    await check('get', '/rate-card', await admin.agent.get('/api/rate-card'), 200);
  });

  it('report and retarget', async () => {
    await check('get', '/campaigns/{id}/report', await admin.agent.get(`/api/campaigns/${campaignId}/report`), 200);
    const retarget = await admin.agent.post(`/api/campaigns/${campaignId}/retarget`).set('x-csrf-token', admin.csrf).send({ status: 'FAILED' });
    await check('post', '/campaigns/{id}/retarget', retarget, 201);
    await check('get', '/campaigns/{id}', await admin.agent.get(`/api/campaigns/${retarget.body.id}`), 200);
  });
});
