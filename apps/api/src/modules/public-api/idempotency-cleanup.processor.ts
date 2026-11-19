import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { IdempotencyService } from './idempotency.service.js';

/** Hourly removal of expired idempotency records (T188), on the maintenance queue. */
@Injectable()
export class IdempotencyCleanupProcessor implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'idempotency-cleanup', () => this.idempotency.cleanup());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('idempotency-cleanup', { every: 3600 * 1000 }, { name: 'idempotency-cleanup', opts: { removeOnComplete: true, removeOnFail: 20 } });
  }
}
