import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { CampaignProgressProcessor } from '../../src/modules/campaigns/campaign-progress.processor.js';
import { RetryRoundsService } from '../../src/modules/growth/retries/retry-rounds.service.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { META_BASE, META_VERSION, mockMetaSends, restoreNetwork, seedContact, seedNumber, seedTemplate, uaePhone, useNockLocalOnly, type SentCall } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T034 (feature 005, US3, FR-013 - FR-018, research R4, R5): retry plans, rounds that re-send only
// failures that may pass, held-back messages, pausing, cancelling and skipping.
const HOUR = 3_600_000;

type Recipient = { name: string; status: 'FAILED' | 'DELIVERED' | 'SENT'; failureCode?: number | null; failureReason?: string | null };

describe('Retry rounds (005 US3)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let numberId: string;
  let phoneNumberId: string;
  let templateId: string;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) =>
    method === 'get' ? who.agent.get(`/api${url}`) : who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const progress = () => ctx.app.get(CampaignProgressProcessor).refresh();
  const rounds = () => ctx.app.get(RetryRoundsService);
  const makeDue = (campaignId: string, round: number) =>
    ctx.prisma.campaignRetryRound.update({ where: { campaignId_round: { campaignId, round } }, data: { dueAt: new Date(Date.now() - 60_000) } });

  /** A running campaign whose first pass is over, with the given results and retry plan. */
  async function seedCampaign(plan: { rounds: number; delays: number[]; launchedHoursAgo?: number }, recipients: Recipient[]) {
    const campaign = await ctx.prisma.campaign.create({
      data: {
        name: `Retries ${uniq('')}`,
        numberId,
        templateId,
        state: 'RUNNING',
        audienceType: 'ALL_OPTED_IN',
        variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
        launchedAt: new Date(Date.now() - (plan.launchedHoursAgo ?? 1) * HOUR),
        retryRounds: plan.rounds,
        retryDelaysMin: plan.delays,
        createdById: manager.userId,
      },
    });
    const byName: Record<string, { contactId: string; phone: string; messageId: string }> = {};
    for (const r of recipients) {
      const contact = await seedContact(ctx, uaePhone(), { name: r.name });
      const message = await ctx.prisma.message.create({
        data: {
          origin: 'CAMPAIGN',
          campaignId: campaign.id,
          contactId: contact.id,
          phoneE164: contact.phoneE164,
          recipientCountry: 'AE',
          numberId,
          templateId,
          resolvedParams: { 'BODY.1': r.name },
          status: r.status,
          sentAt: r.status === 'FAILED' ? null : new Date(),
          deliveredAt: r.status === 'DELIVERED' ? new Date() : null,
          failedAt: r.status === 'FAILED' ? new Date() : null,
          failureCode: r.failureCode ?? null,
          failureReason: r.failureReason ?? (r.status === 'FAILED' ? 'failed' : null),
          attempts: 1,
        },
      });
      byName[r.name] = { contactId: contact.id, phone: contact.phoneE164, messageId: message.id };
    }
    return { id: campaign.id, byName };
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx, { sendRatePerSecond: 20 });
    numberId = number.id;
    phoneNumberId = number.phoneNumberId;
    templateId = (await seedTemplate(ctx, number.wabaId)).id;
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('saves a plan of up to 3 rounds within 24 hours, before the campaign starts', async () => {
    const draft = await api(manager, 'post', '/campaigns', { name: `Retry plan ${uniq('')}`, numberId, templateId, audienceType: 'ALL_OPTED_IN' });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    expect((await api(agent, 'get', `/campaigns/${id}/retry-plan`)).body).toEqual({ rounds: 0, delaysMinutes: [] });

    const saved = await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 2, delaysMinutes: [30, 60] });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ rounds: 2, delaysMinutes: [30, 60] });
    expect((await api(agent, 'get', `/campaigns/${id}/retry-plan`)).body).toEqual({ rounds: 2, delaysMinutes: [30, 60] });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.retry_plan_changed', targetId: id } })).toBe(1);

    const tooLong = await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 3, delaysMinutes: [720, 720, 30] });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe('RETRY_WINDOW_EXCEEDED');
    expect((await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 2, delaysMinutes: [30] })).body.code).toBe('VALIDATION_FAILED');
    expect((await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 1, delaysMinutes: [45] })).body.code).toBe('VALIDATION_FAILED');
    expect((await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 4, delaysMinutes: [30, 30, 30, 30] })).status).toBe(422);
    expect((await api(agent, 'put', `/campaigns/${id}/retry-plan`, { rounds: 1, delaysMinutes: [30] })).status).toBe(403);

    await ctx.prisma.campaign.update({ where: { id }, data: { state: 'RUNNING', launchedAt: new Date() } });
    const late = await api(manager, 'put', `/campaigns/${id}/retry-plan`, { rounds: 1, delaysMinutes: [30] });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('re-sends only failures that may pass, round by round, and never sends a message twice', async () => {
    const { id, byName } = await seedCampaign({ rounds: 2, delays: [30, 60] }, [
      { name: 'T1', status: 'FAILED', failureCode: 131016 },
      { name: 'T2', status: 'FAILED', failureCode: 131016 },
      { name: 'T3', status: 'FAILED', failureCode: 131016 },
      { name: 'X', status: 'FAILED', failureCode: null, failureReason: 'Service Unavailable' },
      { name: 'U', status: 'FAILED', failureCode: 131026 },
      { name: 'H', status: 'FAILED', failureCode: 131049 },
      { name: 'N', status: 'FAILED', failureCode: null, failureReason: 'unknown_outcome_not_retried' },
      { name: 'S', status: 'DELIVERED' },
    ]);

    // The first pass is over: round 1 is scheduled after 30 minutes and the campaign waits for it.
    await progress();
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } })).state).toBe('RUNNING');
    const scheduled = await api(agent, 'get', `/campaigns/${id}/retry-rounds`);
    expect(scheduled.status).toBe(200);
    expect(scheduled.body).toEqual([
      { round: 1, status: 'SCHEDULED', dueAt: expect.any(String), startedAt: null, finishedAt: null, recipients: 4, recovered: 0, note: null },
    ]);
    const dueIn = new Date(scheduled.body[0].dueAt).getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(28 * 60_000);
    expect(dueIn).toBeLessThanOrEqual(30 * 60_000);
    expect(await ctx.app.get(QueueRegistry).get(QUEUES.MAINTENANCE).getJob(`retry-round-${id}-1`)).toBeTruthy();

    // Not due yet: the sweep leaves it alone. T3 opts out meanwhile.
    await rounds().sweep();
    expect((await ctx.prisma.campaignRetryRound.findFirstOrThrow({ where: { campaignId: id, round: 1 } })).status).toBe('SCHEDULED');
    await ctx.prisma.contact.update({ where: { id: byName.T3!.contactId }, data: { consentStatus: 'OPTED_OUT' } });

    // Round 1 starts (the sweep also starts rounds whose job was lost).
    await makeDue(id, 1);
    await rounds().sweep();
    const started = await ctx.prisma.message.findMany({ where: { campaignId: id, retryRound: 1 }, orderBy: { id: 'asc' } });
    expect(started.map((m) => m.status)).toEqual(['PENDING', 'PENDING', 'PENDING', 'PENDING']);
    expect(new Set(started.map((m) => m.id))).toEqual(new Set(['T1', 'T2', 'T3', 'X'].map((n) => byName[n]!.messageId)));

    const calls: SentCall[] = [];
    expect(await ctx.app.get(DispatcherProcessor).tick(id)).toMatchObject({ claimed: 4 });
    mockMetaSends(phoneNumberId, [byName.T1!.phone, byName.X!.phone], calls);
    const t2 = byName.T2!.phone.slice(1);
    nock(META_BASE)
      .post(`/${META_VERSION}/${phoneNumberId}/messages`, (body: Record<string, unknown>) => body.to === t2)
      .reply(500, { error: { message: 'Unknown error', type: 'OAuthException', code: 131000, fbtrace_id: 'T' } });
    const sender = ctx.app.get(SendProcessor);
    expect((await sender.process(byName.T1!.messageId, 1)).result).toBe('sent');
    expect((await sender.process(byName.X!.messageId, 1)).result).toBe('sent');
    expect((await sender.process(byName.T2!.messageId, 4)).result).toBe('failed');
    // A round checks consent again: T3 opted out and is skipped without calling Meta (FR-015).
    expect((await sender.process(byName.T3!.messageId, 1)).result).toBe('skipped');

    // Round 1 is done; round 2 takes what is left that may pass.
    await progress();
    const afterOne = await api(agent, 'get', `/campaigns/${id}/retry-rounds`);
    expect(afterOne.body).toMatchObject([
      { round: 1, status: 'DONE', recipients: 4, recovered: 2 },
      { round: 2, status: 'SCHEDULED', recipients: 1, recovered: 0 },
    ]);
    expect(afterOne.body[0].startedAt).toEqual(expect.any(String));
    expect(afterOne.body[0].finishedAt).toEqual(expect.any(String));

    await makeDue(id, 2);
    await rounds().sweep();
    expect(await ctx.app.get(DispatcherProcessor).tick(id)).toMatchObject({ claimed: 1 });
    mockMetaSends(phoneNumberId, [byName.T2!.phone], calls);
    expect((await sender.process(byName.T2!.messageId, 1)).result).toBe('sent');
    await progress();

    const done = await api(agent, 'get', `/campaigns/${id}/retry-rounds`);
    expect(done.body).toMatchObject([
      { round: 1, status: 'DONE', recipients: 4, recovered: 2 },
      { round: 2, status: 'DONE', recipients: 1, recovered: 1 },
    ]);
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } })).state).toBe('COMPLETED');
    expect(nock.pendingMocks()).toHaveLength(0);
    expect(calls.map((c) => c.to).sort()).toEqual([byName.T1!.phone, byName.X!.phone, byName.T2!.phone].map((p) => p.slice(1)).sort());

    // Never retried: invalid numbers, the per-person marketing limit, unknown outcomes and delivered messages.
    const untouched = await ctx.prisma.message.findMany({ where: { id: { in: ['U', 'H', 'N', 'S'].map((n) => byName[n]!.messageId) } } });
    expect(untouched.map((m) => [m.status, m.failureCode, m.retryRound]).sort()).toEqual(
      [
        ['FAILED', 131026, 0],
        ['FAILED', 131049, 0],
        ['FAILED', null, 0],
        ['DELIVERED', null, 0],
      ].sort(),
    );
    expect((await ctx.prisma.message.findUniqueOrThrow({ where: { id: byName.T3!.messageId } })).status).toBe('SKIPPED');

    const across = await api(agent, 'get', '/retry-rounds?status=DONE');
    expect(across.status).toBe(200);
    expect((across.body as Array<{ campaign: { id: string } }>).filter((r) => r.campaign.id === id)).toHaveLength(2);
  });

  it('holds rounds while the campaign is paused, and cancels one round on request', async () => {
    const { id } = await seedCampaign({ rounds: 2, delays: [30, 30] }, [
      { name: 'P1', status: 'FAILED', failureCode: 130429 },
      { name: 'P2', status: 'DELIVERED' },
    ]);
    await progress();
    expect((await api(manager, 'post', `/campaigns/${id}/pause`)).status).toBe(200);
    await makeDue(id, 1);
    await rounds().sweep();
    expect((await ctx.prisma.campaignRetryRound.findFirstOrThrow({ where: { campaignId: id, round: 1 } })).status).toBe('SCHEDULED');
    expect((await api(manager, 'post', `/campaigns/${id}/resume`)).status).toBe(200);

    expect((await api(agent, 'post', `/campaigns/${id}/retry-rounds/1/cancel`)).status).toBe(403);
    const cancelled = await api(manager, 'post', `/campaigns/${id}/retry-rounds/1/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ round: 1, status: 'CANCELLED' });
    const again = await api(manager, 'post', `/campaigns/${id}/retry-rounds/1/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ROUND_NOT_SCHEDULED');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.retry_round_cancelled', targetId: id } })).toBe(1);

    // No later round after a cancelled one: the campaign completes.
    await progress();
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id } })).state).toBe('COMPLETED');
    expect(await ctx.prisma.campaignRetryRound.count({ where: { campaignId: id } })).toBe(1);
  });

  it('cancels all rounds on request, and with the campaign', async () => {
    const first = await seedCampaign({ rounds: 1, delays: [60] }, [{ name: 'C1', status: 'FAILED', failureCode: 131000 }]);
    const second = await seedCampaign({ rounds: 1, delays: [60] }, [{ name: 'C2', status: 'FAILED', failureCode: 131000 }]);
    await progress();

    const all = await api(manager, 'post', `/campaigns/${first.id}/retry-rounds/cancel`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject([{ round: 1, status: 'CANCELLED' }]);

    expect((await api(manager, 'post', `/campaigns/${second.id}/cancel`)).status).toBe(200);
    const round = await ctx.prisma.campaignRetryRound.findFirstOrThrow({ where: { campaignId: second.id, round: 1 } });
    expect(round.status).toBe('CANCELLED');
    expect(round.note).toMatch(/campaign was cancelled/i);
  });

  it('skips a round when the template is paused or the 24 hours are over', async () => {
    const paused = await seedCampaign({ rounds: 1, delays: [30] }, [{ name: 'K1', status: 'FAILED', failureCode: 131016 }]);
    await progress();
    await ctx.prisma.template.update({ where: { id: templateId }, data: { status: 'PAUSED' } });
    await makeDue(paused.id, 1);
    await rounds().sweep();
    await ctx.prisma.template.update({ where: { id: templateId }, data: { status: 'APPROVED' } });
    const skipped = await ctx.prisma.campaignRetryRound.findFirstOrThrow({ where: { campaignId: paused.id, round: 1 } });
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.note).toMatch(/template/i);
    expect((await ctx.prisma.message.findUniqueOrThrow({ where: { id: paused.byName.K1!.messageId } })).status).toBe('FAILED');

    const late = await seedCampaign({ rounds: 1, delays: [30], launchedHoursAgo: 25 }, [{ name: 'L1', status: 'FAILED', failureCode: 131016 }]);
    await progress();
    const lateRound = await ctx.prisma.campaignRetryRound.findFirstOrThrow({ where: { campaignId: late.id, round: 1 } });
    expect(lateRound.status).toBe('SKIPPED');
    expect(lateRound.note).toMatch(/24 hours/);
    await progress();
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: late.id } })).state).toBe('COMPLETED');
    expect((await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: paused.id } })).state).toBe('COMPLETED');
  });
});
