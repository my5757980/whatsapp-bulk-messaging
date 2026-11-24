import { randomUUID } from 'node:crypto';
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
    });
    const scheduler = await ctx.app.get(QueueRegistry).get(QUEUES.MAINTENANCE).getJobScheduler('retention');
    expect(scheduler?.pattern).toBe('15 3 * * *');
  });
});
