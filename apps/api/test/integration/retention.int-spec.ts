import { randomInt, randomUUID } from 'node:crypto';
import { makeChatRef, makeLinkCode } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { RetentionService } from '../../src/modules/maintenance/retention.processor.js';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type TestContext } from '../support/test-context.js';

// T195: data retention (data-model.md §Retention) - campaigns and messages 12 months, webhook
// events and uploaded files 30 days, audit logs never purged by the job.
const DAY = 24 * 3600 * 1000;
const monthsAgo = (months: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
};

describe('Retention', () => {
  let ctx: TestContext;
  let retention: RetentionService;
  let userId: string;
  let numberId: string;
  let templateId: string;

  const campaignWithMessages = async (state: 'RUNNING' | 'PAUSED' = 'RUNNING') => {
    const contacts = await Promise.all([uaePhone(), uaePhone()].map((p) => seedContact(ctx, p)));
    return seedRunningCampaign(ctx, { numberId, templateId, createdById: userId, contacts, state });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    retention = ctx.app.get(RetentionService);
    userId = (await signIn(ctx, 'ADMIN')).userId;
    const number = await seedNumber(ctx);
    numberId = number.id;
    templateId = (await seedTemplate(ctx, number.wabaId)).id;
  });
  afterAll(async () => ctx.close());

  it('purges finished campaigns older than 12 months with their messages, events and uploads', async () => {
    const old = await campaignWithMessages();
    await ctx.prisma.campaign.update({ where: { id: old.id }, data: { state: 'COMPLETED', completedAt: monthsAgo(13) } });
    const oldMessage = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: old.id } });
    await ctx.prisma.messageEvent.create({ data: { messageId: oldMessage.id, type: 'QUEUED', occurredAt: monthsAgo(13), dedupeKey: `${oldMessage.id}:queued` } });
    await ctx.prisma.campaignUploadRow.create({ data: { campaignId: old.id, rowNumber: 2, phoneE164: oldMessage.phoneE164!, data: {} } });
    const upload = await ctx.prisma.importJob.create({
      data: { kind: 'CAMPAIGN_AUDIENCE', campaignId: old.id, fileKey: `uploads/campaigns/${old.id}/x.csv`, status: 'COMPLETED', createdById: userId },
    });

    const recent = await campaignWithMessages();
    await ctx.prisma.campaign.update({ where: { id: recent.id }, data: { state: 'COMPLETED', completedAt: monthsAgo(11) } });
    const paused = await campaignWithMessages('PAUSED');
    await ctx.prisma.$executeRaw`UPDATE campaigns SET created_at = ${monthsAgo(14)}, updated_at = ${monthsAgo(14)} WHERE id = ${paused.id}::uuid`;
    const retarget = await ctx.prisma.campaign.create({ data: { name: `Retarget ${randomUUID()}`, createdById: userId, sourceCampaignId: old.id } });

    const contact = await seedContact(ctx, uaePhone());
    const apiMessage = (createdAt: Date) =>
      ctx.prisma.message.create({
        data: { origin: 'API', contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId, templateId, status: 'SENT', createdAt },
      });
    const oldApi = await apiMessage(monthsAgo(13));
    const newApi = await apiMessage(monthsAgo(1));
    const audit = await ctx.prisma.auditLog.create({ data: { action: 'campaign.launched', targetType: 'campaign', targetId: old.id, createdAt: monthsAgo(13) } });

    const result = await retention.purgeCampaigns(new Date());
    expect(result.campaigns).toBeGreaterThanOrEqual(1);
    expect(result.messages).toBeGreaterThanOrEqual(3);

    expect(await ctx.prisma.campaign.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.message.count({ where: { campaignId: old.id } })).toBe(0);
    expect(await ctx.prisma.messageEvent.count({ where: { messageId: oldMessage.id } })).toBe(0);
    expect(await ctx.prisma.campaignUploadRow.count({ where: { campaignId: old.id } })).toBe(0);
    expect(await ctx.prisma.importJob.findUnique({ where: { id: upload.id } })).toBeNull();

    expect(await ctx.prisma.message.count({ where: { campaignId: recent.id } })).toBe(2);
    expect(await ctx.prisma.campaign.findUnique({ where: { id: paused.id } })).not.toBeNull();
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: retarget.id } })).sourceCampaignId).toBeNull();
    expect(await ctx.prisma.message.findUnique({ where: { id: oldApi.id } })).toBeNull();
    expect(await ctx.prisma.message.findUnique({ where: { id: newApi.id } })).not.toBeNull();
    expect(await ctx.prisma.auditLog.findUnique({ where: { id: audit.id } })).not.toBeNull();
  });

  it('purges webhook events and uploaded files older than 30 days', async () => {
    const oldEvent = await ctx.prisma.webhookEvent.create({ data: { signatureValid: true, payload: {}, receivedAt: new Date(Date.now() - 31 * DAY) } });
    const newEvent = await ctx.prisma.webhookEvent.create({ data: { signatureValid: true, payload: {}, receivedAt: new Date(Date.now() - 29 * DAY) } });
    expect(await retention.purgeWebhookEvents(new Date())).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.webhookEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull();
    expect(await ctx.prisma.webhookEvent.findUnique({ where: { id: newEvent.id } })).not.toBeNull();

    const storage = ctx.app.get(StorageService);
    const prefix = `uploads/retention-${randomUUID()}/`;
    const source = `${prefix}contacts.csv`;
    const errors = `${prefix}contacts-errors.csv`;
    await storage.put(source, 'phone\n+971500000001\n', 'text/csv');
    await storage.put(errors, 'row,error\n3,invalid phone\n', 'text/csv');
    const job = await ctx.prisma.importJob.create({ data: { kind: 'CONTACTS', fileKey: source, errorFileKey: errors, status: 'COMPLETED', createdById: userId } });

    expect(await retention.purgeUploadFiles(new Date(Date.now() + 29 * DAY), prefix)).toBe(0);
    expect((await storage.getBuffer(source)).length).toBeGreaterThan(0);
    expect(await retention.purgeUploadFiles(new Date(Date.now() + 31 * DAY), prefix)).toBe(2);
    await expect(storage.getBuffer(source)).rejects.toThrow();
    await expect(storage.getBuffer(errors)).rejects.toThrow();
    // The error report is no longer offered once its file is gone.
    expect((await ctx.prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).errorFileKey).toBeNull();
  });

  it('purges live chat items, journey events and openings older than 12 months, and unused customer media (002)', async () => {
    const storage = ctx.app.get(StorageService);
    const contact = await seedContact(ctx, uaePhone());
    const old = monthsAgo(13);
    const recent = monthsAgo(11);
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId, lastActivityAt: old, lastMessagePreview: 'Old private text' } });
    const media = async (key: string, createdAt: Date) => {
      await storage.put(key, Buffer.from('jpeg'), 'image/jpeg');
      return ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 4, purpose: 'INBOUND', createdAt } });
    };
    const oldMedia = await media(`inbound/retention-${randomUUID()}.jpg`, old);
    const keptMedia = await media(`inbound/retention-${randomUUID()}.jpg`, old);
    const item = (occurredAt: Date, mediaAssetId?: string) =>
      ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: mediaAssetId ? 'IMAGE' : 'TEXT', text: 'hello', mediaAssetId, occurredAt } });
    const oldItem = await item(old, oldMedia.id);
    const newItem = await item(recent, keptMedia.id);
    const oldEvent = await ctx.prisma.conversationEvent.create({ data: { conversationId: chat.id, type: 'REQUESTED', actorType: 'CUSTOMER', occurredAt: old } });
    const newEvent = await ctx.prisma.conversationEvent.create({ data: { conversationId: chat.id, type: 'REQUESTED', actorType: 'CUSTOMER', occurredAt: recent } });
    const oldOpening = await ctx.prisma.conversationOpening.create({ data: { conversationId: chat.id, openedAt: old } });
    const newOpening = await ctx.prisma.conversationOpening.create({ data: { conversationId: chat.id, openedAt: recent } });

    const result = await retention.purgeLiveChat(new Date());
    expect(result.chatItems).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.chatMessage.findUnique({ where: { id: oldItem.id } })).toBeNull();
    expect(await ctx.prisma.chatMessage.findUnique({ where: { id: newItem.id } })).not.toBeNull();
    expect(await ctx.prisma.conversationEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull();
    expect(await ctx.prisma.conversationEvent.findUnique({ where: { id: newEvent.id } })).not.toBeNull();
    expect(await ctx.prisma.conversationOpening.findUnique({ where: { id: oldOpening.id } })).toBeNull();
    expect(await ctx.prisma.conversationOpening.findUnique({ where: { id: newOpening.id } })).not.toBeNull();
    // The chat stays, without its old preview.
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ lastMessagePreview: null });
    // Media no item uses is deleted with its file; media still in use is kept.
    expect(await ctx.prisma.mediaAsset.findUnique({ where: { id: oldMedia.id } })).toBeNull();
    await expect(storage.getBuffer(oldMedia.storageKey)).rejects.toThrow();
    expect(await ctx.prisma.mediaAsset.findUnique({ where: { id: keptMedia.id } })).not.toBeNull();
    expect((await storage.getBuffer(keptMedia.storageKey)).length).toBe(4);
  });

  it('purges chatbot flow sessions that ended over 12 months ago, with their step records (003)', async () => {
    const number = await seedNumber(ctx);
    const contact = await seedContact(ctx, uaePhone());
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    const flow = await ctx.prisma.flow.create({ data: { name: `Retention flow ${randomUUID().slice(0, 6)}`, draft: { version: 1, start: null, triggers: [], steps: [] } } });
    const ended = (monthsAgo: number) => {
      const at = new Date();
      at.setUTCMonth(at.getUTCMonth() - monthsAgo);
      return ctx.prisma.flowSession.create({
        data: { flowId: flow.id, conversationId: chat.id, contactId: contact.id, numberId: number.id, startedBy: 'TRIGGER', status: 'ENDED', result: 'COMPLETED', startedAt: at, endedAt: at },
      });
    };
    const old = await ended(13);
    await ctx.prisma.flowSessionStep.create({ data: { sessionId: old.id, flowId: flow.id, stepId: 'a', enteredAt: old.startedAt } });
    const recent = await ended(11);

    expect(await retention.purgeFlowSessions(new Date())).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.flowSession.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.flowSessionStep.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await ctx.prisma.flowSession.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('purges AI conversations that ended over 12 months ago with their replies and asks, stale questions and old assistant requests (004)', async () => {
    const number = await seedNumber(ctx);
    const contact = await seedContact(ctx, uaePhone());
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    const agent = await ctx.prisma.aiAgent.create({ data: { name: `Retention agent ${randomUUID().slice(0, 6)}`, draft: {} } });
    const question = await ctx.prisma.aiUnansweredQuestion.create({
      data: { agentId: agent.id, text: 'Do you ship to Oman?', normalized: `ship oman ${randomUUID()}`, askCount: 2, firstAskedAt: monthsAgo(13), lastAskedAt: monthsAgo(2) },
    });
    const ended = async (months: number) => {
      const at = monthsAgo(months);
      const conversation = await ctx.prisma.aiConversation.create({
        data: { conversationId: chat.id, agentId: agent.id, contactId: contact.id, numberId: number.id, startedBy: 'CUSTOMER', status: 'ENDED', result: 'EXPIRED', summary: 'Asked about shipping', startedAt: at, lastActivityAt: at, endedAt: at },
      });
      await ctx.prisma.aiReply.create({ data: { aiConversationId: conversation.id, agentId: agent.id, kind: 'REPLY', modelId: 'claude-opus-5-5', createdAt: at } });
      await ctx.prisma.aiUnansweredAsk.create({ data: { questionId: question.id, aiConversationId: conversation.id, askedAt: at } });
      return conversation;
    };
    const old = await ended(13);
    const recent = await ended(2);
    const stale = await ctx.prisma.aiUnansweredQuestion.create({
      data: { agentId: agent.id, text: 'Old question', normalized: `old question ${randomUUID()}`, askCount: 0, firstAskedAt: monthsAgo(15), lastAskedAt: monthsAgo(13) },
    });
    const oldRequest = await ctx.prisma.assistantRequest.create({ data: { userId, prompt: 'An old request', status: 'DONE', createdAt: monthsAgo(13) } });
    await ctx.prisma.assistantAction.create({ data: { requestId: oldRequest.id, userId, kind: 'DELETE_TAGS', status: 'EXPIRED', params: {}, preview: {}, expiresAt: monthsAgo(13) } });
    const newRequest = await ctx.prisma.assistantRequest.create({ data: { userId, prompt: 'A new request', status: 'DONE' } });

    const result = await retention.purgeAi(new Date());
    expect(result.aiConversations).toBeGreaterThanOrEqual(1);
    expect(result.assistantRequests).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.aiConversation.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.aiReply.count({ where: { aiConversationId: old.id } })).toBe(0);
    expect(await ctx.prisma.aiConversation.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await ctx.prisma.aiReply.count({ where: { aiConversationId: recent.id } })).toBe(1);
    // The question keeps its recent ask and counts what is left; one nobody asked for a year goes.
    expect(await ctx.prisma.aiUnansweredQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ askCount: 1 });
    expect(await ctx.prisma.aiUnansweredQuestion.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await ctx.prisma.assistantRequest.findUnique({ where: { id: oldRequest.id } })).toBeNull();
    expect(await ctx.prisma.assistantAction.count({ where: { requestId: oldRequest.id } })).toBe(0);
    expect(await ctx.prisma.assistantRequest.findUnique({ where: { id: newRequest.id } })).not.toBeNull();
  });

  it('purges link clicks after 12 months, ended enrolments 12 months on and stale starting events; tracked links go with their messages (005 T061)', async () => {
    const code = () => `Rt${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const linked = async (completedAt: Date) => {
      const campaign = await campaignWithMessages();
      await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'COMPLETED', completedAt } });
      const message = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: campaign.id } });
      const target = await ctx.prisma.trackedLinkTarget.create({ data: { campaignId: campaign.id, variableKey: 'BODY.1', destination: 'https://shop.example/keep' } });
      const link = await ctx.prisma.trackedLink.create({ data: { code: code(), targetId: target.id, messageId: message.id, contactId: message.contactId } });
      return { campaign, target, link };
    };
    const click = (l: Awaited<ReturnType<typeof linked>>, clickedAt: Date) =>
      ctx.prisma.linkClick.create({ data: { trackedLinkId: l.link.id, targetId: l.target.id, campaignId: l.campaign.id, contactId: l.link.contactId, device: 'MOBILE', clickedAt } });

    // An old campaign's messages are purged by 001; their tracked links and clicks go with them.
    const old = await linked(monthsAgo(13));
    await click(old, monthsAgo(1));
    await retention.purgeCampaigns(new Date());
    expect(await ctx.prisma.trackedLink.findUnique({ where: { id: old.link.id } })).toBeNull();
    expect(await ctx.prisma.linkClick.count({ where: { trackedLinkId: old.link.id } })).toBe(0);

    // A recent campaign keeps its links; only its clicks older than 12 months go.
    const recent = await linked(monthsAgo(2));
    const oldClick = await click(recent, monthsAgo(13));
    const newClick = await click(recent, monthsAgo(1));

    const contact = await seedContact(ctx, uaePhone());
    const drip = await ctx.prisma.drip.create({ data: { name: `Retention drip ${randomUUID().slice(0, 6)}`, numberId, status: 'ACTIVE' } });
    const step = await ctx.prisma.dripStep.create({ data: { dripId: drip.id, position: 1, templateId, waitMinutes: 0 } });
    const enrolment = (data: { status: 'ACTIVE' | 'FINISHED' | 'LEFT'; endedAt?: Date; joinedAt: Date; dripId?: string }) =>
      ctx.prisma.dripEnrolment.create({
        data: { dripId: data.dripId ?? drip.id, contactId: contact.id, joinedVia: 'MANUAL', status: data.status, joinedAt: data.joinedAt, endedAt: data.endedAt ?? null, leftReason: data.status === 'LEFT' ? 'REPLIED' : null },
      });
    const finishedLongAgo = await enrolment({ status: 'FINISHED', joinedAt: monthsAgo(14), endedAt: monthsAgo(13) });
    await ctx.prisma.dripStepSend.create({ data: { enrolmentId: finishedLongAgo.id, stepId: step.id, outcome: 'SKIPPED', skipReason: 'NO_OPT_IN' } });
    const other = await ctx.prisma.drip.create({ data: { name: `Retention drip ${randomUUID().slice(0, 6)}`, numberId, status: 'ACTIVE' } });
    const leftRecently = await enrolment({ status: 'LEFT', joinedAt: monthsAgo(14), endedAt: monthsAgo(11), dripId: other.id });
    const third = await ctx.prisma.drip.create({ data: { name: `Retention drip ${randomUUID().slice(0, 6)}`, numberId, status: 'ACTIVE' } });
    const stillIn = await enrolment({ status: 'ACTIVE', joinedAt: monthsAgo(14), dripId: third.id });

    const staleEvent = await ctx.prisma.dripEvent.create({ data: { kind: 'OPTED_IN', contactId: contact.id, occurredAt: new Date(Date.now() - 2 * DAY) } });
    const freshEvent = await ctx.prisma.dripEvent.create({ data: { kind: 'OPTED_IN', contactId: contact.id } });

    const result = await retention.purgeGrowth(new Date());
    expect(result.linkClicks).toBeGreaterThanOrEqual(1);
    expect(result.dripEnrolments).toBeGreaterThanOrEqual(1);
    expect(result.dripEvents).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.linkClick.findUnique({ where: { id: oldClick.id } })).toBeNull();
    expect(await ctx.prisma.linkClick.findUnique({ where: { id: newClick.id } })).not.toBeNull();
    expect(await ctx.prisma.trackedLink.findUnique({ where: { id: recent.link.id } })).not.toBeNull();
    expect(await ctx.prisma.dripEnrolment.findUnique({ where: { id: finishedLongAgo.id } })).toBeNull();
    expect(await ctx.prisma.dripStepSend.count({ where: { enrolmentId: finishedLongAgo.id } })).toBe(0);
    expect(await ctx.prisma.dripEnrolment.findUnique({ where: { id: leftRecently.id } })).not.toBeNull();
    expect(await ctx.prisma.dripEnrolment.findUnique({ where: { id: stillIn.id } })).not.toBeNull();
    expect(await ctx.prisma.dripEvent.findUnique({ where: { id: staleEvent.id } })).toBeNull();
    expect(await ctx.prisma.dripEvent.findUnique({ where: { id: freshEvent.id } })).not.toBeNull();
    await ctx.prisma.dripEvent.delete({ where: { id: freshEvent.id } });
  });

  it('purges integration records: events after 30 days, calls, orders, carts, chat links and checks after 12 months (006)', async () => {
    const recent = new Date(Date.now() - DAY);
    const oldShort = new Date(Date.now() - 31 * DAY);
    const old = monthsAgo(13);
    const endpoint = await ctx.prisma.webhookEndpoint.create({ data: { name: `Retention ${randomUUID()}`, url: 'https://hooks.example.test/in', secretEncrypted: 'x', eventTypes: ['contact.created'] } });
    const oldEvent = await ctx.prisma.outboundEvent.create({ data: { type: 'contact.created', occurredAt: oldShort, data: {}, createdAt: oldShort } });
    const newEvent = await ctx.prisma.outboundEvent.create({ data: { type: 'contact.created', occurredAt: recent, data: {}, createdAt: recent } });
    const oldDelivery = await ctx.prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, eventId: oldEvent.id, status: 'DELIVERED' } });
    const store = await ctx.prisma.storeConnection.create({
      data: { platform: 'WOOCOMMERCE', name: 'Retention shop', baseUrl: `https://${randomUUID()}.example.test`, credentialsEncrypted: 'x', numberId, defaultCountry: 'AE', customerTag: 'woo', status: 'DISCONNECTED' },
    });
    const storeEvent = (receivedAt: Date) => ctx.prisma.storeEvent.create({ data: { storeId: store.id, externalId: randomUUID(), topic: 'order.created', payload: {}, receivedAt } });
    const [oldStoreEvent, newStoreEvent] = [await storeEvent(oldShort), await storeEvent(recent)];
    const campaign = await ctx.prisma.apiCampaign.create({ data: { name: `Retention ${randomUUID()}`, apiName: `retention-${randomUUID().slice(0, 8)}`, numberId, templateId } });
    const trigger = (createdAt: Date) => ctx.prisma.apiCampaignTrigger.create({ data: { apiCampaignId: campaign.id, outcome: 'NOT_SENT', reason: 'no_phone', createdAt } });
    const [oldTrigger, newTrigger] = [await trigger(old), await trigger(recent)];
    const order = (createdAt: Date) =>
      ctx.prisma.storeOrder.create({
        data: { storeId: store.id, externalId: randomUUID(), orderNumber: '#1', total: '10.00', currency: 'AED', paymentKind: 'PREPAID', status: 'completed', placedAt: createdAt, storeUpdatedAt: createdAt, createdAt },
      });
    const [oldOrder, newOrder] = [await order(old), await order(recent)];
    await ctx.prisma.storeOrderMessage.create({ data: { orderId: oldOrder.id, kind: 'ORDER_CONFIRMED', outcome: 'SKIPPED', skipReason: 'off' } });
    const cart = (createdAt: Date) =>
      ctx.prisma.storeCart.create({ data: { storeId: store.id, externalId: randomUUID(), value: '10.00', currency: 'AED', startedAt: createdAt, storeUpdatedAt: createdAt, status: 'EXPIRED', createdAt } });
    const [oldCart, newCart] = [await cart(old), await cart(recent)];
    const link = await ctx.prisma.chatLink.create({ data: { name: `Retention ${randomUUID()}`, numberId, message: 'Hi', ref: makeChatRef(randomInt), code: makeLinkCode(randomInt) } });
    const [oldOpen, newOpen] = [await ctx.prisma.chatLinkOpen.create({ data: { chatLinkId: link.id, device: 'MOBILE', openedAt: old } }), await ctx.prisma.chatLinkOpen.create({ data: { chatLinkId: link.id, device: 'MOBILE', openedAt: recent } })];
    const [oldStart, newStart] = [
      await ctx.prisma.chatLinkStart.create({ data: { chatLinkId: link.id, newContact: true, startedAt: old } }),
      await ctx.prisma.chatLinkStart.create({ data: { chatLinkId: link.id, newContact: false, startedAt: recent } }),
    ];
    const [oldCheck, newCheck] = [await ctx.prisma.numberConnectionCheck.create({ data: { results: [], createdAt: old } }), await ctx.prisma.numberConnectionCheck.create({ data: { results: [], createdAt: recent } })];

    const result = await retention.purgeIntegrations(new Date());
    for (const key of ['outboundEvents', 'storeEvents', 'apiCampaignTriggers', 'storeOrders', 'storeCarts', 'chatLinkOpens', 'chatLinkStarts', 'connectionChecks'] as const) expect(result[key], key).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.outboundEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull();
    expect(await ctx.prisma.webhookDelivery.findUnique({ where: { id: oldDelivery.id } })).toBeNull();
    expect(await ctx.prisma.outboundEvent.findUnique({ where: { id: newEvent.id } })).not.toBeNull();
    expect(await ctx.prisma.storeEvent.findUnique({ where: { id: oldStoreEvent.id } })).toBeNull();
    expect(await ctx.prisma.storeEvent.findUnique({ where: { id: newStoreEvent.id } })).not.toBeNull();
    expect(await ctx.prisma.apiCampaignTrigger.findUnique({ where: { id: oldTrigger.id } })).toBeNull();
    expect(await ctx.prisma.apiCampaignTrigger.findUnique({ where: { id: newTrigger.id } })).not.toBeNull();
    expect(await ctx.prisma.storeOrder.findUnique({ where: { id: oldOrder.id } })).toBeNull();
    expect(await ctx.prisma.storeOrderMessage.count({ where: { orderId: oldOrder.id } })).toBe(0);
    expect(await ctx.prisma.storeOrder.findUnique({ where: { id: newOrder.id } })).not.toBeNull();
    expect(await ctx.prisma.storeCart.findUnique({ where: { id: oldCart.id } })).toBeNull();
    expect(await ctx.prisma.storeCart.findUnique({ where: { id: newCart.id } })).not.toBeNull();
    expect(await ctx.prisma.chatLinkOpen.findUnique({ where: { id: oldOpen.id } })).toBeNull();
    expect(await ctx.prisma.chatLinkOpen.findUnique({ where: { id: newOpen.id } })).not.toBeNull();
    expect(await ctx.prisma.chatLinkStart.findUnique({ where: { id: oldStart.id } })).toBeNull();
    expect(await ctx.prisma.chatLinkStart.findUnique({ where: { id: newStart.id } })).not.toBeNull();
    expect(await ctx.prisma.numberConnectionCheck.findUnique({ where: { id: oldCheck.id } })).toBeNull();
    expect(await ctx.prisma.numberConnectionCheck.findUnique({ where: { id: newCheck.id } })).not.toBeNull();
    await ctx.prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  });

  it('purges ads records: Meta\'s numbers after 25 months; leads, ad chats and visits after 12 months (007)', async () => {
    const recent = new Date(Date.now() - DAY);
    const old = monthsAgo(13);
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/ret-${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1_000, purpose: 'LIBRARY' } });
    const campaign = await ctx.prisma.adCampaign.create({
      data: {
        name: `Retention ad ${randomUUID()}`,
        goal: 'WEBSITE',
        status: 'ENDED',
        websiteUrl: 'https://example.com',
        targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country' }] },
        placements: { auto: true },
        dailyBudgetMinor: 5_000n,
        currency: 'AED',
        startAt: monthsAgo(30),
        versions: { create: [{ position: 1, mediaAssetId: media.id, mediaKind: 'IMAGE', primaryText: 'x', headline: 'x', callToAction: 'LEARN_MORE' }] },
      },
    });
    const dayOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
    const resultDay = (day: Date) => ctx.prisma.adResultDay.create({ data: { adCampaignId: campaign.id, day: dayOf(day), spendMinor: 100n, readAt: day } });
    const [veryOldDay, keptDay] = [await resultDay(monthsAgo(26)), await resultDay(monthsAgo(24))];
    const form = await ctx.prisma.adLeadForm.create({ data: { name: `Retention form ${randomUUID()}`, questions: { standard: ['PHONE'] }, privacyUrl: 'https://example.com/p', consentText: 'WhatsApp offers please' } });
    const leadAt = (receivedAt: Date) => ctx.prisma.adLead.create({ data: { formId: form.id, metaLeadId: randomUUID(), status: 'NO_PHONE', submittedAt: receivedAt, receivedAt } });
    const [oldLead, newLead] = [await leadAt(old), await leadAt(recent)];
    const startAt = (startedAt: Date) => ctx.prisma.adChatStart.create({ data: { metaAdId: randomUUID().slice(0, 20), adCampaignId: campaign.id, newContact: false, startedAt } });
    const [oldStart, newStart] = [await startAt(old), await startAt(recent)];
    const visitAt = (openedAt: Date) => ctx.prisma.adLinkOpen.create({ data: { adCampaignId: campaign.id, device: 'MOBILE', openedAt } });
    const [oldVisit, newVisit] = [await visitAt(old), await visitAt(recent)];

    const result = await retention.purgeAds(new Date());
    for (const key of ['adResultDays', 'adLeads', 'adChatStarts', 'adLinkOpens'] as const) expect(result[key], key).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.adResultDay.findUnique({ where: { id: veryOldDay.id } })).toBeNull();
    expect(await ctx.prisma.adResultDay.findUnique({ where: { id: keptDay.id } })).not.toBeNull();
    expect(await ctx.prisma.adLead.findUnique({ where: { id: oldLead.id } })).toBeNull();
    expect(await ctx.prisma.adLead.findUnique({ where: { id: newLead.id } })).not.toBeNull();
    expect(await ctx.prisma.adChatStart.findUnique({ where: { id: oldStart.id } })).toBeNull();
    expect(await ctx.prisma.adChatStart.findUnique({ where: { id: newStart.id } })).not.toBeNull();
    expect(await ctx.prisma.adLinkOpen.findUnique({ where: { id: oldVisit.id } })).toBeNull();
    expect(await ctx.prisma.adLinkOpen.findUnique({ where: { id: newVisit.id } })).not.toBeNull();
  });

  it('purges commerce records: notifications after 30 days, form answers after 12 months, removed products after 90 days, requests and orders after 5 years (008 T092)', async () => {
    const recent = new Date(Date.now() - DAY);
    const event = (receivedAt: Date) => ctx.prisma.paymentEvent.create({ data: { stripeEventId: `evt_${randomUUID()}`, type: 'checkout.session.completed', signatureValid: true, result: 'APPLIED', receivedAt } });
    const [oldEvent, newEvent] = [await event(new Date(Date.now() - 31 * DAY)), await event(recent)];
    const contact = await seedContact(ctx, uaePhone());
    const form = await ctx.prisma.form.create({ data: { name: `Retention form ${randomUUID()}`, category: 'OTHER', status: 'PUBLISHED' } });
    const version = await ctx.prisma.formVersion.create({ data: { formId: form.id, number: 1, model: { screens: [] }, flowJson: {} } });
    const answer = (submittedAt: Date) => ctx.prisma.formAnswer.create({ data: { formId: form.id, formVersionId: version.id, contactId: contact.id, source: 'INBOX', answers: { name: 'x' }, submittedAt } });
    const [oldAnswer, newAnswer] = [await answer(monthsAgo(13)), await answer(recent)];
    const product = (removedAt: Date | null) => ctx.prisma.catalogProduct.create({ data: { retailerId: `ret-${randomUUID()}`, name: 'Old lamp', availability: 'in stock', removedAt } });
    const [gone, justRemoved, listed] = [await product(new Date(Date.now() - 91 * DAY)), await product(recent), await product(null)];
    const order = (createdAt: Date) => ctx.prisma.chatOrder.create({ data: { catalogId: '900000000000001', items: [], currency: 'AED', totalMinor: 1_000n, mode: 'AUTO', createdAt } });
    const [oldOrder, newOrder] = [await order(monthsAgo(61)), await order(monthsAgo(59))];
    const request = (createdAt: Date, chatOrderId: string) =>
      ctx.prisma.paymentRequest.create({ data: { code: randomUUID().replace(/-/g, '').slice(0, 12), source: 'CHAT_ORDER', status: 'PAID', amountMinor: 1_000n, currency: 'AED', description: 'Order', expiresAt: createdAt, chatOrderId, createdAt } });
    const [oldRequest, newRequest] = [await request(monthsAgo(61), oldOrder.id), await request(monthsAgo(59), newOrder.id)];
    await ctx.prisma.paymentEvent.update({ where: { id: newEvent.id }, data: { paymentRequestId: oldRequest.id } });

    const result = await retention.purgeCommerce(new Date());
    for (const key of ['paymentEvents', 'formAnswers', 'removedProducts', 'paymentRequests', 'chatOrders'] as const) expect(result[key], key).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.paymentEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull();
    expect(await ctx.prisma.paymentEvent.findUniqueOrThrow({ where: { id: newEvent.id } })).toMatchObject({ paymentRequestId: null });
    expect(await ctx.prisma.formAnswer.findUnique({ where: { id: oldAnswer.id } })).toBeNull();
    expect(await ctx.prisma.formAnswer.findUnique({ where: { id: newAnswer.id } })).not.toBeNull();
    expect(await ctx.prisma.catalogProduct.findUnique({ where: { id: gone.id } })).toBeNull();
    expect(await ctx.prisma.catalogProduct.count({ where: { id: { in: [justRemoved.id, listed.id] } } })).toBe(2);
    expect(await ctx.prisma.paymentRequest.findUnique({ where: { id: oldRequest.id } })).toBeNull();
    expect(await ctx.prisma.paymentRequest.findUnique({ where: { id: newRequest.id } })).not.toBeNull();
    expect(await ctx.prisma.chatOrder.findUnique({ where: { id: oldOrder.id } })).toBeNull();
    expect(await ctx.prisma.chatOrder.findUnique({ where: { id: newOrder.id } })).not.toBeNull();
    await ctx.prisma.paymentRequest.delete({ where: { id: newRequest.id } });
    await ctx.prisma.chatOrder.delete({ where: { id: newOrder.id } });
    await ctx.prisma.catalogProduct.deleteMany({ where: { id: { in: [justRemoved.id, listed.id] } } });
    await ctx.prisma.form.delete({ where: { id: form.id } });
  });

  it('deletes one-time code messages after 30 days (009 T091)', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'AUTHENTICATION', kind: 'AUTHENTICATION' });
    const code = (daysAgo: number) =>
      ctx.prisma.message.create({ data: { origin: 'OTP', phoneE164: uaePhone(), recipientCountry: 'AE', numberId: number.id, templateId: template.id, status: 'DELIVERED', resolvedParams: { 'BODY.1': '••••' }, createdAt: new Date(Date.now() - daysAgo * DAY) } });
    const [old, recent] = [await code(31), await code(29)];
    const result = await retention.run();
    expect(result.otpMessages).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.message.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.message.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('deletes bulk actions after 90 days, and date automation occurrences with their messages after 12 months (010 T084)', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const action = (daysAgo: number) =>
      ctx.prisma.bulkAction.create({ data: { kind: 'TAG_ADD', params: { tagIds: [] }, selection: { contactIds: [] }, status: 'DONE', createdAt: new Date(Date.now() - daysAgo * DAY) } });
    const [oldAction, newAction] = [await action(91), await action(89)];
    const automation = await ctx.prisma.dateAutomation.create({
      data: { name: `Retention dates ${randomUUID().slice(0, 6)}`, attributeKey: 'birthday', timing: 'YEARLY', sendTime: '09:00', numberId: number.id, templateId: template.id, variableMapping: {} },
    });
    const occurrence = async (when: Date) => {
      const message = await ctx.prisma.message.create({ data: { origin: 'DATE_AUTOMATION', contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId: number.id, templateId: template.id, status: 'DELIVERED', resolvedParams: {}, createdAt: when } });
      const day = new Date(`${when.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return ctx.prisma.dateAutomationOccurrence.create({ data: { automationId: automation.id, contactId: contact.id, dueDate: day, status: 'SENT', messageId: message.id } });
    };
    const [old, recent] = [await occurrence(monthsAgo(13)), await occurrence(monthsAgo(11))];

    const result = await retention.run();
    expect(result.bulkActions).toBeGreaterThanOrEqual(1);
    expect(result.dateOccurrences).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.bulkAction.findUnique({ where: { id: oldAction.id } })).toBeNull();
    expect(await ctx.prisma.bulkAction.findUnique({ where: { id: newAction.id } })).not.toBeNull();
    expect(await ctx.prisma.dateAutomationOccurrence.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.message.findUnique({ where: { id: old.messageId! } })).toBeNull();
    expect(await ctx.prisma.dateAutomationOccurrence.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await ctx.prisma.message.findUnique({ where: { id: recent.messageId! } })).not.toBeNull();
  });

  it('runs every step daily on the maintenance queue', async () => {
    expect(await retention.run()).toEqual({
      linkClicks: expect.any(Number),
      dripEnrolments: expect.any(Number),
      dripEvents: expect.any(Number),
      campaigns: expect.any(Number),
      messages: expect.any(Number),
      webhookEvents: expect.any(Number),
      files: expect.any(Number),
      chatItems: expect.any(Number),
      chatEvents: expect.any(Number),
      chatOpenings: expect.any(Number),
      chatMedia: expect.any(Number),
      flowSessions: expect.any(Number),
      aiConversations: expect.any(Number),
      aiReplies: expect.any(Number),
      aiAsks: expect.any(Number),
      assistantRequests: expect.any(Number),
      outboundEvents: expect.any(Number),
      storeEvents: expect.any(Number),
      apiCampaignTriggers: expect.any(Number),
      storeOrders: expect.any(Number),
      storeCarts: expect.any(Number),
      chatLinkOpens: expect.any(Number),
      chatLinkStarts: expect.any(Number),
      connectionChecks: expect.any(Number),
      adResultDays: expect.any(Number),
      adLeads: expect.any(Number),
      adChatStarts: expect.any(Number),
      adLinkOpens: expect.any(Number),
      paymentEvents: expect.any(Number),
      formAnswers: expect.any(Number),
      removedProducts: expect.any(Number),
      paymentRequests: expect.any(Number),
      chatOrders: expect.any(Number),
      otpMessages: expect.any(Number),
      bulkActions: expect.any(Number),
      dateOccurrences: expect.any(Number),
    });
    const scheduler = await ctx.app.get(QueueRegistry).get(QUEUES.MAINTENANCE).getJobScheduler('retention');
    expect(scheduler?.pattern).toBe('15 3 * * *');
  });
});
