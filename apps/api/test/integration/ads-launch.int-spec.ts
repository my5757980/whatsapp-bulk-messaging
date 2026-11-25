import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { AdsStatusProcessor } from '../../src/modules/ads/sync/ads-status.processor.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T024 (feature 007 US2, FR-005 – FR-017, research R3 – R6): building and launching Click-to-WhatsApp
// ads against a faked Marketing API: drafts with the shared rules, targeting search and estimates, the
// minimum budget, the launch order and payloads, rollback on failure and a clean retry, the status job
// with rejections and resubmits, Meta-side pauses, the connection's ERROR state and permissions.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;

describe('Ad campaigns: build and launch (007 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let numberId: string;
  let wabaId: string;
  let imageId: string;
  let gifId: string;
  let graph: FakeAdsGraph;

  const send = (who: SignedInAgent, method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const input = (overrides: Json = {}): Json => ({
    name: uniq('Spring sale '),
    goal: 'CHATS',
    numberId,
    prefilledMessage: 'Hi, I saw your ad',
    targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }], ageMin: 25, ageMax: 45 },
    placements: { auto: true },
    dailyBudgetMinor: 5_000,
    startAt: new Date(Date.now() - 3_600_000).toISOString(),
    versions: [{ mediaAssetId: imageId, primaryText: 'Spring sale: 30% off shoes', headline: 'Chat with us', callToAction: 'WHATSAPP_MESSAGE' }],
    ...overrides,
  });
  const create = async (overrides: Json = {}) => {
    const res = await send(manager, 'post', '/ads/campaigns', input(overrides));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Json;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx);
    numberId = number.id;
    wabaId = number.wabaId;
    const storage = ctx.app.get(StorageService);
    const key = `library/ad-${randomUUID()}.jpg`;
    await storage.put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    imageId = (await ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 200_000, purpose: 'LIBRARY', uploadedById: admin.userId } })).id;
    gifId = (await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ad-${randomUUID()}.gif`, mimeType: 'image/gif', sizeBytes: 1_000, purpose: 'LIBRARY' } })).id;
    graph = new FakeAdsGraph();
    graph.install();
  });

  beforeEach(async () => {
    await seedAdsConnection(ctx);
    graph.failAt = null;
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('creates, changes and deletes drafts with the rules per goal and 1–5 versions', async () => {
    const draft = await create();
    expect(draft).toMatchObject({ status: 'DRAFT', goal: 'CHATS', currency: 'AED', dailyBudgetMinor: 5_000, numberId, prefilledMessage: 'Hi, I saw your ad', spendMinor: 0, chatsStarted: 0, leads: 0 });
    expect(draft.versions).toEqual([expect.objectContaining({ position: 1, mediaKind: 'IMAGE', status: 'DRAFT', metaAdId: null })]);

    const noChat = await send(manager, 'post', '/ads/campaigns', input({ numberId: null, prefilledMessage: null }));
    expect(noChat.status).toBe(422);
    expect(noChat.body.details.map((d: Json) => d.field)).toEqual(expect.arrayContaining(['numberId', 'prefilledMessage']));
    const six = Array.from({ length: 6 }, () => input().versions[0]);
    expect((await send(manager, 'post', '/ads/campaigns', input({ versions: six }))).status).toBe(422);
    const gif = await send(manager, 'post', '/ads/campaigns', input({ versions: [{ ...input().versions[0], mediaAssetId: gifId }] }));
    expect(gif.status).toBe(422);
    expect(gif.body.details).toContainEqual({ field: 'versions[0].mediaAssetId', issue: 'must be a JPG or PNG image, or an MP4 or MOV video' });
    const wrongButton = await send(manager, 'post', '/ads/campaigns', input({ versions: [{ ...input().versions[0], callToAction: 'SHOP_NOW' }] }));
    expect(wrongButton.body.details).toContainEqual({ field: 'versions[0].callToAction', issue: 'must be one of WHATSAPP_MESSAGE' });
    const taken = await send(manager, 'post', '/ads/campaigns', input({ name: draft.name }));
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NAME_TAKEN');

    const changed = await send(manager, 'patch', `/ads/campaigns/${draft.id}`, {
      name: `${draft.name} v2`,
      versions: [input().versions[0], { ...input().versions[0], primaryText: 'Second text', headline: 'Second headline' }],
    });
    expect(changed.status).toBe(200);
    expect(changed.body.versions).toHaveLength(2);
    const v2 = changed.body.versions[1] as Json;
    const edited = await send(manager, 'put', `/ads/campaigns/${draft.id}/versions/${v2.id}`, { ...input().versions[0], primaryText: 'Edited text' });
    expect(edited.status).toBe(200);
    expect(edited.body.versions[1].primaryText).toBe('Edited text');

    expect((await send(manager, 'delete', `/ads/campaigns/${draft.id}`)).status).toBe(204);
    expect((await manager.agent.get(`/api/ads/campaigns/${draft.id}`)).status).toBe(404);
    // The name is free again once the draft is deleted.
    expect((await send(manager, 'post', '/ads/campaigns', input({ name: `${draft.name} v2` }))).status).toBe(201);
  });

  it('searches places and interests and gives the estimate with the minimum budget', async () => {
    const places = await manager.agent.get('/api/ads/targeting/locations').query({ q: 'Dub' });
    expect(places.status).toBe(200);
    expect(places.body).toEqual([{ key: '3005', name: 'Dubai', type: 'region', countryCode: 'AE', audienceLower: null, audienceUpper: null }]);
    const interests = await manager.agent.get('/api/ads/targeting/interests').query({ q: 'sho' });
    expect(interests.body[0]).toMatchObject({ key: '6003348604581', name: 'Shoes', audienceLower: 1_200_000 });
    const estimate = await send(manager, 'post', '/ads/targeting/estimate', { goal: 'CHATS', targeting: input().targeting, placements: { auto: true } });
    expect(estimate.status).toBe(200);
    expect(estimate.body).toEqual({ audienceLower: 120_000, audienceUpper: 150_000, currency: 'AED', minDailyBudgetMinor: 400 });
    const bad = await send(manager, 'post', '/ads/targeting/estimate', { goal: 'CHATS', targeting: { ...input().targeting, ageMin: 40, ageMax: 30 } });
    expect(bad.status).toBe(422);
    await ctx.prisma.adsConnection.deleteMany();
    const notConnected = await manager.agent.get('/api/ads/targeting/locations').query({ q: 'Dub' });
    expect(notConnected.status).toBe(409);
    expect(notConnected.body.code).toBe('NOT_CONNECTED');
  });

  it('refuses a budget below Meta’s minimum, and a number not linked to the page', async () => {
    const low = await create({ dailyBudgetMinor: 300 });
    const res = await send(manager, 'post', `/ads/campaigns/${low.id}/submit`);
    expect(res.status).toBe(422);
    expect(res.body.details).toContainEqual({ field: 'dailyBudgetMinor', issue: "must be at least 400 (Meta's minimum for this account) — AED 4.00" });

    await seedAdsConnection(ctx, { checks: { checks: [], ready: true, linkedNumbers: ['+971 4 000 0000'] } });
    const unlinked = await create();
    const refused = await send(manager, 'post', `/ads/campaigns/${unlinked.id}/submit`);
    expect(refused.status).toBe(422);
    expect(refused.body.details.map((d: Json) => d.field)).toContain('numberId');
  });

  it('submits a chat ad: media, the welcome message, creatives, campaign, ad set and ads, then In review', async () => {
    const draft = await create();
    const res = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('IN_REVIEW');
    expect(res.body.versions[0]).toMatchObject({ status: 'IN_REVIEW', metaAdId: expect.any(String) });

    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: draft.id }, include: { versions: true } });
    const sequence = graph.sequences.find((s) => s.sequenceId === row.welcomeSequenceId)!;
    expect(sequence.wabaId).toBe(wabaId);
    expect(JSON.parse(sequence.welcome_message_sequence).autofill_message.content).toBe('Hi, I saw your ad');
    const creative = graph.creatives.get(row.versions[0]!.metaCreativeId!)!;
    expect(creative.object_story_spec).toMatchObject({
      page_id: 'P1',
      link_data: { message: 'Spring sale: 30% off shoes', name: 'Chat with us', image_hash: row.versions[0]!.metaImageHash, call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } },
    });
    expect(creative.asset_feed_spec.additional_data.partner_app_welcome_message_flow_id).toBe(row.welcomeSequenceId);
    expect(graph.campaigns.get(row.metaCampaignId!)).toMatchObject({ objective: 'OUTCOME_ENGAGEMENT', special_ad_categories: [], status: 'ACTIVE' });
    const adset = graph.adsets.get(row.metaAdsetId!)!;
    expect(adset).toMatchObject({
      campaign_id: row.metaCampaignId,
      daily_budget: 5_000,
      billing_event: 'IMPRESSIONS',
      destination_type: 'WHATSAPP',
      optimization_goal: 'CONVERSATIONS',
      promoted_object: { page_id: 'P1', whatsapp_phone_number: '+15550100001' },
      targeting: { geo_locations: { countries: ['AE'] }, age_min: 25, age_max: 45 },
    });
    // A start in the past becomes now.
    expect(new Date(adset.start_time).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(graph.adsOf(row.metaAdsetId!)).toHaveLength(1);
    expect(graph.order.slice(-4)).toEqual(['adcreatives', 'campaigns', 'adsets', 'ads']);

    const again = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_SUBMITTABLE');
    const audits = await ctx.prisma.auditLog.findMany({ where: { targetId: draft.id } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['ad_campaign.created', 'ad_campaign.submitted']));
  });

  it('rolls back when the ad set fails, shows Meta’s message, and a retry starts clean', async () => {
    const draft = await create();
    graph.failAt = 'adsets';
    const imagesBefore = graph.images;
    const failed = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('META_REFUSED');
    expect(failed.body.message).toContain('The audience is too narrow for this budget.');
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: draft.id }, include: { versions: true } });
    expect(row).toMatchObject({ status: 'ERROR', metaCampaignId: null, metaAdsetId: null });
    expect(row.lastError).toContain('too narrow');
    // The campaign and the creative made before the failure were deleted.
    expect(graph.deleted.length).toBeGreaterThanOrEqual(2);
    expect((await manager.agent.get(`/api/ads/campaigns/${draft.id}`)).body.lastError).toContain('too narrow');

    graph.failAt = null;
    const retried = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'IN_REVIEW', lastError: null });
    // The uploaded image and the welcome message sequence are reused.
    expect(graph.images).toBe(imagesBefore + 1);
    expect(graph.sequences.filter((s) => s.sequenceId === row.welcomeSequenceId)).toHaveLength(1);
  });

  it('follows Meta’s review: approved, rejected with the reason, resubmitted after an edit, and paused in Meta’s tools', async () => {
    const draft = await create({ versions: [input().versions[0], { ...input().versions[0], primaryText: 'We guarantee results', headline: 'Second' }] });
    await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: draft.id }, include: { versions: { orderBy: { position: 'asc' } } } });
    const [v1, v2] = row.versions;
    const processor = ctx.app.get(AdsStatusProcessor);
    expect(await processor.followUp({ campaignId: draft.id, attempt: 0 })).toBe('IN_REVIEW');

    graph.ads.get(v1!.metaAdId!)!.effective = 'ACTIVE';
    Object.assign(graph.ads.get(v2!.metaAdId!)!, { effective: 'DISAPPROVED', feedback: { global: { 'Unrealistic outcomes': 'Ads may not promise results.' } } });
    expect(await processor.syncAll()).toBeGreaterThanOrEqual(1);
    let read = (await manager.agent.get(`/api/ads/campaigns/${draft.id}`)).body as Json;
    expect(read.status).toBe('ACTIVE');
    expect(read.versions[0].status).toBe('ACTIVE');
    expect(read.versions[1]).toMatchObject({ status: 'REJECTED', reviewFeedback: 'Ads may not promise results.' });
    const alerts = await ctx.prisma.notification.findMany({ where: { type: 'AD_REJECTED', userId: { in: [manager.userId, admin.userId] } } });
    expect(new Set(alerts.map((a) => a.userId))).toEqual(new Set([manager.userId, admin.userId]));

    const fixed = await send(manager, 'put', `/ads/campaigns/${draft.id}/versions/${v2!.id}`, { ...input().versions[0], primaryText: 'Spring sale on shoes' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.versions[1]).toMatchObject({ status: 'REJECTED', edited: true });
    expect((await send(manager, 'put', `/ads/campaigns/${draft.id}/versions/${v1!.id}`, input().versions[0])).status).toBe(409);
    const resubmitted = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
    expect(resubmitted.body.versions[1]).toMatchObject({ status: 'IN_REVIEW', reviewFeedback: null });
    expect(graph.resubmitted).toContain(v2!.metaAdId);

    graph.campaigns.get(row.metaCampaignId!)!.status = 'PAUSED';
    await processor.syncAll();
    read = (await manager.agent.get(`/api/ads/campaigns/${draft.id}`)).body as Json;
    expect(read.status).toBe('PAUSED');
    // Read, never undone: no change was sent back to Meta.
    expect(graph.updates.filter((u) => u.id === row.metaCampaignId)).toHaveLength(0);
  });

  it('refuses submits while the connection is in error, and keeps building and launching to managers and admins', async () => {
    const draft = await create();
    await ctx.prisma.adsConnection.updateMany({ data: { status: 'ERROR' } });
    const blocked = await send(manager, 'post', `/ads/campaigns/${draft.id}/submit`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CONNECTION_ERROR');
    await ctx.prisma.adsConnection.updateMany({ data: { status: 'CONNECTED' } });

    expect((await send(agent, 'post', `/ads/campaigns/${draft.id}/submit`)).status).toBe(403);
    expect((await send(agent, 'post', '/ads/campaigns', input())).status).toBe(403);
    expect((await agent.agent.get('/api/ads/campaigns')).status).toBe(200);
    const list = (await agent.agent.get('/api/ads/campaigns').query({ status: 'DRAFT' })).body as Json[];
    expect(list.some((c) => c.id === draft.id)).toBe(true);
    expect((await send(admin, 'post', `/ads/campaigns/${draft.id}/submit`)).status).toBe(200);
  });
});
