import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { AdsConnectionService } from '../../src/modules/ads/connection/ads-connection.service.js';
import { AdsCap } from '../../src/modules/ads/sync/ads-cap.js';
import { localDate } from '../../src/modules/ads/sync/ads-insights.processor.js';
import { AdsStatusProcessor } from '../../src/modules/ads/sync/ads-status.processor.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T044 (feature 007 US5, FR-016 – FR-020, research R6, R7): managing running ads at Meta: pause,
// resume and end; one version at a time; budget and end date changes; duplicates; the monthly spending
// cap on submit, resume and budget increases, and the pause once a month when it is reached; delivery
// problems from the status job; audit entries.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;
const TZ = 'Asia/Dubai';

describe('Managing ads and the spending cap (007 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeAdsGraph;
  let numberId: string;
  let imageId: string;

  const send = (who: SignedInAgent, method: 'post' | 'patch' | 'put', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const version = (text: string) => ({ mediaAssetId: imageId, primaryText: text, headline: 'Chat with us', callToAction: 'WHATSAPP_MESSAGE' });
  /** A chat campaign made at Meta and approved there. */
  const launch = async (versions = 1, budget = 5_000) => {
    const created = await send(manager, 'post', '/ads/campaigns', {
      name: uniq('Manage '),
      goal: 'CHATS',
      numberId,
      prefilledMessage: 'Hi',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }] },
      placements: { auto: true },
      dailyBudgetMinor: budget,
      startAt: new Date().toISOString(),
      versions: Array.from({ length: versions }, (_, i) => version(`Version ${i + 1}`)),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await send(manager, 'post', `/ads/campaigns/${created.body.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: created.body.id }, include: { versions: { orderBy: { position: 'asc' } } } });
    for (const v of row.versions) graph.ads.get(v.metaAdId!)!.effective = 'ACTIVE';
    await ctx.app.get(AdsStatusProcessor).syncCampaign(row, (await accessOf())!);
    return ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: created.body.id }, include: { versions: { orderBy: { position: 'asc' } } } });
  };
  const accessOf = () => ctx.app.get(AdsConnectionService).access();
  const spendToday = async (campaignId: string, spendMinor: number) => {
    await ctx.prisma.adResultDay.create({ data: { adCampaignId: campaignId, day: new Date(`${localDate(new Date(), TZ)}T00:00:00Z`), spendMinor: BigInt(spendMinor), readAt: new Date() } });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    numberId = (await seedNumber(ctx)).id;
    const key = `library/ad-${randomUUID()}.jpg`;
    await ctx.app.get(StorageService).put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    imageId = (await ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 100_000, purpose: 'LIBRARY' } })).id;
    graph = new FakeAdsGraph();
    graph.install();
  });

  beforeEach(async () => {
    await ctx.prisma.adResultDay.deleteMany();
    await seedAdsConnection(ctx);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('pauses, resumes and ends a campaign at Meta', async () => {
    const c = await launch();
    expect(c.status).toBe('ACTIVE');
    const paused = await send(manager, 'post', `/ads/campaigns/${c.id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(graph.campaigns.get(c.metaCampaignId!)!.status).toBe('PAUSED');
    expect((await send(manager, 'post', `/ads/campaigns/${c.id}/pause`)).body.code).toBe('NOT_RUNNING');
    const resumed = await send(manager, 'post', `/ads/campaigns/${c.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('ACTIVE');
    expect(graph.campaigns.get(c.metaCampaignId!)!.status).toBe('ACTIVE');
    expect((await send(manager, 'post', `/ads/campaigns/${c.id}/resume`)).body.code).toBe('NOT_PAUSED');

    const ended = await send(manager, 'post', `/ads/campaigns/${c.id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ENDED');
    expect(ended.body.versions.every((v: Json) => v.status === 'ENDED')).toBe(true);
    expect(graph.campaigns.get(c.metaCampaignId!)!.status).toBe('PAUSED');
    expect((await send(manager, 'post', `/ads/campaigns/${c.id}/end`)).status).toBe(409);
    expect((await send(agent, 'post', `/ads/campaigns/${c.id}/pause`)).status).toBe(403);
    const actions = (await ctx.prisma.auditLog.findMany({ where: { targetId: c.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['ad_campaign.paused', 'ad_campaign.resumed', 'ad_campaign.ended']));
  });

  it('pauses and resumes one version, and changes the budget and end date on the ad set', async () => {
    const c = await launch(2);
    const [v1, v2] = c.versions;
    const one = await send(manager, 'post', `/ads/campaigns/${c.id}/versions/${v1!.id}/pause`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: 'ACTIVE' });
    expect(one.body.versions[0].status).toBe('PAUSED');
    expect(graph.ads.get(v1!.metaAdId!)!.status).toBe('PAUSED');
    const both = await send(manager, 'post', `/ads/campaigns/${c.id}/versions/${v2!.id}/pause`);
    expect(both.body.status).toBe('PAUSED');
    const back = await send(manager, 'post', `/ads/campaigns/${c.id}/versions/${v2!.id}/resume`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'ACTIVE' });
    expect(graph.ads.get(v2!.metaAdId!)!.status).toBe('ACTIVE');
    expect((await send(manager, 'post', `/ads/campaigns/${c.id}/versions/${v2!.id}/resume`)).body.code).toBe('NOT_PAUSED');

    const endAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const changed = await send(manager, 'patch', `/ads/campaigns/${c.id}`, { dailyBudgetMinor: 8_000, endAt });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ dailyBudgetMinor: 8_000, endAt });
    expect(graph.adsets.get(c.metaAdsetId!)).toMatchObject({ daily_budget: 8_000, end_time: endAt });
    const low = await send(manager, 'patch', `/ads/campaigns/${c.id}`, { dailyBudgetMinor: 300 });
    expect(low.status).toBe(422);
    expect((await send(manager, 'patch', `/ads/campaigns/${c.id}`, { name: 'Renamed' })).body.code).toBe('NOT_EDITABLE');
    expect(await ctx.prisma.auditLog.count({ where: { targetId: c.id, action: 'ad_campaign.budget_changed' } })).toBe(1);
  });

  it('duplicates a campaign as a draft without Meta’s ids', async () => {
    const c = await launch();
    const copy = await send(manager, 'post', `/ads/campaigns/${c.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: `${c.name} (copy)`, status: 'DRAFT', dailyBudgetMinor: 5_000 });
    expect(copy.body.versions).toEqual([expect.objectContaining({ position: 1, status: 'DRAFT', metaAdId: null })]);
    expect((await send(manager, 'post', `/ads/campaigns/${c.id}/duplicate`)).body.name).toBe(`${c.name} (copy 2)`);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ad_campaign.duplicated', targetId: copy.body.id } })).toBe(1);
  });

  it('refuses submits, resumes and budget increases that could pass the cap, with the amount left', async () => {
    const running = await launch();
    const paused = await launch();
    await send(manager, 'post', `/ads/campaigns/${paused.id}/pause`);
    await seedAdsConnection(ctx, { monthlyCapMinor: 10_000n });
    await spendToday(running.id, 9_000);

    const draft = await send(manager, 'post', '/ads/campaigns', {
      name: uniq('Over cap '),
      goal: 'CHATS',
      numberId,
      prefilledMessage: 'Hi',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }] },
      placements: { auto: true },
      dailyBudgetMinor: 5_000,
      startAt: new Date().toISOString(),
      versions: [version('Over the cap')],
    });
    const refused = await send(manager, 'post', `/ads/campaigns/${draft.body.id}/submit`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SPEND_CAP' });
    expect(refused.body.message).toContain('AED 10.00 is left this month');
    expect((await send(manager, 'post', `/ads/campaigns/${paused.id}/resume`)).body.code).toBe('SPEND_CAP');
    expect((await send(manager, 'patch', `/ads/campaigns/${running.id}`, { dailyBudgetMinor: 9_000 })).body.code).toBe('SPEND_CAP');
    // Lowering a budget is always allowed.
    expect((await send(manager, 'patch', `/ads/campaigns/${running.id}`, { dailyBudgetMinor: 4_000 })).status).toBe(200);
  });

  it('pauses every running platform campaign once a month when the cap is reached, and alerts', async () => {
    const a = await launch();
    const b = await launch();
    await seedAdsConnection(ctx, { monthlyCapMinor: 10_000n });
    await spendToday(a.id, 10_500);
    const cap = ctx.app.get(AdsCap);
    expect(await cap.enforce()).toBeGreaterThanOrEqual(2);
    for (const c of [a, b]) {
      expect((await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PAUSED');
      expect(graph.campaigns.get(c.metaCampaignId!)!.status).toBe('PAUSED');
    }
    const connection = await ctx.prisma.adsConnection.findFirstOrThrow();
    expect(connection.cappedMonth).toBe(localDate(new Date(), TZ).slice(0, 7));
    const alerts = await ctx.prisma.notification.findMany({ where: { type: 'ADS_SPEND_CAP_REACHED', userId: { in: [admin.userId, manager.userId, agent.userId] } } });
    expect(new Set(alerts.map((n) => n.userId))).toEqual(new Set([admin.userId, manager.userId]));
    // Once a month: a later run does nothing.
    expect(await cap.enforce()).toBe(0);
    // Changing the cap lets the next month's check (or a raised cap) work again.
    const raised = await admin.agent.put('/api/ads/connection/spend-cap').set('X-CSRF-Token', admin.csrf).send({ monthlyCapMinor: 50_000 });
    expect(raised.status).toBe(200);
    expect((await ctx.prisma.adsConnection.findFirstOrThrow()).cappedMonth).toBeNull();
  });

  it('turns a payment problem into ERROR and alerts admins and the campaign’s maker', async () => {
    const c = await launch();
    graph.adsets.get(c.metaAdsetId!)!.status = 'PENDING_BILLING_INFO';
    await ctx.app.get(AdsStatusProcessor).syncAll();
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.status).toBe('ERROR');
    expect(row.lastError).toContain('PENDING_BILLING_INFO');
    const alerts = await ctx.prisma.notification.findMany({ where: { type: 'AD_NOT_DELIVERING', userId: { in: [admin.userId, manager.userId] } } });
    expect(new Set(alerts.map((n) => n.userId))).toEqual(new Set([admin.userId, manager.userId]));
    // Fixed in Meta: the next read clears it.
    graph.adsets.get(c.metaAdsetId!)!.status = 'ACTIVE';
    await ctx.app.get(AdsStatusProcessor).syncAll();
    expect(await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'ACTIVE', lastError: null });
  });
});
