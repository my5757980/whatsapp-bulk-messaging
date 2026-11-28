import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { CampaignProgressProcessor } from '../../src/modules/campaigns/campaign-progress.processor.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { ExpiredSweepProcessor } from '../../src/modules/sending/expired-sweep.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { TemplatesSyncService } from '../../src/modules/templates/templates-sync.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedContact, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T049 (feature 009 US4, research R8): time-to-live ranges by category and who applies them, category
// changes found by the sync, drops before sending, the expired sweep after sending, late webhooks, and
// campaign completion with the expired messages counted.

describe('Template time-to-live (009 US4)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;

  const api = (method: 'post' | 'put', url: string, body: object = {}) => manager.agent[method](`/api${url}`).set('x-csrf-token', manager.csrf).send(body);
  const draft = (category: 'UTILITY' | 'MARKETING', ttlSeconds: number | null) => ({
    wabaId: number.wabaId,
    name: `ttl_${category.toLowerCase()}_${digits(6)}`,
    language: 'en_US',
    category,
    body: { text: 'Hi {{1}}, your order is ready.', examples: ['Sara'] },
    ttlSeconds,
  });
  const codeDraft = (ttlSeconds: number) => ({
    wabaId: number.wabaId,
    name: `ttl_code_${digits(6)}`,
    language: 'en_US',
    category: 'AUTHENTICATION',
    kind: 'AUTHENTICATION',
    body: { text: '' },
    ttlSeconds,
    auth: { securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' },
  });
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
  /** An approved template with this time-to-live, and a launched campaign to two contacts. */
  const launched = async (ttlSeconds: number, category: 'UTILITY' | 'MARKETING' = 'UTILITY') => {
    const created = await api('post', '/templates', draft(category, ttlSeconds));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await ctx.prisma.template.update({ where: { id: created.body.id }, data: { status: 'APPROVED' } });
    const tagName = `ttl-${digits(6)}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const phones = [uaePhone(), uaePhone()];
    for (const phone of phones) {
      const contact = await seedContact(ctx, phone, { name: 'Sara' });
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    }
    const campaign = await api('post', '/campaigns', { name: `TTL ${digits(5)}`, numberId: number.id, templateId: created.body.id, audienceType: 'FILTER', audienceFilter: { all: [{ tag: tagName }] }, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } } });
    expect(campaign.status, JSON.stringify(campaign.body)).toBe(201);
    expect((await api('post', `/campaigns/${campaign.body.id}/launch`)).status).toBe(200);
    return { campaignId: campaign.body.id as string, phones };
  };

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

  it('keeps each category in its range, sends the time-to-live to Meta for codes and utility, and applies marketing in our queue', async () => {
    const before = fake.creates.length;
    expect((await api('post', '/templates', codeDraft(20))).status).toBe(422);
    expect((await api('post', '/templates', draft('UTILITY', 50_000))).status).toBe(422);
    expect((await api('post', '/templates', draft('MARKETING', 3_600))).status).toBe(422);
    expect(fake.creates.length).toBe(before);

    const code = await api('post', '/templates', codeDraft(300));
    expect(code.body).toMatchObject({ ttlSeconds: 300, ttlAppliedBy: 'META' });
    expect(fake.creates.at(-1)).toMatchObject({ message_send_ttl_seconds: 300 });
    const utility = await api('post', '/templates', draft('UTILITY', 3_600));
    expect(utility.body).toMatchObject({ ttlSeconds: 3_600, ttlAppliedBy: 'META' });
    expect(fake.creates.at(-1)).toMatchObject({ message_send_ttl_seconds: 3_600 });
    const marketing = await api('post', '/templates', draft('MARKETING', 43_200));
    expect(marketing.body).toMatchObject({ ttlSeconds: 43_200, ttlAppliedBy: 'PLATFORM' });
    expect(fake.creates.at(-1)).not.toHaveProperty('message_send_ttl_seconds');
    const none = await api('post', '/templates', draft('UTILITY', null));
    expect(none.body).toMatchObject({ ttlSeconds: null, ttlAppliedBy: null });
  });

  it('clears a time-to-live that no longer fits when Meta changes the category, and keeps one that fits as ours', async () => {
    const short = await api('post', '/templates', draft('UTILITY', 3_600));
    const long = await api('post', '/templates', draft('UTILITY', 43_200));
    // Meta moves both to marketing and clears its custom time-to-live.
    for (const name of [short.body.name, long.body.name]) {
      const meta = [...fake.templates.values()].find((t) => t.name === name)!;
      meta.category = 'MARKETING';
      delete meta.ttl;
    }
    await ctx.app.get(TemplatesSyncService).syncWaba(number.wabaId);
    expect(await ctx.prisma.template.findUniqueOrThrow({ where: { id: short.body.id } })).toMatchObject({ category: 'MARKETING', ttlSeconds: null, ttlAppliedBy: null });
    expect(await ctx.prisma.template.findUniqueOrThrow({ where: { id: long.body.id } })).toMatchObject({ category: 'MARKETING', ttlSeconds: 43_200, ttlAppliedBy: 'PLATFORM' });
  });

  it('drops the messages of a campaign resumed after the time-to-live, without sending them', async () => {
    const { campaignId } = await launched(60);
    expect((await api('post', `/campaigns/${campaignId}/pause`)).status).toBe(200);
    // Two minutes later (a 60-second time-to-live), the campaign is resumed.
    await ctx.prisma.message.updateMany({ where: { campaignId }, data: { createdAt: new Date(Date.now() - 120_000) } });
    expect((await api('post', `/campaigns/${campaignId}/resume`)).status).toBe(200);
    const sentBefore = fake.sends.length;
    await dispatchAndSend(campaignId);
    expect(fake.sends.length).toBe(sentBefore);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId } });
    expect(messages.map((m) => [m.status, m.expiredReason])).toEqual([
      ['EXPIRED', 'EXPIRED_BEFORE_SENDING'],
      ['EXPIRED', 'EXPIRED_BEFORE_SENDING'],
    ]);
    const events = await ctx.prisma.messageEvent.count({ where: { messageId: { in: messages.map((m) => m.id) }, type: 'EXPIRED' } });
    expect(events).toBe(2);
  });

  it('marks sent messages not delivered in time after the time-to-live and the grace; a late webhook wins; the campaign completes with them counted', async () => {
    const { campaignId, phones } = await launched(60);
    await dispatchAndSend(campaignId);
    const sent = await ctx.prisma.message.findMany({ where: { campaignId }, orderBy: { phoneE164: 'asc' } });
    expect(sent.every((m) => m.status === 'SENT' && m.expiresAt !== null)).toBe(true);
    // Every message sent: the campaign completes (EXPIRED will be final too).
    await ctx.app.get(CampaignProgressProcessor).refresh();
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).state).toBe('COMPLETED');

    const sweep = ctx.app.get(ExpiredSweepProcessor);
    const deadline = Math.max(...sent.map((m) => m.expiresAt!.getTime()));
    // Within the 10-minute grace nothing changes; after it both are marked.
    await sweep.sweep(new Date(deadline + 5 * 60_000));
    expect((await ctx.prisma.message.findMany({ where: { campaignId } })).every((m) => m.status === 'SENT')).toBe(true);
    expect(await sweep.sweep(new Date(deadline + 11 * 60_000))).toBeGreaterThanOrEqual(2);
    const marked = await ctx.prisma.message.findMany({ where: { campaignId } });
    expect(marked.every((m) => m.status === 'EXPIRED' && m.expiredReason === 'NOT_DELIVERED_IN_TIME')).toBe(true);

    // The delivered status arrives late for the first one: it replaces the mark.
    const late = sent[0]!;
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, late.waMessageId!, late.phoneE164!.slice(1), 'delivered')));
    expect(await ctx.prisma.message.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ status: 'DELIVERED', expiredReason: null });

    await ctx.app.get(CampaignProgressProcessor).refresh();
    const totals = (await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).totals as Record<string, number>;
    expect(totals).toMatchObject({ delivered: 1, expired: 1 });
    expect(phones).toHaveLength(2);
  });

  it('never marks messages of a time-to-live applied only by our queue: they get no delivery deadline', async () => {
    const { campaignId } = await launched(43_200, 'MARKETING');
    await dispatchAndSend(campaignId);
    await ctx.app.get(ExpiredSweepProcessor).sweep(new Date(Date.now() + 2 * 86_400_000));
    const messages = await ctx.prisma.message.findMany({ where: { campaignId } });
    expect(messages.map((m) => [m.status, m.expiresAt])).toEqual([
      ['SENT', null],
      ['SENT', null],
    ]);
  });
});
