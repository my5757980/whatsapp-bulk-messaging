import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { META_BASE, META_VERSION, restoreNetwork, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T145: blocking conditions auto-pause campaigns and keep them paused until fixed (FR-027);
// number limit downgrades reach admins.
describe('Automatic pauses and quality alerts', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  const post = (path: string, body?: unknown) => admin.agent.post(path).set('x-csrf-token', admin.csrf).send(body as object);
  const setup = async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contacts = [await seedContact(ctx, uaePhone()), await seedContact(ctx, uaePhone())];
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts });
    return { number, campaign };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('pauses on an expired token, marks the number and refuses to resume until the token is fixed', async () => {
    const { number, campaign } = await setup();
    await ctx.app.get(DispatcherProcessor).tick(campaign.id);
    const [first, second] = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id }, orderBy: { id: 'asc' } });
    nock(META_BASE)
      .post(`/${META_VERSION}/${number.phoneNumberId}/messages`)
      .reply(401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } });

    const sender = ctx.app.get(SendProcessor);
    expect(await sender.process(first!.id, 1)).toMatchObject({ result: 'blocked' });
    expect(await sender.process(second!.id, 1)).toEqual({ result: 'ignored' }); // back to PENDING by the pause

    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ state: 'PAUSED', pausedReason: 'meta_error_190' });
    expect(await ctx.prisma.message.count({ where: { campaignId: campaign.id, status: 'PENDING' } })).toBe(2);
    const marked = await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: number.id } });
    expect(marked.connectionStatus).toBe('ERROR');
    expect(marked.lastError).toMatch(/token/i);
    expect(await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'CREDENTIALS_FAILED' } })).toBeGreaterThanOrEqual(1);

    const refused = await post(`/api/campaigns/${campaign.id}/resume`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not connected/i);

    nock(META_BASE)
      .get(`/${META_VERSION}/${number.phoneNumberId}`)
      .query(true)
      .reply(200, { id: number.phoneNumberId, display_phone_number: '+1 555 010 0001', verified_name: 'Acme Test', quality_rating: 'GREEN' });
    expect((await admin.agent.patch(`/api/numbers/${number.id}`).set('x-csrf-token', admin.csrf).send({ accessToken: 'fresh-token' })).status).toBe(200);
    expect((await post(`/api/campaigns/${campaign.id}/resume`)).status).toBe(200);
  });

  it('pauses when the number is disconnected and refuses to resume', async () => {
    const { number, campaign } = await setup();
    expect((await admin.agent.delete(`/api/numbers/${number.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ state: 'PAUSED', pausedReason: 'number_disconnected' });
    expect((await post(`/api/campaigns/${campaign.id}/resume`)).status).toBe(409);
  });

  it('records limit changes and alerts admins on a downgrade', async () => {
    const number = await seedNumber(ctx, { displayPhoneNumber: '+1 555-010-4242', messagingLimitTier: 'TIER_10K', qualityRating: 'GREEN' });
    const deliver = async (value: Record<string, unknown>) => {
      nock(META_BASE)
        .get(`/${META_VERSION}/${number.phoneNumberId}`)
        .query(true)
        .reply(200, { id: number.phoneNumberId, display_phone_number: '+1 555-010-4242', verified_name: 'Acme Test', quality_rating: 'YELLOW' });
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ id: number.wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '15550104242', ...value } }] }],
      };
      await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    };
    const drops = () => ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'QUALITY_DROPPED' } });

    await deliver({ event: 'THROUGHPUT_UPGRADE', current_limit: 'TIER_UNLIMITED' });
    expect(await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: number.id } })).toMatchObject({ messagingLimitTier: 'TIER_UNLIMITED', qualityRating: 'YELLOW' });
    expect(await drops()).toBe(0);

    await deliver({ event: 'DOWNGRADE', old_limit: 'TIER_10K', current_limit: 'TIER_2K' });
    expect((await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: number.id } })).messagingLimitTier).toBe('TIER_2K');
    expect(await drops()).toBe(1);
  });
});
