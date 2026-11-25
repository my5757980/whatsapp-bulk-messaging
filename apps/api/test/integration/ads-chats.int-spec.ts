import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T032 (feature 007 US3, FR-021 – FR-023, research R11): customer messages that come from a
// Click-to-WhatsApp ad. The referral stays on the chat item; the chat start links the version and
// campaign by Meta's ad id (unknown ads go under Other ads); the journey, the campaign's tag, the
// outbound event and the campaign's flow follow, never over a running flow or a member's chat, once
// per contact per ad per day; the free window is read from the first business message after the start.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;
const HOUR = 3_600_000;

describe('Chats from ads (007 US3)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let tagId: string;
  let welcomeFlowId: string;
  let campaign: Json;
  let quiet: Json;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const word = `shoes${suffix}`;
  const AD = `9100${suffix}`;
  const QUIET_AD = `9200${suffix}`;
  const UNKNOWN_AD = `9900${suffix}`;
  const phones = { fresh: uaePhone(), known: uaePhone(), quiz: uaePhone(), member: uaePhone(), window: uaePhone(), late: uaePhone() };

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const referral = (adId: string) => ({
    referral: { source_url: 'https://fb.me/mockad', source_id: adId, source_type: 'ad', headline: 'Spring sale', body: '30% off shoes', media_type: 'image', image_url: 'https://cdn.example.test/ad.jpg', ctwa_clid: `CLID${suffix}` },
  });
  const send = async (phone: string, text: string, extra: Record<string, unknown> = {}) => {
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text, extra)));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const replies = async (conversationId: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((m) => m.text);
  const flow = async (name: string, graph: object) => {
    const id = (await api(manager, 'post', '/flows', { name: `${name} ${suffix}` })).body.id as string;
    expect((await api(manager, 'put', `/flows/${id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    expect((await api(manager, 'post', `/flows/${id}/publish`)).status).toBe(200);
    return id;
  };
  const keyword = (phrase: string, match: 'EXACT' | 'CONTAINS') => [{ id: 'kw', kind: 'KEYWORD', match, phrases: [phrase], canInterrupt: false }];
  const startsOf = (phone: string) => ctx.prisma.adChatStart.findMany({ where: { contact: { phoneE164: phone } }, orderBy: { startedAt: 'asc' } });
  const hasTag = async (phone: string) => (await ctx.prisma.contactTag.count({ where: { tagId, contact: { phoneE164: phone } } })) === 1;
  const seedCampaign = async (name: string, metaAdId: string, extra: Json) => {
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ad-${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1_000, purpose: 'LIBRARY' } });
    return ctx.prisma.adCampaign.create({
      data: {
        name,
        goal: 'CHATS',
        status: 'ACTIVE',
        numberId: number.id,
        prefilledMessage: 'Hi, I saw your ad',
        targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }] },
        placements: { auto: true },
        dailyBudgetMinor: 5_000n,
        currency: 'AED',
        startAt: new Date(Date.now() - 24 * HOUR),
        metaCampaignId: `C${metaAdId}`,
        metaAdsetId: `S${metaAdId}`,
        ...extra,
        versions: { create: [{ position: 1, mediaAssetId: media.id, mediaKind: 'IMAGE', primaryText: 'Spring sale', headline: 'Spring sale', callToAction: 'WHATSAPP_MESSAGE', metaAdId, status: 'ACTIVE' }] },
      },
      include: { versions: true },
    });
  };
  const detail = async (conversationId: string) => (await api(admin, 'get', `/inbox/conversations/${conversationId}`)).body as Json;

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    await clearAds(ctx);
    await seedAdsConnection(ctx);
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
    tagId = (await ctx.prisma.tag.create({ data: { name: uniq('from-ad-') } })).id;
    welcomeFlowId = await flow('Welcome', { version: 1, start: 'a', triggers: keyword(`never${suffix}`, 'EXACT'), steps: [{ id: 'a', type: 'message', text: 'Welcome from the ad!', next: null }] });
    // A keyword flow the pre-filled message would start if the campaign's flow did not come first.
    await flow('Shoes keyword', { version: 1, start: 'a', triggers: keyword(word, 'CONTAINS'), steps: [{ id: 'a', type: 'message', text: 'Keyword flow reply', next: null }] });
    campaign = await seedCampaign(`Spring sale ${suffix}`, AD, { flowId: welcomeFlowId, tagId });
    quiet = await seedCampaign(`Quiet ad ${suffix}`, QUIET_AD, {});
    const endpoint = await api(admin, 'post', '/webhook-endpoints', { name: uniq('Ads hook '), url: `https://ads-${suffix}.example.test/hooks`, eventTypes: ['ad.chat_started'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
  });

  afterAll(async () => {
    await clearAds(ctx);
    await ctx.close();
  });

  it('keeps the referral, records the chat start, journey, tag and event, and starts the flow before keyword flows', async () => {
    const chat = await send(phones.fresh, `Hi, I saw your ad about ${word}`, referral(AD));
    expect(await replies(chat.id)).toEqual(['Welcome from the ad!']);
    const item = await ctx.prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'INBOUND' } });
    expect(item.payload).toMatchObject({ referral: { metaAdId: AD, headline: 'Spring sale', mediaUrl: 'https://cdn.example.test/ad.jpg', ctwaClid: `CLID${suffix}` } });
    expect(await startsOf(phones.fresh)).toMatchObject([
      { metaAdId: AD, adCampaignId: campaign.id, adVersionId: campaign.versions[0].id, conversationId: chat.id, newContact: true, headline: 'Spring sale', ctwaClid: `CLID${suffix}` },
    ]);
    expect(await hasTag(phones.fresh)).toBe(true);
    expect(await ctx.prisma.conversationEvent.findFirst({ where: { conversationId: chat.id, type: 'AD_CHAT_STARTED' } })).toMatchObject({
      actorType: 'CUSTOMER',
      data: { metaAdId: AD, adCampaignId: campaign.id, adCampaignName: campaign.name, newContact: true },
    });
    expect(await ctx.prisma.flowSession.findFirst({ where: { conversationId: chat.id } })).toMatchObject({ flowId: welcomeFlowId, triggerKey: 'ad' });
    const event = await ctx.prisma.outboundEvent.findFirst({ where: { type: 'ad.chat_started' }, orderBy: { createdAt: 'desc' } });
    expect(event?.data).toMatchObject({ adCampaign: { id: campaign.id, name: campaign.name }, metaAdId: AD, headline: 'Spring sale', newContact: true, conversationId: chat.id, contact: { phone: phones.fresh } });

    // The same ad again on the same day is not a second start, tag or flow.
    await send(phones.fresh, 'Hi again', referral(AD));
    expect(await startsOf(phones.fresh)).toHaveLength(1);
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: chat.id, triggerKey: 'ad' } })).toBe(1);
  });

  it('lists an unknown ad under Other ads; a known contact is not new', async () => {
    await seedContact(ctx, phones.known, { consentStatus: 'UNKNOWN' });
    const chat = await send(phones.known, 'Hello', referral(UNKNOWN_AD));
    expect(await startsOf(phones.known)).toMatchObject([{ metaAdId: UNKNOWN_AD, adCampaignId: null, adVersionId: null, newContact: false }]);
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: chat.id, triggerKey: 'ad' } })).toBe(0);
    expect(await hasTag(phones.known)).toBe(false);
    const other = await api(agent, 'get', '/ads/other-chats');
    expect(other.status).toBe(200);
    expect(other.body).toContainEqual({ metaAdId: UNKNOWN_AD, headline: 'Spring sale', chats: 1, newContacts: 0, lastAt: expect.any(String) });
    expect((other.body as Json[]).some((g) => g.metaAdId === AD)).toBe(false);
  });

  it('never interrupts a running flow or a member chat, but still counts and tags', async () => {
    await flow('Quiz', { version: 1, start: 'q', triggers: keyword(`quiz${suffix}`, 'EXACT'), steps: [{ id: 'q', type: 'question', text: 'What is your name?', answerName: 'name', retryText: 'Please type your name.', next: 'done' }, { id: 'done', type: 'message', text: 'Thanks!', next: null }] });
    const quiz = await send(phones.quiz, `quiz${suffix}`);
    expect(await replies(quiz.id)).toEqual(['What is your name?']);
    await send(phones.quiz, 'Sara', referral(AD));
    expect(await replies(quiz.id)).toEqual(['What is your name?', 'Thanks!']);
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: quiz.id, flowId: welcomeFlowId } })).toBe(0);
    expect(await startsOf(phones.quiz)).toHaveLength(1);
    expect(await hasTag(phones.quiz)).toBe(true);

    const chat = await send(phones.member, `zq${suffix}`);
    const before = await replies(chat.id);
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { state: 'INTERVENED', intervenedById: manager.userId, intervenedAt: new Date() } });
    await send(phones.member, 'From the ad', referral(AD));
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: chat.id, triggerKey: 'ad' } })).toBe(0);
    expect(await replies(chat.id)).toEqual(before);
    expect(await startsOf(phones.member)).toMatchObject([{ newContact: false }]);
    expect(await hasTag(phones.member)).toBe(true);
  });

  it('shows the ad and the free window: a reply within 24 hours opens it for 72 hours, a later one misses it', async () => {
    const chat = await send(phones.window, 'Hi, I saw your ad', referral(QUIET_AD));
    const [start] = await startsOf(phones.window);
    let adChat = (await detail(chat.id)).adChat as Json;
    expect(adChat).toMatchObject({ metaAdId: QUIET_AD, headline: 'Spring sale', mediaUrl: 'https://cdn.example.test/ad.jpg', adCampaign: { id: quiet.id, name: quiet.name }, newContact: true });
    expect(adChat.freeWindow).toEqual({ state: 'REPLY_TO_OPEN', replyBy: new Date(start!.startedAt.getTime() + 24 * HOUR).toISOString() });

    const replyAt = new Date(start!.startedAt.getTime() + HOUR);
    await ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', text: 'Hello! How can we help?', status: 'SENT', occurredAt: replyAt } });
    adChat = (await detail(chat.id)).adChat as Json;
    expect(adChat.freeWindow).toEqual({ state: 'OPEN', until: new Date(replyAt.getTime() + 72 * HOUR).toISOString() });

    const late = await send(phones.late, 'Hi', { ...referral(QUIET_AD), timestamp: String(Math.floor((Date.now() - 30 * HOUR) / 1000)) });
    expect((await detail(late.id)).adChat.freeWindow).toEqual({ state: 'MISSED' });
    await ctx.prisma.chatMessage.create({ data: { conversationId: late.id, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', text: 'Sorry for the wait', status: 'SENT', occurredAt: new Date() } });
    expect((await detail(late.id)).adChat.freeWindow).toEqual({ state: 'MISSED' });
    // Chats without an ad have none.
    const plain = await send(uaePhone(), 'No ad here');
    expect((await detail(plain.id)).adChat).toBeNull();
  });

  it('lists the campaign’s chats, with phones masked for agents', async () => {
    const full = await api(manager, 'get', `/ads/campaigns/${campaign.id}/chats?pageSize=10`);
    expect(full.status).toBe(200);
    expect(full.body.total).toBe(3);
    expect((full.body.items as Json[]).map((c) => c.contact.phone).sort()).toEqual([phones.fresh, phones.quiz, phones.member].sort());
    expect(full.body.items[0]).toMatchObject({ id: expect.any(String), conversationId: expect.any(String), newContact: expect.any(Boolean), startedAt: expect.any(String) });
    const masked = await api(agent, 'get', `/ads/campaigns/${campaign.id}/chats?pageSize=10`);
    expect(masked.status).toBe(200);
    expect((masked.body.items as Json[]).every((c) => !Object.values(phones).includes(c.contact.phone))).toBe(true);
    expect((await api(manager, 'get', `/ads/campaigns/${randomUUID()}/chats`)).status).toBe(404);
  });
});
