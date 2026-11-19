import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { ScheduleService, type StartJobData } from './schedule.service.js';

const EVERY_MS = 30_000;

/**
 * Starts scheduled campaigns (T148): the delayed `campaign-start` job usually does it on time;
 * this repeatable reconciler (every 30 s) starts any due SCHEDULED campaign whose job was lost.
 * Starting is idempotent, so a late job or a second pass changes nothing.
 */
@Injectable()
export class ScheduleReconcilerProcessor implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly schedules: ScheduleService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler<StartJobData, boolean>(QUEUES.MAINTENANCE, 'campaign-start', (job: Job<StartJobData>) =>
      this.schedules.startScheduled(job.data.campaignId),
    );
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'schedule-reconciler', () => this.reconcile());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('schedule-reconciler', { every: EVERY_MS }, { name: 'schedule-reconciler', opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  reconcile(): Promise<number> {
    return this.schedules.startDue();
  }
}
