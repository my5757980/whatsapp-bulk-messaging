import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { mockMetaSends, restoreNetwork, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly, type SentCall } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T081: pause / resume / cancel and the per-number kill switch (FR-023, Principle I, SC-004).
describe('Campaign control', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  const post = (path: string) => admin.agent.post(path).set('x-csrf-token', admin.csrf);
  const statusCounts = async (campaignId: string) => {
    const rows = await ctx.prisma.message.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  };

  async function setup(contactCount: number, rate = 2) {
    const number = await seedNumber(ctx, { sendRatePerSecond: rate });
    const template = await seedTemplate(ctx, number.wabaId);
    const contacts = [];
    for (let i = 0; i < contactCount; i++) contacts.push(await seedContact(ctx, uaePhone()));
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts });
    return { number, template, campaign, contacts };
  }

  /** Emulates the send worker: no BullMQ Worker runs in tests, so empty the buffer before each tick. */
  async function drain(campaignId: string, numberId: string, phoneNumberId: string, calls: SentCall[]) {
    const dispatcher = ctx.app.get(DispatcherProcessor);
    const sender = ctx.app.get(SendProcessor);
    const queue = ctx.app.get(QueueRegistry).sendQueue(numberId);
    for (let guard = 0; guard < 20; guard++) {
      await queue.drain();
      const tick = await dispatcher.tick(campaignId);
      if (tick.action !== 'claim' || tick.claimed === 0) return;
      const queued = await ctx.prisma.message.findMany({ where: { campaignId, status: 'QUEUED' } });
      mockMetaSends(phoneNumberId, queued.map((m) => m.phoneE164 as string), calls);
      for (const m of queued) await sender.process(m.id, 1);
    }
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('pauses within the buffer, resumes only unsent recipients and never sends twice', async () => {
    const { number, campaign, contacts } = await setup(6, 2);
    const calls: SentCall[] = [];
    const dispatcher = ctx.app.get(DispatcherProcessor);
    const sender = ctx.app.get(SendProcessor);

    expect(await dispatcher.tick(campaign.id)).toMatchObject({ action: 'claim', claimed: 4 }); // rate 2 x 2 s buffer
    const queued = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id, status: 'QUEUED' }, orderBy: { id: 'asc' } });
    mockMetaSends(number.phoneNumberId, [queued[0]!.phoneE164 as string], calls);
    expect(await sender.process(queued[0]!.id, 1)).toMatchObject({ result: 'sent' });

    const paused = await post(`/api/campaigns/${campaign.id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ state: 'PAUSED', pausedReason: 'manual' });
    expect(await statusCounts(campaign.id)).toEqual({ SENT: 1, PENDING: 5 });

    // Jobs still in the queue after the pause do not reach Meta (no mock is registered).
    for (const m of queued.slice(1)) expect(await sender.process(m.id, 1)).toEqual({ result: 'ignored' });
    expect(await dispatcher.tick(campaign.id)).toMatchObject({ action: 'stop' });
    expect((await post(`/api/campaigns/${campaign.id}/pause`)).status).toBe(409);

    const resumed = await post(`/api/campaigns/${campaign.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.state).toBe('RUNNING');
    await drain(campaign.id, number.id, number.phoneNumberId, calls);

    expect(await statusCounts(campaign.id)).toEqual({ SENT: 6 });
    const recipients = calls.map((c) => c.to);
    expect(new Set(recipients).size).toBe(6);
    expect(recipients.sort()).toEqual(contacts.map((c) => c.phoneE164.slice(1)).sort());
    for (const action of ['campaign.paused', 'campaign.resumed']) {
      expect(await ctx.prisma.auditLog.count({ where: { action, targetId: campaign.id } })).toBe(1);
    }
  });

  it('cancels remaining recipients', async () => {
    const { campaign } = await setup(4, 1);
    await ctx.app.get(DispatcherProcessor).tick(campaign.id); // 2 QUEUED, 2 PENDING
    const res = await post(`/api/campaigns/${campaign.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('CANCELLED');
    expect(await statusCounts(campaign.id)).toEqual({ CANCELLED: 4 });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.cancelled', targetId: campaign.id } })).toBe(1);
    expect((await post(`/api/campaigns/${campaign.id}/resume`)).status).toBe(409);
  });

  it('auto-pauses on the kill switch and refuses to resume until it is back on', async () => {
    const { number, campaign } = await setup(3, 5);
    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { sendingEnabled: false } });

    expect(await ctx.app.get(DispatcherProcessor).tick(campaign.id)).toMatchObject({ action: 'pause', reason: 'sending_disabled' });
    const paused = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(paused).toMatchObject({ state: 'PAUSED', pausedReason: 'sending_disabled' });
    expect(await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'CAMPAIGN_AUTO_PAUSED', link: `/campaigns/${campaign.id}` } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.auto_paused', targetId: campaign.id } })).toBe(1);

    const blocked = await post(`/api/campaigns/${campaign.id}/resume`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/sending is turned off/i);

    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { sendingEnabled: true } });
    expect((await post(`/api/campaigns/${campaign.id}/resume`)).status).toBe(200);
  });

  it('returns a queued message to PENDING when the kill switch flips mid-send', async () => {
    const { number, campaign } = await setup(1, 5);
    await ctx.app.get(DispatcherProcessor).tick(campaign.id);
    const message = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { sendingEnabled: false } });

    expect(await ctx.app.get(SendProcessor).process(message.id, 1)).toMatchObject({ result: 'requeued' });
    expect((await ctx.prisma.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe('PENDING');
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).pausedReason).toBe('sending_disabled');
  });

  it('is limited to roles with campaigns.launch', async () => {
    const { campaign } = await setup(1, 1);
    const agent = await signIn(ctx, 'AGENT');
    expect((await agent.agent.post(`/api/campaigns/${campaign.id}/pause`).set('x-csrf-token', agent.csrf)).status).toBe(403);
  });
});
