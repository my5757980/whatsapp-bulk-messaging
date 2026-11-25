import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdsInsightsProcessor, localDate } from '../../src/modules/ads/sync/ads-insights.processor.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, seedContact, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T038 (feature 007 US4, FR-026 – FR-029, research R7): Meta's numbers per version and per day from
// the hourly insights job (and the daily 28-day refresh), with the platform's own counts, the costs per
// chat and lead, the CSV export and the list's spend and chats, in the account's time zone and currency.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response bodies
type Json = Record<string, any>;
const TZ = 'Asia/Dubai';
const HOUR = 3_600_000;
const CONVERSATION = 'onsite_conversion.messaging_conversation_started_7d';

describe('Ad results (007 US4)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeAdsGraph;
  let campaign: Json;
  const suffix = randomUUID().slice(0, 6);
  const metaCampaignId = `MC${suffix}`;
  const now = new Date();
  const today = localDate(now, TZ);
  const yesterday = localDate(now, TZ, -1);
  const fiveDaysAgo = localDate(now, TZ, -5);

  const row = (date: string, n: { impressions: number; reach: number; clicks: number; spend: string; conversations: number; leads?: number }, adId?: string) => ({
    ...(adId ? { ad_id: adId } : {}),
    date_start: date,
    impressions: String(n.impressions),
    reach: String(n.reach),
    clicks: String(n.clicks),
    spend: n.spend,
    actions: [{ action_type: CONVERSATION, value: String(n.conversations) }, ...(n.leads ? [{ action_type: 'lead', value: String(n.leads) }] : [])],
  });
  const results = async (query = '') => (await manager.agent.get(`/api/ads/campaigns/${campaign.id}/results${query}`)).body as Json;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    await clearAds(ctx);
    await seedAdsConnection(ctx);
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    graph = new FakeAdsGraph();
    graph.install();
    const number = await seedNumber(ctx);
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ad-${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1_000, purpose: 'LIBRARY' } });
    const version = (position: number) => ({ position, mediaAssetId: media.id, mediaKind: 'IMAGE' as const, primaryText: `Text ${position}`, headline: `Headline ${position}`, callToAction: 'WHATSAPP_MESSAGE', metaAdId: `A${position}${suffix}`, status: 'ACTIVE' as const });
    campaign = await ctx.prisma.adCampaign.create({
      data: {
        name: `Results ${suffix}`,
        goal: 'CHATS',
        status: 'ACTIVE',
        numberId: number.id,
        prefilledMessage: 'Hi',
        targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }] },
        placements: { auto: true },
        dailyBudgetMinor: 5_000n,
        currency: 'AED',
        startAt: new Date(now.getTime() - 10 * 24 * HOUR),
        submittedAt: new Date(now.getTime() - 10 * 24 * HOUR),
        metaCampaignId,
        metaAdsetId: `S${suffix}`,
        versions: { create: [version(1), version(2)] },
      },
      include: { versions: { orderBy: { position: 'asc' } } },
    });
    graph.insights.set(metaCampaignId, {
      ad: [
        row(today, { impressions: 1_000, reach: 800, clicks: 20, spend: '12.50', conversations: 4 }, `A1${suffix}`),
        row(today, { impressions: 500, reach: 450, clicks: 5, spend: '7.50', conversations: 1 }, `A2${suffix}`),
        row(yesterday, { impressions: 2_000, reach: 1_500, clicks: 40, spend: '30.00', conversations: 6 }, `A1${suffix}`),
        row(today, { impressions: 9, reach: 9, clicks: 0, spend: '0.10', conversations: 0 }, 'AD_NOT_OURS'),
      ],
      campaign: [
        row(today, { impressions: 1_500, reach: 1_100, clicks: 25, spend: '20.00', conversations: 5 }),
        row(yesterday, { impressions: 2_000, reach: 1_500, clicks: 40, spend: '30.00', conversations: 6 }),
      ],
    });

    // The platform's own records: two chats today from version 1 (one new contact, one who replied after
    // a business reply), a lead from version 2 and three website visits.
    const contactA = await seedContact(ctx, uaePhone());
    const contactB = await seedContact(ctx, uaePhone());
    const chatA = await ctx.prisma.conversation.create({ data: { contactId: contactA.id, numberId: number.id } });
    const chatB = await ctx.prisma.conversation.create({ data: { contactId: contactB.id, numberId: number.id } });
    const startedAt = new Date(now.getTime() - 2 * 60_000);
    await ctx.prisma.adChatStart.createMany({
      data: [
        { metaAdId: `A1${suffix}`, adCampaignId: campaign.id, adVersionId: campaign.versions[0].id, contactId: contactA.id, conversationId: chatA.id, newContact: true, startedAt },
        { metaAdId: `A1${suffix}`, adCampaignId: campaign.id, adVersionId: campaign.versions[0].id, contactId: contactB.id, conversationId: chatB.id, newContact: false, startedAt },
      ],
    });
    await ctx.prisma.chatMessage.createMany({
      data: [
        { conversationId: chatB.id, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', text: 'Hello!', status: 'SENT', occurredAt: new Date(startedAt.getTime() + 10_000) },
        { conversationId: chatB.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Thanks', occurredAt: new Date(startedAt.getTime() + 20_000) },
      ],
    });
    const form = await ctx.prisma.adLeadForm.create({ data: { name: `Form ${suffix}`, questions: { standard: ['FULL_NAME', 'PHONE'] }, privacyUrl: 'https://example.com/privacy', consentText: 'I agree to get WhatsApp messages' } });
    await ctx.prisma.adLead.create({ data: { formId: form.id, metaLeadId: `L${suffix}`, metaAdId: `A2${suffix}`, adCampaignId: campaign.id, status: 'PROCESSED', submittedAt: new Date(now.getTime() - 60_000) } });
    await ctx.prisma.adLinkOpen.createMany({ data: [1, 2, 3].map(() => ({ adCampaignId: campaign.id, device: 'MOBILE' as const })) });
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('stores Meta’s numbers per version per day and the campaign’s own rows from the hourly job', async () => {
    const processor = ctx.app.get(AdsInsightsProcessor);
    expect(await processor.hourly(now)).toBeGreaterThanOrEqual(1);
    expect(graph.insightCalls.filter((c) => c.campaignId === metaCampaignId)).toEqual(
      expect.arrayContaining([
        { campaignId: metaCampaignId, level: 'ad', since: yesterday, until: today },
        { campaignId: metaCampaignId, level: 'campaign', since: yesterday, until: today },
      ]),
    );
    const rows = await ctx.prisma.adResultDay.findMany({ where: { adCampaignId: campaign.id }, orderBy: [{ day: 'asc' }] });
    expect(rows).toHaveLength(5);
    const v1Today = rows.find((r) => r.adVersionId === campaign.versions[0].id && r.day.toISOString().startsWith(today))!;
    expect(v1Today).toMatchObject({ impressions: 1_000n, reach: 800n, clicks: 20n, spendMinor: 1_250n, metaConversations: 4 });
    expect(rows.filter((r) => r.adVersionId === null)).toHaveLength(2);

    // A second read updates the same rows.
    graph.insights.get(metaCampaignId)!.campaign[0] = row(today, { impressions: 1_600, reach: 1_150, clicks: 26, spend: '21.00', conversations: 5 });
    await processor.hourly(now);
    expect(await ctx.prisma.adResultDay.count({ where: { adCampaignId: campaign.id } })).toBe(5);
    expect((await ctx.prisma.adResultDay.findFirstOrThrow({ where: { adCampaignId: campaign.id, adVersionId: null, day: new Date(`${today}T00:00:00Z`) } })).spendMinor).toBe(2_100n);
  });

  it('refreshes the last 28 days once a day, from the campaign’s first day', async () => {
    graph.insights.get(metaCampaignId)!.campaign.push(row(fiveDaysAgo, { impressions: 300, reach: 280, clicks: 3, spend: '4.00', conversations: 1 }));
    await ctx.app.get(AdsInsightsProcessor).daily(now);
    const call = graph.insightCalls.filter((c) => c.campaignId === metaCampaignId && c.level === 'campaign').at(-1)!;
    expect(call).toMatchObject({ since: localDate(new Date(now.getTime() - 10 * 24 * HOUR), TZ), until: today });
    expect(await ctx.prisma.adResultDay.count({ where: { adCampaignId: campaign.id, adVersionId: null } })).toBe(3);
  });

  it('shows totals, days and versions with the platform’s counts and the costs per chat and lead', async () => {
    const r = await results();
    expect(r).toMatchObject({ currency: 'AED', timezone: TZ });
    expect(r.totals).toMatchObject({
      impressions: 1_600 + 2_000 + 300,
      clicks: 26 + 40 + 3,
      spendMinor: 2_100 + 3_000 + 400,
      metaConversations: 12,
      reach: 1_500,
      chatsStarted: 2,
      newContacts: 1,
      replied: 1,
      leads: 1,
      visits: 3,
      costPerChatMinor: Math.round(5_500 / 2),
      costPerLeadMinor: 5_500,
    });
    const todayRow = (r.days as Json[]).find((d) => d.date === today)!;
    expect(todayRow).toMatchObject({ spendMinor: 2_100, chatsStarted: 2, replied: 1, leads: 1, visits: 3, costPerChatMinor: 1_050, ctr: Math.round((26 / 1_600) * 10_000) / 100 });
    expect((r.days as Json[]).map((d) => d.date)).toEqual([fiveDaysAgo, yesterday, today]);
    const [v1, v2] = r.versions as Json[];
    expect(v1).toMatchObject({ versionId: campaign.versions[0].id, impressions: 3_000, spendMinor: 4_250, chatsStarted: 2, leads: 0 });
    expect(v2).toMatchObject({ versionId: campaign.versions[1].id, impressions: 500, spendMinor: 750, chatsStarted: 0, leads: 1 });
    expect(r.syncedAt).toEqual(expect.any(String));

    const onlyToday = await results(`?from=${today}&to=${today}`);
    expect((onlyToday.days as Json[]).map((d) => d.date)).toEqual([today]);
    expect((await manager.agent.get(`/api/ads/campaigns/${campaign.id}/results?from=2026-13-40`)).status).toBe(422);
    expect((await manager.agent.get(`/api/ads/campaigns/${campaign.id}/results?from=${today}&to=${yesterday}`)).status).toBe(422);
    expect((await manager.agent.get(`/api/ads/campaigns/${randomUUID()}/results`)).status).toBe(404);
  });

  it('exports days and versions as CSV for data.export, with an audit entry, and shows spend and chats in the list', async () => {
    const csv = await manager.agent.get(`/api/ads/campaigns/${campaign.id}/results/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('date,version,currency,impressions,reach,clicks,spend,meta_conversations,chats_started,new_contacts,replied,leads,visits,cost_per_chat');
    expect(lines).toContain(`${today},all versions,AED,1600,1150,26,21.00,5,2,1,1,1,3,10.50`);
    expect(lines.some((l) => l.includes(',version 2,AED,500,'))).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', targetId: campaign.id, actorUserId: manager.userId } })).toBe(1);
    expect((await agent.agent.get(`/api/ads/campaigns/${campaign.id}/results/export`)).status).toBe(403);

    const list = (await agent.agent.get('/api/ads/campaigns')).body as Json[];
    expect(list.find((c) => c.id === campaign.id)).toMatchObject({ spendMinor: 5_500, chatsStarted: 2, leads: 1, currency: 'AED' });
  });
});
