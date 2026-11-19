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

  it('runs every step daily on the maintenance queue', async () => {
    expect(await retention.run()).toEqual({ campaigns: expect.any(Number), messages: expect.any(Number), webhookEvents: expect.any(Number), files: expect.any(Number) });
    const scheduler = await ctx.app.get(QueueRegistry).get(QUEUES.MAINTENANCE).getJobScheduler('retention');
    expect(scheduler?.pattern).toBe('15 3 * * *');
  });
});
