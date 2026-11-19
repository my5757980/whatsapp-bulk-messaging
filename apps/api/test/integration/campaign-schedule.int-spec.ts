import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { ScheduleReconcilerProcessor } from '../../src/modules/campaigns/schedule-reconciler.processor.js';
import { ScheduleService } from '../../src/modules/campaigns/schedule.service.js';
import { digits, seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T144 (scheduling, FR-026) and T149 (messaging-limit warning).
describe('Campaign scheduling', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let campaignId: string;
  let numberId: string;

  const post = (path: string, body?: unknown) => admin.agent.post(path).set('x-csrf-token', admin.csrf).send(body as object);
  const startJobs = async () => (await ctx.app.get(QueueRegistry).get(QUEUES.MAINTENANCE).getDelayed()).filter((j) => j.name === 'campaign-start' && j.data.campaignId === campaignId);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    numberId = number.id;
    const template = await seedTemplate(ctx, number.wabaId);
    const tag = await ctx.prisma.tag.create({ data: { name: `sched-${digits(4)}` } });
    const contacts = [await seedContact(ctx, uaePhone()), await seedContact(ctx, uaePhone())];
    await ctx.prisma.contactTag.createMany({ data: contacts.map((c) => ({ contactId: c.id, tagId: tag.id })) });
    const draft = await post('/api/campaigns', {
      name: 'Scheduled campaign',
      numberId,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tag.name }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
    });
    campaignId = draft.body.id;
  });
  afterAll(async () => ctx.close());

  it('warns when the audience exceeds the number messaging limit', async () => {
    await ctx.prisma.whatsAppNumber.update({ where: { id: numberId }, data: { messagingLimitTier: 'TIER_1' } });
    const estimate = await post(`/api/campaigns/${campaignId}/estimate`);
    expect(estimate.body.messagingLimitWarning).toMatch(/messaging limit/i);
    await ctx.prisma.whatsAppNumber.update({ where: { id: numberId }, data: { messagingLimitTier: 'TIER_2K' } });
    expect((await post(`/api/campaigns/${campaignId}/estimate`)).body.messagingLimitWarning).toBeNull();
  });

  it('rejects a time in the past', async () => {
    const res = await post(`/api/campaigns/${campaignId}/launch`, { scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([expect.objectContaining({ field: 'scheduledAt' })]);
  });

  it('schedules with a delayed start job and takes no snapshot yet', async () => {
    const at = new Date(Date.now() + 10 * 60_000);
    const res = await post(`/api/campaigns/${campaignId}/launch`, { scheduledAt: at.toISOString(), timezone: 'Asia/Dubai' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'SCHEDULED', scheduledAt: at.toISOString(), timezone: 'Asia/Dubai' });
    expect(await ctx.prisma.message.count({ where: { campaignId } })).toBe(0);
    const jobs = await startJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.opts.delay).toBeGreaterThan(9 * 60_000);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.scheduled', targetId: campaignId } })).toBe(1);
  });

  it('unschedules back to a draft and removes the start job', async () => {
    const res = await post(`/api/campaigns/${campaignId}/unschedule`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'DRAFT', scheduledAt: null });
    expect(await startJobs()).toHaveLength(0);
    expect((await post(`/api/campaigns/${campaignId}/unschedule`)).status).toBe(409);
  });

  it('starts a due campaign through the reconciler even when the delayed job was lost', async () => {
    await post(`/api/campaigns/${campaignId}/launch`, { scheduledAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    for (const job of await startJobs()) await job.remove(); // simulated job loss
    await ctx.prisma.campaign.update({ where: { id: campaignId }, data: { scheduledAt: new Date(Date.now() - 1_000) } });

    const reconciler = ctx.app.get(ScheduleReconcilerProcessor);
    expect(await reconciler.reconcile()).toBe(1);
    const started = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(started.state).toBe('RUNNING');
    expect(started.launchedAt).toBeTruthy();
    expect(await ctx.prisma.message.count({ where: { campaignId, status: 'PENDING' } })).toBe(2);

    // Idempotent: a late start job or another reconciler pass changes nothing.
    expect(await reconciler.reconcile()).toBe(0);
    expect(await ctx.app.get(ScheduleService).startScheduled(campaignId)).toBe(false);
    expect(await ctx.prisma.message.count({ where: { campaignId } })).toBe(2);
  });
});
