import { randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T061 (feature 007 US8, FR-015, FR-040, research R10, R12): website ads with a counted link at
// /l/a/:code (302 with utm values; previews and robots not counted; the 005 rate limit; ended campaigns
// show a page), visits in the results, and AI-drafted texts within Meta's limits through the 004 service,
// counted against the monthly assistant limit (429 when reached) and never submitted.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;
const CLAUDE = 'https://api.anthropic.com';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

describe('Website ads and AI texts (007 US8)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeAdsGraph;
  let campaign: Json;
  let code: string;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;

  const send = (who: SignedInAgent, method: 'post', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const open = (c: string, userAgent = PHONE_UA, ip = `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`) =>
    request(ctx.server()).get(`/l/a/${c}`).set('User-Agent', userAgent).set('X-Forwarded-For', ip);
  const claude = (options: Json[]) =>
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(200, {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify({ options }) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    await seedAdsConnection(ctx);
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    graph = new FakeAdsGraph();
    graph.install();
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { aiAssistantLimit: 300 } });
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('launches a website ad whose link is the counted /l/a address', async () => {
    const key = `library/web-${randomUUID()}.jpg`;
    await ctx.app.get(StorageService).put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 100_000, purpose: 'LIBRARY' } });
    const input = {
      name: uniq('Spring web '),
      goal: 'WEBSITE',
      websiteUrl: 'https://shop.example.com/spring?ref=ad',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }] },
      placements: { auto: true },
      dailyBudgetMinor: 5_000,
      startAt: new Date().toISOString(),
      versions: [{ mediaAssetId: media.id, primaryText: 'See the spring range', headline: 'Shop now', callToAction: 'SHOP_NOW' }],
    };
    const created = await send(manager, 'post', '/ads/campaigns', input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const plain = await send(manager, 'post', '/ads/campaigns', { ...input, name: uniq('No https '), websiteUrl: 'http://shop.example.com' });
    expect(plain.status).toBe(422);
    expect(plain.body.details).toContainEqual({ field: 'websiteUrl', issue: 'must start with https://' });
    const submitted = await send(manager, 'post', `/ads/campaigns/${created.body.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    campaign = submitted.body;
    expect(campaign.linkUrl).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/a/[0-9A-Za-z]{10}$`));
    code = String(campaign.linkUrl).split('/').pop()!;
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { versions: true } });
    expect(graph.campaigns.get(row.metaCampaignId!)).toMatchObject({ objective: 'OUTCOME_TRAFFIC' });
    expect(graph.adsets.get(row.metaAdsetId!)).toMatchObject({ destination_type: 'WEBSITE', optimization_goal: 'LINK_CLICKS' });
    expect(graph.creatives.get(row.versions[0]!.metaCreativeId!)!.object_story_spec.link_data).toMatchObject({ link: campaign.linkUrl, call_to_action: { type: 'SHOP_NOW', value: { link: campaign.linkUrl } } });
  });

  it('sends visitors on with the utm values and counts real visits only', async () => {
    const res = await open(code);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://shop.example.com/spring?ref=ad&utm_source=meta&utm_medium=paid&utm_campaign=${encodeURIComponent(campaign.name)}`);
    expect(res.headers['cache-control']).toContain('no-store');
    expect((await open(code, 'WhatsApp/2.24.20.72 A')).status).toBe(302);
    expect((await open(code, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).status).toBe(302);
    expect((await request(ctx.server()).head(`/l/a/${code}`).set('User-Agent', PHONE_UA)).status).toBe(302);
    expect(await ctx.prisma.adLinkOpen.count({ where: { adCampaignId: campaign.id } })).toBe(1);
    expect((await open('Zz9Zz9Zz9Z')).status).toBe(404);
    expect((await open('bad')).status).toBe(404);
    const results = await manager.agent.get(`/api/ads/campaigns/${campaign.id}/results`);
    expect(results.body.totals.visits).toBe(1);
  });

  it('applies the 005 per-client limit, and shows a page for ended campaigns', async () => {
    const client = '10.77.0.9';
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) statuses.push((await open('Zz9Zz9Zz9Y', PHONE_UA, client)).status);
    expect(statuses[0]).toBe(404);
    expect(statuses[120]).toBe(429);
    await ctx.prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'ENDED' } });
    const ended = await open(code);
    expect(ended.status).toBe(404);
    expect(ended.text).toContain('This offer has ended');
  });

  it('drafts ad texts within Meta’s limits through the AI service, counted against the monthly limit', async () => {
    const before = await ctx.prisma.aiUsageMonth.findMany();
    claude([
      { primaryText: 'Fresh dates gift boxes for Eid - order on WhatsApp.', headline: 'Eid gifts, delivered' },
      { primaryText: 'x'.repeat(2_500), headline: 'y'.repeat(300) },
      { primaryText: '', headline: 'Empty text is dropped' },
    ]);
    const res = await send(manager, 'post', '/ads/ai-text', { goal: 'CHATS', description: 'Fresh dates gift boxes for Eid, delivered in Dubai', language: 'en' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.options).toHaveLength(2);
    expect(res.body.options[0]).toEqual({ primaryText: 'Fresh dates gift boxes for Eid - order on WhatsApp.', headline: 'Eid gifts, delivered' });
    expect(res.body.options[1].primaryText).toHaveLength(2_200);
    expect(res.body.options[1].headline).toHaveLength(255);
    const after = await ctx.prisma.aiUsageMonth.findMany();
    const total = (rows: Array<{ assistantRequests: number }>) => rows.reduce((s, r) => s + r.assistantRequests, 0);
    expect(total(after)).toBe(total(before) + 1);
    // Nothing was sent to Meta.
    expect(await ctx.prisma.adCampaign.count({ where: { name: { contains: 'Eid' } } })).toBe(0);

    expect((await send(manager, 'post', '/ads/ai-text', { goal: 'CHATS', description: 'short' })).status).toBe(422);
    expect((await send(agent, 'post', '/ads/ai-text', { goal: 'CHATS', description: 'Fresh dates gift boxes for Eid' })).status).toBe(403);
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { aiAssistantLimit: 0 } });
    const limited = await send(manager, 'post', '/ads/ai-text', { goal: 'CHATS', description: 'Fresh dates gift boxes for Eid' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('AI_LIMIT_REACHED');
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { aiAssistantLimit: 300 } });
  });
});
