import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { RetryRoundsService, type RetryRoundJobData } from './retry-rounds.service.js';

/**
 * Runs a campaign's retry round when its delayed job fires (feature 005, research R5). Rounds whose
 * job was lost are started by the schedule reconciler's sweep, so a round never waits for long.
 */
@Injectable()
export class RetryRoundProcessor implements OnModuleInit {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly rounds: RetryRoundsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler<RetryRoundJobData, string>(QUEUES.MAINTENANCE, 'campaign-retry-round', (job: Job<RetryRoundJobData>) =>
      this.rounds.start(job.data.campaignId, job.data.round),
    );
  }
}
