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

  // T042 (feature 009 US3): offerConfig on the campaign routes, and why messages expired in the report.
  it('offer campaigns and expired messages', async () => {
    const number = await seedNumber(ctx);
    const offer = await seedTemplate(ctx, number.wabaId, {
      category: 'MARKETING',
      kind: 'LIMITED_TIME_OFFER',
      components: [
        { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Weekend deal', has_expiration: true } },
        { type: 'BODY', text: 'Hi {{1}}, 20% off.' },
        { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'WKND20' }, { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}' }] },
      ],
      variables: [{ key: 'BODY.1', example: 'Sara' }, { key: 'BUTTON.1.1', example: 'offer' }],
    });
    const offerConfig = { endsAt: new Date(Date.now() + 86_400_000).toISOString(), code: { source: 'attribute', key: 'offer_code' } };
    const created = await admin.agent.post('/api/campaigns').set('x-csrf-token', admin.csrf).send({ name: 'Weekend offer', numberId: number.id, templateId: offer.id, audienceType: 'ALL_OPTED_IN', offerConfig });
    await check('post', '/campaigns', created, 201);
    expect(created.body.offerConfig).toEqual(offerConfig);
    const updated = await admin.agent.patch(`/api/campaigns/${created.body.id}`).set('x-csrf-token', admin.csrf).send({ offerConfig: { ...offerConfig, code: { source: 'static', value: 'WKND20' } } });
    await check('patch', '/campaigns/{id}', updated, 200);
    expect(updated.body.offerConfig.code).toEqual({ source: 'static', value: 'WKND20' });

    const contact = await seedContact(ctx, uaePhone());
    const ran = await seedRunningCampaign(ctx, { numberId: number.id, templateId: offer.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({ where: { campaignId: ran.id }, data: { status: 'EXPIRED', expiredReason: 'OFFER_ENDED' } });
    const report = await admin.agent.get(`/api/campaigns/${ran.id}/report`);
    await check('get', '/campaigns/{id}/report', report, 200);
    expect(report.body.totals.expired).toBe(1);
    expect(report.body.expired).toEqual({ expiredBeforeSending: 0, notDeliveredInTime: 0, offerEnded: 1 });
    // T060 (US5): replies, repeats and held back.
    expect(report.body).toMatchObject({ replied: 0, replyRate: null, multiMessageRecipients: 0, heldBack: 0 });
    await check('get', '/campaigns/{id}/messages', await admin.agent.get(`/api/campaigns/${ran.id}/messages?replied=true`), 200);
  });
});
