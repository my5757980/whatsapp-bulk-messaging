import { Injectable } from '@nestjs/common';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';

export interface DispatchJobData {
  campaignId: string;
}

/**
 * Enqueues a dispatcher tick for a campaign (research R7). Job ids are bucketed per second, so
 * two chains for the same campaign (e.g. resume while a tick is pending) collapse into one.
 */
@Injectable()
export class DispatchScheduler {
  constructor(private readonly queues: QueueRegistry) {}

  async schedule(campaignId: string, delayMs = 0): Promise<void> {
    const second = Math.floor((Date.now() + delayMs) / 1000);
    await this.queues.get(QUEUES.DISPATCH).add('dispatch', { campaignId } satisfies DispatchJobData, {
      jobId: `dispatch-${campaignId}-${second}`,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }
}
