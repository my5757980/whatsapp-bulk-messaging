import { createHash, randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdsAudiencesProcessor } from '../../src/modules/ads/audiences/ads-audiences.processor.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T049 (feature 007 US6, FR-031 – FR-034, research R8): saved audiences from a tag, a contact filter
// and a campaign group, sent as PHONE_SHA256 hashes (opted-out and blocked contacts left out), kept up
// to date with daily differences (deleted contacts removed), too-small audiences, lookalikes, deletes
// refused while a running campaign uses them, the custom audience terms and "sync now".

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;

describe('Saved audiences (007 US6)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeAdsGraph;
  let processor: AdsAudiencesProcessor;
  let bigTag: { id: string; name: string };
  let smallTag: { id: string; name: string };
  let contacts: Array<{ id: string; phoneE164: string }>;
  let audience: Json;

  const send = (who: SignedInAgent, method: 'post' | 'delete', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const hash = (phone: string) => createHash('sha256').update(phone.replace(/\D/g, '').replace(/^0+/, '')).digest('hex');
  const seedTagged = async (tagId: string, count: number) => {
    const rows = Array.from({ length: count }, () => ({ id: randomUUID(), phoneE164: uaePhone(), countryCode: 'AE', consentStatus: 'OPTED_IN' as const }));
    await ctx.prisma.contact.createMany({ data: rows });
    await ctx.prisma.contactTag.createMany({ data: rows.map((r) => ({ contactId: r.id, tagId })) });
    return rows.map((r) => ({ id: r.id, phoneE164: r.phoneE164 }));
  };
  const read = async (id: string) => (await manager.agent.get(`/api/ads/audiences/${id}`)).body as Json;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    await seedAdsConnection(ctx);
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    graph = new FakeAdsGraph();
    graph.install();
    processor = ctx.app.get(AdsAudiencesProcessor);
    bigTag = await ctx.prisma.tag.create({ data: { name: uniq('vip-') } });
    smallTag = await ctx.prisma.tag.create({ data: { name: uniq('few-') } });
    // 150 tagged contacts: 4 opted out and 1 blocked are never sent, so 145 hashes.
    contacts = await seedTagged(bigTag.id, 150);
    await ctx.prisma.contact.updateMany({ where: { id: { in: contacts.slice(0, 4).map((c) => c.id) } }, data: { consentStatus: 'OPTED_OUT' } });
    await ctx.prisma.contact.update({ where: { id: contacts[4]!.id }, data: { blockedAt: new Date() } });
    await seedTagged(smallTag.id, 50);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  const metaIdOf = async (id: string) => (await ctx.prisma.adAudience.findUniqueOrThrow({ where: { id } })).metaAudienceId!;

  it('makes an audience from a tag and sends normalized phone hashes, without opted-out and blocked contacts', async () => {
    const res = await send(manager, 'post', '/ads/audiences', { name: uniq('VIP '), source: { type: 'tag', tagId: bigTag.id } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'CUSTOM', status: 'SYNCING', memberCount: 0, source: { type: 'tag', tagId: bigTag.id } });
    audience = res.body;
    const metaId = await metaIdOf(audience.id);
    expect(graph.audiences.get(metaId)!.body).toMatchObject({ subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' });

    await processor.syncOne(audience.id);
    expect(await read(audience.id)).toMatchObject({ status: 'READY', memberCount: 145, syncedAt: expect.any(String), lastError: null });
    const members = graph.audiences.get(metaId)!.members;
    expect(members.size).toBe(145);
    expect(members.has(hash(contacts[10]!.phoneE164))).toBe(true);
    expect(members.has(hash(contacts[0]!.phoneE164))).toBe(false);
    expect(members.has(hash(contacts[4]!.phoneE164))).toBe(false);
    expect(await ctx.prisma.adAudienceMember.count({ where: { audienceId: audience.id } })).toBe(145);
    expect(graph.userCalls.filter((c) => c.audienceId === metaId)).toEqual([{ audienceId: metaId, method: 'POST', count: 145 }]);
  });

  it('sends only the difference each day, and removes deleted contacts at the next sync', async () => {
    const metaId = await metaIdOf(audience.id);
    graph.userCalls.length = 0;
    await ctx.prisma.contactTag.deleteMany({ where: { tagId: bigTag.id, contactId: { in: contacts.slice(10, 20).map((c) => c.id) } } });
    const added = await seedTagged(bigTag.id, 3);
    await processor.daily();
    expect(graph.userCalls.filter((c) => c.audienceId === metaId)).toEqual(
      expect.arrayContaining([
        { audienceId: metaId, method: 'DELETE', count: 10 },
        { audienceId: metaId, method: 'POST', count: 3 },
      ]),
    );
    expect(graph.audiences.get(metaId)!.members.has(hash(added[0]!.phoneE164))).toBe(true);
    expect((await read(audience.id)).memberCount).toBe(138);

    graph.userCalls.length = 0;
    const gone = contacts[30]!;
    await ctx.prisma.contact.delete({ where: { id: gone.id } });
    await processor.syncOne(audience.id);
    expect(graph.userCalls.filter((c) => c.audienceId === metaId)).toEqual([{ audienceId: metaId, method: 'DELETE', count: 1 }]);
    expect(graph.audiences.get(metaId)!.members.has(hash(gone.phoneE164))).toBe(false);
    expect(await ctx.prisma.adAudienceMember.count({ where: { audienceId: audience.id, contactId: gone.id } })).toBe(0);
    expect((await read(audience.id)).memberCount).toBe(137);
  });

  it('keeps audiences under 100 people too small: not offered to campaigns and no lookalike', async () => {
    const small = (await send(manager, 'post', '/ads/audiences', { name: uniq('Few '), source: { type: 'filter', filter: { all: [{ tag: smallTag.name }] } } })).body as Json;
    await processor.syncOne(small.id);
    expect(await read(small.id)).toMatchObject({ status: 'TOO_SMALL', memberCount: 50 });
    const look = await send(manager, 'post', `/ads/audiences/${small.id}/lookalikes`, { country: 'AE', ratio: 0.01 });
    expect(look.status).toBe(409);
    expect(look.body.code).toBe('TOO_SMALL');
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ad-${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1_000, purpose: 'LIBRARY' } });
    const number = await seedNumber(ctx);
    const draft = await send(manager, 'post', '/ads/campaigns', {
      name: uniq('Audience ad '),
      goal: 'CHATS',
      numberId: number.id,
      prefilledMessage: 'Hi',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }], includeAudienceIds: [small.id] },
      placements: { auto: true },
      dailyBudgetMinor: 5_000,
      startAt: new Date().toISOString(),
      versions: [{ mediaAssetId: media.id, primaryText: 'Hi', headline: 'Hi', callToAction: 'WHATSAPP_MESSAGE' }],
    });
    expect(draft.status).toBe(422);
    expect(draft.body.details).toContainEqual({ field: 'targeting.audiences', issue: 'includes an audience that is not ready' });
  });

  it('makes audiences from a campaign group', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const readers = contacts.slice(40, 43);
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: manager.userId, contacts: [...readers, contacts[50]!] });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: { in: readers.map((r) => r.id) } }, data: { status: 'READ', readAt: new Date() } });
    const group = (await send(manager, 'post', '/ads/audiences', { name: uniq('Readers '), source: { type: 'campaign_group', campaignId: campaign.id, group: 'READ' } })).body as Json;
    await processor.syncOne(group.id);
    expect(await read(group.id)).toMatchObject({ status: 'TOO_SMALL', memberCount: 3 });
    const bad = await send(manager, 'post', '/ads/audiences', { name: uniq('Bad '), source: { type: 'campaign_group', campaignId: randomUUID(), group: 'READ' } });
    expect(bad.status).toBe(422);
  });

  it('makes a lookalike with a country and ratio from a ready audience', async () => {
    const res = await send(manager, 'post', `/ads/audiences/${audience.id}/lookalikes`, { country: 'AE', ratio: 0.01 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'LOOKALIKE', originAudienceId: audience.id, lookalikeCountry: 'AE', lookalikeRatio: 0.01, status: 'READY' });
    const metaId = await metaIdOf(res.body.id);
    expect(graph.audiences.get(metaId)!.body).toMatchObject({ subtype: 'LOOKALIKE', origin_audience_id: await metaIdOf(audience.id) });
    expect(JSON.parse(graph.audiences.get(metaId)!.body.lookalike_spec)).toEqual({ country: 'AE', ratio: 0.01 });
    expect((await send(manager, 'post', `/ads/audiences/${audience.id}/lookalikes`, { country: 'AE', ratio: 0.2 })).status).toBe(422);
    const list = (await agent.agent.get('/api/ads/audiences')).body as Json[];
    expect(list.map((a) => a.id)).toEqual(expect.arrayContaining([audience.id, res.body.id]));
  });

  it('refuses deletes while a running campaign uses the audience, then deletes it here and at Meta', async () => {
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ad-${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1_000, purpose: 'LIBRARY' } });
    const running = await ctx.prisma.adCampaign.create({
      data: {
        name: uniq('Uses audience '),
        goal: 'WEBSITE',
        status: 'ACTIVE',
        websiteUrl: 'https://example.com',
        targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }], excludeAudienceIds: [audience.id] },
        placements: { auto: true },
        dailyBudgetMinor: 5_000n,
        currency: 'AED',
        startAt: new Date(),
        metaCampaignId: `C${randomUUID().slice(0, 8)}`,
        versions: { create: [{ position: 1, mediaAssetId: media.id, mediaKind: 'IMAGE', primaryText: 'x', headline: 'x', callToAction: 'LEARN_MORE' }] },
      },
    });
    const refused = await send(manager, 'delete', `/ads/audiences/${audience.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IN_USE');
    await ctx.prisma.adCampaign.update({ where: { id: running.id }, data: { status: 'ENDED' } });
    const metaId = await metaIdOf(audience.id);
    const lookalikes = await ctx.prisma.adAudience.findMany({ where: { originAudienceId: audience.id } });
    expect((await send(manager, 'delete', `/ads/audiences/${audience.id}`)).status).toBe(204);
    expect(graph.deleted).toEqual(expect.arrayContaining([metaId, ...lookalikes.map((l) => l.metaAudienceId!)]));
    expect((await manager.agent.get(`/api/ads/audiences/${audience.id}`)).status).toBe(404);
    expect(await ctx.prisma.adAudienceMember.count({ where: { audienceId: audience.id } })).toBe(0);
    const audits = (await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: 'ad_audience.' }, actorUserId: manager.userId } })).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['ad_audience.created', 'ad_audience.deleted']));
  });

  it('asks for the custom audience terms, queues "sync now", and keeps audiences to managers and admins', async () => {
    const other = (await send(manager, 'post', '/ads/audiences', { name: uniq('Again '), source: { type: 'tag', tagId: bigTag.id } })).body as Json;
    expect((await send(manager, 'post', `/ads/audiences/${other.id}/sync`)).status).toBe(202);
    expect((await send(agent, 'post', '/ads/audiences', { name: uniq('Agent '), source: { type: 'tag', tagId: bigTag.id } })).status).toBe(403);
    await seedAdsConnection(ctx, { checks: { checks: [{ check: 'AUDIENCE_TERMS', result: 'WARNING', detail: 'Not accepted', fix: 'Accept them' }], ready: true, linkedNumbers: null } });
    const terms = await send(manager, 'post', '/ads/audiences', { name: uniq('Terms '), source: { type: 'tag', tagId: bigTag.id } });
    expect(terms.status).toBe(409);
    expect(terms.body.code).toBe('TERMS_NOT_ACCEPTED');
  });
});
