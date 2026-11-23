import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { RetryRoundsService } from '../growth/retries/retry-rounds.service.js';
import { AMBIGUOUS_FAILURE_REASON } from '../meta/meta-error-classifier.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { sendJobId } from '../sending/dispatch-planner.js';
import { CampaignsService } from './campaigns.service.js';
import { DispatchScheduler } from './dispatch-scheduler.js';

const EVERY_MS = 5_000;
/** Delivery and read receipts keep arriving after completion; keep totals fresh for 3 days. */
const RECENT_MS = 3 * 24 * 3600 * 1000;
/** A message waits in QUEUED for at most ~8 min of retry backoff plus rate limiting. */
const STALE_QUEUED_MS = 15 * 60 * 1000;
/** SENDING this long means the worker died mid-call: the outcome is unknown, never resend. */
const STALE_SENDING_MS = 10 * 60 * 1000;

/**
 * Every 5 s (T104): recomputes cached totals for running/paused (and recently finished)
 * campaigns, completes a running campaign once nothing is PENDING, QUEUED or SENDING, and
 * recovers messages orphaned by a crash (Principle IV).
 */
@Injectable()
export class CampaignProgressProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignProgressProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly campaigns: CampaignsService,
    private readonly notifications: NotificationsService,
    private readonly scheduler: DispatchScheduler,
    private readonly metrics: MetricsService,
    private readonly retryRounds: RetryRoundsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'campaign-progress', () => this.refresh());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('campaign-progress', { every: EVERY_MS }, { name: 'campaign-progress', opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async refresh(): Promise<void> {
    const since = new Date(Date.now() - RECENT_MS);
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        OR: [
          { state: { in: ['RUNNING', 'PAUSED'] } },
          { state: 'COMPLETED', completedAt: { gte: since } },
          { state: 'CANCELLED', cancelledAt: { gte: since } },
        ],
      },
      select: { id: true, name: true, state: true, totals: true },
    });
    let running = 0;
    for (const campaign of campaigns) {
      if (campaign.state === 'RUNNING') {
        running++;
        await this.recoverStale(campaign.id);
      }
      const totals = await this.campaigns.computeTotals(campaign.id);
      if (JSON.stringify(totals) !== JSON.stringify(campaign.totals)) {
        await this.prisma.campaign.update({ where: { id: campaign.id }, data: { totals: totals as unknown as Prisma.InputJsonValue } });
      }
      if (campaign.state === 'RUNNING' && totals.pending + totals.queued === 0) {
        // A campaign with retries waits for its next round instead of completing (feature 005).
        if (await this.retryRounds.holdsCompletion(campaign.id)) continue;
        const { count } = await this.prisma.campaign.updateMany({
          where: { id: campaign.id, state: 'RUNNING' },
          data: { state: 'COMPLETED', completedAt: new Date() },
        });
        if (count) {
          running--;
          await this.notifications.notifyAdmins({
            type: 'CAMPAIGN_COMPLETED',
            title: 'Campaign completed',
            body: `"${campaign.name}" finished: ${totals.sent + totals.delivered + totals.read} sent, ${totals.failed} failed, ${totals.skipped} skipped.`,
            link: `/campaigns/${campaign.id}`,
          });
          this.logger.log({ campaignId: campaign.id }, 'Campaign completed');
        }
      }
    }
    this.metrics.campaignsRunning.set(running);
  }

  private async recoverStale(campaignId: string): Promise<void> {
    const now = Date.now();
    const unknown = await this.prisma.message.updateMany({
      where: { campaignId, status: 'SENDING', updatedAt: { lt: new Date(now - STALE_SENDING_MS) } },
      data: { status: 'FAILED', failureReason: AMBIGUOUS_FAILURE_REASON, failedAt: new Date() },
    });
    const stale = await this.prisma.message.findMany({
      where: { campaignId, status: 'QUEUED', queuedAt: { lt: new Date(now - STALE_QUEUED_MS) } },
      select: { id: true, numberId: true },
      take: 500,
    });
    const orphaned: string[] = [];
    for (const m of stale) {
      if (!(await this.queues.sendQueue(m.numberId).getJob(sendJobId(m.id)))) orphaned.push(m.id);
    }
    if (orphaned.length) {
      await this.prisma.message.updateMany({ where: { id: { in: orphaned }, status: 'QUEUED' }, data: { status: 'PENDING' } });
      await this.scheduler.schedule(campaignId);
    }
    if (unknown.count || orphaned.length) {
      this.logger.warn({ campaignId, unknownOutcome: unknown.count, requeued: orphaned.length }, 'Recovered stale messages');
    }
  }
}
