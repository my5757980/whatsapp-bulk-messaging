import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { DispatchScheduler, type DispatchJobData } from '../campaigns/dispatch-scheduler.js';
import { planDispatch, sendJobId, type DispatchPlan } from './dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from './send-outcome.js';
import { SendQueueManager } from './send-queue.manager.js';

export type DispatchTick = Exclude<DispatchPlan, { action: 'claim' }> | { action: 'claim'; claimed: number };

const TICK_MS = 1000;
const FAILED_SEND_JOB_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * Campaign dispatcher (T098, research R7). Each tick checks the number (kill switch,
 * connection), claims the next `rate x 2` PENDING messages with FOR UPDATE SKIP LOCKED, marks
 * them QUEUED and adds one send job per message. It re-schedules itself about every second
 * while there is work, so the queue never holds more than ~2 s of messages.
 */
@Injectable()
export class DispatcherProcessor implements OnModuleInit {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly campaigns: CampaignsService,
    private readonly scheduler: DispatchScheduler,
    private readonly sendQueues: SendQueueManager,
  ) {}

  onModuleInit(): void {
    this.registry.register<DispatchJobData, void>(QUEUES.DISPATCH, (job: Job<DispatchJobData>) => this.run(job.data.campaignId), {
      concurrency: 5,
    });
  }

  async run(campaignId: string): Promise<void> {
    const tick = await this.tick(campaignId);
    if ((tick.action === 'claim' && tick.claimed > 0) || tick.action === 'wait') {
      await this.scheduler.schedule(campaignId, TICK_MS);
    }
  }

  async tick(campaignId: string): Promise<DispatchTick> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { state: true, number: { select: { id: true, sendingEnabled: true, connectionStatus: true, sendRatePerSecond: true } } },
    });
    if (!campaign?.number) return { action: 'stop' };
    const { number } = campaign;
    const queue = this.queues.sendQueue(number.id);
    if (campaign.state === 'RUNNING') await this.sendQueues.ensureWorker(number.id, number.sendRatePerSecond);

    const plan = planDispatch({
      state: campaign.state,
      sendingEnabled: number.sendingEnabled,
      connectionStatus: number.connectionStatus,
      ratePerSecond: number.sendRatePerSecond,
      waitingJobs: campaign.state === 'RUNNING' ? await queue.getJobCountByTypes('waiting', 'prioritized') : 0,
    });
    if (plan.action === 'pause') {
      await this.campaigns.autoPause(campaignId, plan.reason);
      return plan;
    }
    if (plan.action !== 'claim') return plan;

    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE messages
         SET status = 'QUEUED'::"MessageStatus", queued_at = now(), updated_at = now()
       WHERE id IN (
             SELECT id FROM messages
              WHERE campaign_id = ${campaignId}::uuid AND status = 'PENDING'::"MessageStatus"
              ORDER BY id
              LIMIT ${plan.batchSize}
                FOR UPDATE SKIP LOCKED)
   RETURNING id`;
    if (claimed.length) {
      await queue.addBulk(
        claimed.map(({ id }) => ({
          name: 'send',
          data: { messageId: id },
          opts: {
            jobId: sendJobId(id),
            attempts: MAX_SEND_ATTEMPTS,
            backoff: { type: 'custom' },
            removeOnComplete: true,
            removeOnFail: { age: FAILED_SEND_JOB_RETENTION_SECONDS },
          },
        })),
      );
    }
    return { action: 'claim', claimed: claimed.length };
  }
}
