import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { TemplatesSyncService } from '../../src/modules/templates/templates-sync.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedContact, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T031 (feature 009 US2, research R6, contracts/meta-templates.md): carousel templates, card media chosen
// per campaign and uploaded once per number, card variables, quick replies that say which card (and
// start 003 flows), and tracked card buttons (005).

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

type SentCard = { card_index: number; components: Array<Record<string, unknown>> };

describe('Carousel templates (009 US2)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;

  const upload = async (bytes = PNG, contentType = 'image/png') => {
    const res = await manager.agent.post('/api/media').set('x-csrf-token', manager.csrf).field('purpose', 'TEMPLATE_SAMPLE').attach('file', bytes, { filename: contentType === 'image/png' ? 'card.png' : 'card.pdf', contentType });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const card = (sampleMediaAssetId: string, url = 'https://shop.example.com/p/{{1}}', urlExample = 'shirt-1') => ({
    mediaFormat: 'IMAGE',
    sampleMediaAssetId,
    bodyText: 'Linen shirt, {{1}}',
    bodyExamples: ['AED 120'],
    buttons: [
      { type: 'QUICK_REPLY', text: 'Tell me more' },
      { type: 'URL', text: 'Shop', url, urlExample },
    ],
  });
  const api = (method: 'post' | 'put', url: string, body: object = {}) => manager.agent[method](`/api${url}`).set('x-csrf-token', manager.csrf).send(body);
  /** Emulates the send worker: dispatcher ticks, then each queued message is sent. */
  const dispatchAndSend = async (campaignId: string) => {
    const dispatcher = ctx.app.get(DispatcherProcessor);
    const sender = ctx.app.get(SendProcessor);
    const queue = ctx.app.get(QueueRegistry).sendQueue(number.id);
    for (let guard = 0; guard < 20; guard++) {
      await queue.drain();
      const tick = await dispatcher.tick(campaignId);
      if (tick.action !== 'claim' || tick.claimed === 0) return;
      const queued = await ctx.prisma.message.findMany({ where: { campaignId, status: 'QUEUED' } });
      for (const m of queued) await sender.process(m.id, 1);
    }
  };
  const audience = async (count: number) => {
    const tagName = `carousel-${digits(6)}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const phones: string[] = [];
    for (let i = 0; i < count; i++) {
      const phone = uaePhone();
      const contact = await seedContact(ctx, phone, { name: 'Sara', consentStatus: 'OPTED_IN' });
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
      phones.push(phone);
    }
    return { tagName, phones };
  };
  const campaignFor = async (templateId: string, tagName: string, extra: object = {}, cards = 3) => {
    const mapping: Record<string, object> = { 'BODY.1': { source: 'field', key: 'name' } };
    for (let c = 0; c < cards; c++) {
      mapping[`CARD.${c}.BODY.1`] = { source: 'static', value: `AED ${100 + c}` };
      mapping[`CARD.${c}.BUTTON.1.1`] = { source: 'static', value: `item-${c}` };
    }
    const res = await api('post', '/campaigns', { name: `Carousel ${digits(5)}`, numberId: number.id, templateId, audienceType: 'FILTER', audienceFilter: { all: [{ tag: tagName }] }, variableMapping: mapping, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const cardsSentTo = (phone: string) =>
    (fake.sentTo(phone).at(-1)!.body.template.components as Array<{ type: string; cards?: SentCard[] }>).find((c) => c.type === 'carousel')!.cards!;

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    useNockLocalOnly();
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
  });
  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  it('creates, submits and syncs a carousel; campaigns send each card with its media and variables; card files are uploaded once per number', async () => {
    const samples = [await upload(), await upload(), await upload()];
    const resumableBefore = fake.resumableUploads.length;
    const created = await api('post', '/templates', {
      wabaId: number.wabaId,
      name: `new_arrivals_${digits(6)}`,
      language: 'en_US',
      category: 'MARKETING',
      kind: 'CAROUSEL',
      body: { text: 'Hi {{1}}, our new arrivals.', examples: ['Sara'] },
      cards: samples.map((s) => card(s)),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // One resumable upload per card sample, each card with its own handle.
    expect(fake.resumableUploads.length - resumableBefore).toBe(3);
    const carousel = (fake.creates.at(-1)!.components as Array<{ type: string; cards?: Array<{ components: Array<{ type: string; example?: { header_handle?: string[] } }> }> }>).find((c) => c.type === 'CAROUSEL');
    expect(carousel?.cards).toHaveLength(3);
    expect(new Set(carousel?.cards?.map((c) => c.components[0]?.example?.header_handle?.[0])).size).toBe(3);

    // Sync brings the approval back and keeps the kind and the card samples.
    await ctx.app.get(TemplatesSyncService).syncWaba(number.wabaId);
    const template = await ctx.prisma.template.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(template).toMatchObject({ kind: 'CAROUSEL', status: 'APPROVED' });
    expect((template.options as { cards?: Array<{ sampleMediaAssetId: string }> }).cards?.map((c) => c.sampleMediaAssetId)).toEqual(samples);
    expect((template.variables as Array<{ key: string }>).map((v) => v.key)).toEqual(expect.arrayContaining(['BODY.1', 'CARD.0.BODY.1', 'CARD.2.BUTTON.1.1']));

    const { tagName, phones } = await audience(2);
    const replacement = await upload();
    const campaignId = await campaignFor(template.id, tagName, { cardMedia: [{ cardIndex: 1, mediaAssetId: replacement }] });

    const check = await api('post', `/campaigns/${campaignId}/media-check`);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.cardMedia.map((c: { result: string }) => c.result)).toEqual(['READY', 'READY', 'READY']);
    const uploaded = fake.mediaUploads.filter((u) => u.phoneNumberId === number.phoneNumberId).length;
    expect(uploaded).toBe(3);

    expect((await api('post', `/campaigns/${campaignId}/launch`)).status).toBe(200);
    await dispatchAndSend(campaignId);
    const ids = fake.mediaUploads.map((u) => u.id);
    for (const phone of phones) {
      const cards = cardsSentTo(phone);
      expect(cards.map((c) => c.card_index)).toEqual([0, 1, 2]);
      // Card 2 carries the replacement, the others the samples: three different uploaded ids.
      const mediaIds = cards.map((c) => ((c.components[0]!.parameters as Array<{ image: { id: string } }>)[0]!.image.id));
      expect(new Set(mediaIds).size).toBe(3);
      expect(mediaIds.every((id) => ids.includes(id))).toBe(true);
      expect(cards[1]!.components[1]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'AED 101' }] });
      expect(cards[2]!.components).toContainEqual({ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'wbm:c2:b0' }] });
      expect(cards[2]!.components).toContainEqual({ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'item-2' }] });
    }
    // Launch and sends reused the ids the check uploaded.
    expect(fake.mediaUploads.length).toBe(uploaded);

    // A second campaign with the same cards uploads nothing new...
    const again = await campaignFor(template.id, tagName, { cardMedia: [{ cardIndex: 1, mediaAssetId: replacement }] });
    expect((await api('post', `/campaigns/${again}/media-check`)).status).toBe(200);
    expect(fake.mediaUploads.length).toBe(uploaded);
    // ...until the cached Meta id is too old: then that file is uploaded again.
    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: replacement } });
    const cache = asset.metaMediaIds as Record<string, { id: string; uploadedAt: string }>;
    await ctx.prisma.mediaAsset.update({ where: { id: replacement }, data: { metaMediaIds: { ...cache, [number.phoneNumberId]: { ...cache[number.phoneNumberId]!, uploadedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() } } } });
    expect((await api('post', `/campaigns/${again}/media-check`)).status).toBe(200);
    expect(fake.mediaUploads.length).toBe(uploaded + 1);

    // Card files of the wrong type or size are reported per card and block the launch.
    const pdf = await upload(PDF, 'application/pdf');
    const big = await ctx.prisma.mediaAsset.create({ data: { storageKey: `media/${digits(10)}.png`, mimeType: 'image/png', sizeBytes: 6 * 1024 * 1024, purpose: 'TEMPLATE_SAMPLE' } });
    const wrong = await campaignFor(template.id, tagName, { cardMedia: [{ cardIndex: 0, mediaAssetId: pdf }, { cardIndex: 2, mediaAssetId: big.id }] });
    const wrongCheck = await api('post', `/campaigns/${wrong}/media-check`);
    expect(wrongCheck.body.cardMedia).toEqual([
      expect.objectContaining({ cardIndex: 0, result: 'WRONG_TYPE' }),
      expect.objectContaining({ cardIndex: 1, result: 'READY' }),
      expect.objectContaining({ cardIndex: 2, result: 'TOO_LARGE' }),
    ]);
    const refused = await api('post', `/campaigns/${wrong}/launch`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MEDIA_PROBLEMS');
  });

  it('records a card quick reply with its card, and starts the flow of a 003 template button trigger', async () => {
    const samples = [await upload(), await upload()];
    const created = await api('post', '/templates', { wabaId: number.wabaId, name: `card_replies_${digits(6)}`, language: 'en_US', category: 'MARKETING', kind: 'CAROUSEL', body: { text: 'Hi {{1}}', examples: ['Sara'] }, cards: samples.map((s) => card(s)) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await ctx.prisma.template.update({ where: { id: created.body.id }, data: { status: 'APPROVED' } });

    // The trigger names the cards' quick reply, so the flow publishes without problems.
    const flow = await api('post', '/flows', { name: `Card details ${digits(5)}` });
    const graph = { version: 1, start: 'a', triggers: [{ id: 'tb', kind: 'TEMPLATE_BUTTON', templateId: created.body.id, buttonText: 'Tell me more', canInterrupt: false }], steps: [{ id: 'a', type: 'message', text: 'Here are the details.', next: null }] };
    expect((await api('put', `/flows/${flow.body.id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    const published = await api('post', `/flows/${flow.body.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.problems ?? []).toEqual([]);

    const { tagName, phones } = await audience(1);
    const id = await campaignFor(created.body.id, tagName, {}, 2);
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);
    await dispatchAndSend(id);
    const sent = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: id, status: 'SENT' } });

    const phone = phones[0]!;
    await ctx.app.get(WebhooksProcessor).process(
      await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), 'Tell me more', { type: 'button', button: { text: 'Tell me more', payload: 'wbm:c1:b0' }, context: { from: '15550100', id: sent.waMessageId } })),
    );
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
    const reply = await ctx.prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, contentType: 'BUTTON_REPLY' } });
    // The text stays the button's (003 triggers match on it); the card is in the payload for live chat.
    expect(reply.text).toBe('Tell me more');
    expect(reply.payload).toMatchObject({ card: { cardIndex: 1, buttonIndex: 0 }, title: 'Tell me more', payload: 'wbm:c1:b0' });
    const automatic = await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, origin: 'AUTOMATIC' } });
    expect(automatic.map((i) => i.text)).toContain('Here are the details.');
  });

  it('counts clicks on a tracked card button (005)', async () => {
    const base = process.env.PUBLIC_LINK_BASE_URL as string;
    const samples = [await upload(), await upload()];
    const created = await api('post', '/templates', {
      wabaId: number.wabaId,
      name: `card_links_${digits(6)}`,
      language: 'en_US',
      category: 'MARKETING',
      kind: 'CAROUSEL',
      body: { text: 'Hi {{1}}', examples: ['Sara'] },
      cards: [card(samples[0]!, `${base}/{{1}}`, 'AbCdEf1234'), card(samples[1]!)],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await ctx.prisma.template.update({ where: { id: created.body.id }, data: { status: 'APPROVED' } });
    const { tagName, phones } = await audience(1);
    const id = await campaignFor(created.body.id, tagName, {}, 2);
    // Card 1's button is on the tracked-link address: it needs a destination before launch.
    const refused = await api('post', `/campaigns/${id}/launch`);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('trackedLinks.CARD.0.BUTTON.1.1');
    const saved = await api('put', `/campaigns/${id}/tracked-links`, { links: [{ variableKey: 'CARD.0.BUTTON.1.1', destination: 'https://shop.example.com/new' }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);
    await dispatchAndSend(id);

    const link = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { message: { campaignId: id }, target: { variableKey: 'CARD.0.BUTTON.1.1' } } });
    expect(cardsSentTo(phones[0]!)[0]!.components).toContainEqual({ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: link.code }] });
    const opened = await request(ctx.server()).get(`/l/${link.code}`).set('User-Agent', PHONE_UA);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toMatch(/^https:\/\/shop\.example\.com\/new/);
    expect(await ctx.prisma.linkClick.count({ where: { campaignId: id } })).toBe(1);
  });

  it('refuses carousels that break Meta\'s rules before calling Meta', async () => {
    const samples = [await upload(), await upload()];
    const before = fake.creates.length;
    const oneCard = await api('post', '/templates', { wabaId: number.wabaId, name: `bad_carousel_${digits(6)}`, language: 'en_US', category: 'MARKETING', kind: 'CAROUSEL', body: { text: 'Hi' }, cards: [card(samples[0]!)] });
    expect(oneCard.status).toBe(422);
    const utility = await api('post', '/templates', { wabaId: number.wabaId, name: `bad_carousel_${digits(6)}`, language: 'en_US', category: 'UTILITY', kind: 'CAROUSEL', body: { text: 'Hi' }, cards: samples.map((s) => card(s)) });
    expect(utility.status).toBe(422);
    expect(fake.creates.length).toBe(before);
  });
});
