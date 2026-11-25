import { Injectable, Logger } from '@nestjs/common';
import { isWithinRetryWindow, retryRoundDueAt } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { Prisma, type RetryRoundStatus } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { DispatchScheduler } from '../../campaigns/dispatch-scheduler.js';
import { AMBIGUOUS_FAILURE_REASON, RETRYABLE_CODES } from '../../meta/meta-error-classifier.js';

// Retry rounds of a campaign (feature 005 US3, FR-013 - FR-018, research R4, R5). When the first pass
// is final, round 1 is due after its wait; each later round is due its wait after the previous one
// finished. A round sets the campaign's FAILED messages whose failure may pass back to PENDING and
// hands them to the 001 dispatcher, so throttling, consent checks and status webhooks work as before.
// Only messages that were never delivered are re-sent, so nobody gets the message twice.

export interface RetryRoundJobData {
  campaignId: string;
  round: number;
}

export interface RetryRoundDto {
  round: number;
  status: RetryRoundStatus;
  dueAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recipients: number;
  recovered: number;
  note: string | null;
}

interface RoundRow {
  campaign_id: string;
  campaign_name: string;
  round: number;
  status: RetryRoundStatus;
  due_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  recipients: number;
  live_recipients: number;
  live_recovered: number;
  note: string | null;
}

const NOTES = {
  window: 'It would start more than 24 hours after the campaign started',
  template: 'The template is paused or disabled',
  number: 'The WhatsApp number is not connected or sending is turned off',
  campaignCancelled: 'The campaign was cancelled',
  notRunning: 'The campaign is no longer running',
  member: 'Cancelled by a member',
} as const;

export const retryRoundJobId = (campaignId: string, round: number) => `retry-round-${campaignId}-${round}`;

/**
 * Failure statuses arrive as webhooks a moment after a message is sent. Until this long after the last
 * send, "nothing to retry" may only mean the failures are not in yet, so the campaign keeps waiting.
 */
export const RETRY_SETTLE_MS = 60_000;

/** Messages (alias `m`) a round may send again: FAILED, not yet in this round, and a failure that may pass. */
export function retryableSql(round: number): Prisma.Sql {
  return Prisma.sql`m.status = 'FAILED' AND m.retry_round < ${round} AND (
    m.failure_code IN (${Prisma.join([...RETRYABLE_CODES])})
    OR (m.failure_code IS NULL AND COALESCE(m.failure_reason, '') <> ${AMBIGUOUS_FAILURE_REASON}))`;
}

@Injectable()
export class RetryRoundsService {
  private readonly logger = new Logger(RetryRoundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly dispatch: DispatchScheduler,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Called by the campaign progress worker when nothing of a running campaign is waiting to be sent.
   * Finishes the round that was running and schedules the next one. True while the campaign must
   * wait for a round instead of completing.
   */
  async holdsCompletion(campaignId: string): Promise<boolean> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { retryRounds: true, retryDelaysMin: true, launchedAt: true } });
    if (!campaign || campaign.retryRounds === 0) return false;
    const rounds = await this.prisma.campaignRetryRound.findMany({ where: { campaignId }, orderBy: { round: 'asc' } });
    for (const running of rounds.filter((r) => r.status === 'RUNNING')) await this.finish(campaignId, running.round);
    if (rounds.some((r) => r.status === 'SCHEDULED')) return true;

    const last = rounds.at(-1);
    if (last && (last.status === 'SKIPPED' || last.status === 'CANCELLED')) return false;
    const next = (last?.round ?? 0) + 1;
    if (next > campaign.retryRounds) return false;
    if (!(await this.retryableCount(campaignId, next))) return this.sentRecently(campaignId);

    const dueAt = retryRoundDueAt(new Date(), campaign.retryDelaysMin[next - 1] ?? 30);
    if (!campaign.launchedAt || !isWithinRetryWindow(campaign.launchedAt, dueAt)) {
      await this.create(campaignId, next, dueAt, 'SKIPPED', NOTES.window);
      return false;
    }
    await this.create(campaignId, next, dueAt, 'SCHEDULED', null);
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .add('campaign-retry-round', { campaignId, round: next } satisfies RetryRoundJobData, {
        jobId: retryRoundJobId(campaignId, next),
        delay: Math.max(0, dueAt.getTime() - Date.now()),
        removeOnComplete: true,
        removeOnFail: 50,
      });
    this.logger.log({ campaignId, round: next, dueAt }, 'Retry round scheduled');
    return true;
  }

  /** Starts a due round (the delayed job, or the sweep when the job was lost). Idempotent. */
  async start(campaignId: string, round: number): Promise<'started' | 'held' | 'skipped' | 'cancelled' | 'ignored'> {
    const row = await this.prisma.campaignRetryRound.findUnique({ where: { campaignId_round: { campaignId, round } } });
    if (!row || row.status !== 'SCHEDULED' || row.dueAt.getTime() > Date.now() + 1_000) return 'ignored';
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true, number: true } });
    if (!campaign || campaign.state === 'CANCELLED') {
      await this.close(campaignId, round, 'CANCELLED', NOTES.campaignCancelled);
      return 'cancelled';
    }
    // A paused campaign keeps its rounds; they start after it resumes, if still inside 24 hours.
    if (campaign.state === 'PAUSED') return 'held';
    const now = new Date();
    const skip =
      !campaign.launchedAt || !isWithinRetryWindow(campaign.launchedAt, now)
        ? NOTES.window
        : campaign.template?.status !== 'APPROVED'
          ? NOTES.template
          : !campaign.number || campaign.number.connectionStatus !== 'CONNECTED' || !campaign.number.sendingEnabled
            ? NOTES.number
            : campaign.state !== 'RUNNING'
              ? NOTES.notRunning
              : null;
    if (skip) {
      await this.close(campaignId, round, 'SKIPPED', skip);
      return 'skipped';
    }

    const recipients = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaignRetryRound.updateMany({ where: { campaignId, round, status: 'SCHEDULED' }, data: { status: 'RUNNING', startedAt: now } });
      if (!claimed.count) return null;
      const reset = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE messages m
           SET status = 'PENDING', retry_round = ${round}, failure_code = NULL, failure_reason = NULL, failed_at = NULL, queued_at = NULL, updated_at = now()
         WHERE m.campaign_id = ${campaignId}::uuid AND ${retryableSql(round)}
        RETURNING m.id`;
      if (reset.length) {
        await tx.messageEvent.createMany({
          data: reset.map((m) => ({ messageId: m.id, type: 'REQUEUED' as const, occurredAt: now, payload: { retryRound: round }, dedupeKey: `${m.id}:retry-round:${round}` })),
          skipDuplicates: true,
        });
      }
      await tx.campaignRetryRound.update({ where: { campaignId_round: { campaignId, round } }, data: { recipients: reset.length } });
      return reset.length;
    });
    if (recipients === null) return 'ignored';
    if (recipients) this.metrics.campaignRetryMessagesTotal.inc({ outcome: 'requeued' }, recipients);
    await this.dispatch.schedule(campaignId);
    this.logger.log({ campaignId, round, recipients }, 'Retry round started');
    return 'started';
  }

  /** Starts due rounds whose job was lost (runs with the schedule reconciler). */
  async sweep(): Promise<number> {
    const due = await this.prisma.campaignRetryRound.findMany({
      where: { status: 'SCHEDULED', dueAt: { lte: new Date() } },
      select: { campaignId: true, round: true },
      orderBy: { dueAt: 'asc' },
      take: 100,
    });
    let started = 0;
    for (const r of due) if ((await this.start(r.campaignId, r.round)) === 'started') started += 1;
    return started;
  }

  async list(campaignId: string): Promise<RetryRoundDto[]> {
    await this.assertCampaign(campaignId);
    return (await this.rows(Prisma.sql`r.campaign_id = ${campaignId}::uuid`, Prisma.sql`r.round ASC`)).map(toDto);
  }

  /** Rounds across campaigns (FR-016): by default the ones still to come or running. */
  async listAll(status?: RetryRoundStatus): Promise<Array<RetryRoundDto & { campaign: { id: string; name: string } }>> {
    const filter = status ? Prisma.sql`r.status = ${status}::"RetryRoundStatus"` : Prisma.sql`r.status IN ('SCHEDULED', 'RUNNING')`;
    const rows = await this.rows(filter, status ? Prisma.sql`r.due_at DESC` : Prisma.sql`r.due_at ASC`, 200);
    return rows.map((r) => ({ ...toDto(r), campaign: { id: r.campaign_id, name: r.campaign_name } }));
  }

  async cancelOne(campaignId: string, round: number, actor: AuditActor): Promise<RetryRoundDto> {
    await this.assertCampaign(campaignId);
    const { count } = await this.prisma.campaignRetryRound.updateMany({
      where: { campaignId, round, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', note: NOTES.member, finishedAt: new Date() },
    });
    if (!count) throw AppError.conflict('Only a scheduled round can be cancelled', 'ROUND_NOT_SCHEDULED');
    await this.removeJob(campaignId, round);
    await this.audit.record(actor, 'campaign.retry_round_cancelled', { type: 'campaign', id: campaignId }, { rounds: [round] });
    return (await this.list(campaignId)).find((r) => r.round === round)!;
  }

  async cancelAll(campaignId: string, actor: AuditActor): Promise<RetryRoundDto[]> {
    await this.assertCampaign(campaignId);
    const scheduled = await this.prisma.campaignRetryRound.findMany({ where: { campaignId, status: 'SCHEDULED' }, select: { round: true } });
    if (scheduled.length) {
      await this.prisma.campaignRetryRound.updateMany({
        where: { campaignId, status: 'SCHEDULED' },
        data: { status: 'CANCELLED', note: NOTES.member, finishedAt: new Date() },
      });
      for (const r of scheduled) await this.removeJob(campaignId, r.round);
      await this.audit.record(actor, 'campaign.retry_round_cancelled', { type: 'campaign', id: campaignId }, { rounds: scheduled.map((r) => r.round) });
    }
    return this.list(campaignId);
  }

  /** Cancelling a campaign cancels its rounds (FR-016). */
  async onCampaignCancelled(campaignId: string): Promise<void> {
    const open = await this.prisma.campaignRetryRound.findMany({ where: { campaignId, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { round: true } });
    if (!open.length) return;
    await this.prisma.campaignRetryRound.updateMany({
      where: { campaignId, status: { in: ['SCHEDULED', 'RUNNING'] } },
      data: { status: 'CANCELLED', note: NOTES.campaignCancelled, finishedAt: new Date() },
    });
    for (const r of open) await this.removeJob(campaignId, r.round);
  }

  private async finish(campaignId: string, round: number): Promise<void> {
    const [{ recovered } = { recovered: 0 }] = await this.prisma.$queryRaw<Array<{ recovered: number }>>`
      SELECT COUNT(*)::int AS recovered FROM messages
       WHERE campaign_id = ${campaignId}::uuid AND retry_round = ${round} AND status IN ('SENT', 'DELIVERED', 'READ')`;
    const done = await this.prisma.campaignRetryRound.updateMany({ where: { campaignId, round, status: 'RUNNING' }, data: { status: 'DONE', finishedAt: new Date(), recovered } });
    if (done.count && recovered) this.metrics.campaignRetryMessagesTotal.inc({ outcome: 'recovered' }, recovered);
    this.logger.log({ campaignId, round, recovered }, 'Retry round finished');
  }

  private async close(campaignId: string, round: number, status: 'SKIPPED' | 'CANCELLED', note: string): Promise<void> {
    await this.prisma.campaignRetryRound.updateMany({ where: { campaignId, round, status: 'SCHEDULED' }, data: { status, note, finishedAt: new Date() } });
    this.logger.log({ campaignId, round, status, note }, 'Retry round closed');
  }

  private async create(campaignId: string, round: number, dueAt: Date, status: 'SCHEDULED' | 'SKIPPED', note: string | null): Promise<void> {
    await this.prisma.campaignRetryRound.createMany({
      data: [{ campaignId, round, dueAt, status, note, ...(status === 'SKIPPED' ? { finishedAt: new Date() } : {}) }],
      skipDuplicates: true,
    });
  }

  /** True while a message of the campaign was sent less than RETRY_SETTLE_MS ago. */
  private async sentRecently(campaignId: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<Array<{ last: Date | null }>>`
      SELECT max(sent_at) AS last FROM messages WHERE campaign_id = ${campaignId}::uuid`;
    return row?.last ? Date.now() - row.last.getTime() < RETRY_SETTLE_MS : false;
  }

  private async retryableCount(campaignId: string, round: number): Promise<number> {
    const [{ count } = { count: 0 }] = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM messages m WHERE m.campaign_id = ${campaignId}::uuid AND ${retryableSql(round)}`;
    return count;
  }

  private async removeJob(campaignId: string, round: number): Promise<void> {
    try {
      await (await this.queues.get(QUEUES.MAINTENANCE).getJob(retryRoundJobId(campaignId, round)))?.remove();
    } catch (error) {
      // A job that already started cannot be removed; it finds the round cancelled and stops.
      this.logger.warn({ err: error, campaignId, round }, 'Could not remove the retry round job');
    }
  }

  private async assertCampaign(campaignId: string): Promise<void> {
    if (!(await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } }))) throw AppError.notFound('Campaign not found');
  }

  /** Rounds with live counts: recipients still waiting for a scheduled round, and messages a round recovered. */
  private rows(where: Prisma.Sql, orderBy: Prisma.Sql, limit = 10): Promise<RoundRow[]> {
    return this.prisma.$queryRaw<RoundRow[]>`
      SELECT r.campaign_id, c.name AS campaign_name, r.round, r.status, r.due_at, r.started_at, r.finished_at, r.recipients, r.note,
             (SELECT COUNT(*)::int FROM messages m WHERE m.campaign_id = r.campaign_id AND r.status = 'SCHEDULED' AND ${retryableSqlFor()}) AS live_recipients,
             (SELECT COUNT(*)::int FROM messages m WHERE m.campaign_id = r.campaign_id AND m.retry_round = r.round AND m.status IN ('SENT', 'DELIVERED', 'READ')) AS live_recovered
        FROM campaign_retry_rounds r
        JOIN campaigns c ON c.id = r.campaign_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ${limit}`;
  }
}

/** retryableSql with the round taken from the row (r.round) instead of a parameter. */
function retryableSqlFor(): Prisma.Sql {
  return Prisma.sql`m.status = 'FAILED' AND m.retry_round < r.round AND (
    m.failure_code IN (${Prisma.join([...RETRYABLE_CODES])})
    OR (m.failure_code IS NULL AND COALESCE(m.failure_reason, '') <> ${AMBIGUOUS_FAILURE_REASON}))`;
}

function toDto(r: RoundRow): RetryRoundDto {
  return {
    round: r.round,
    status: r.status,
    dueAt: r.due_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    recipients: r.status === 'SCHEDULED' ? r.live_recipients : r.recipients,
    recovered: r.live_recovered,
    note: r.note,
  };
}
