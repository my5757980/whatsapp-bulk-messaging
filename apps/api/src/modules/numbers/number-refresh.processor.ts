import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { NumbersService } from './numbers.service.js';

const EVERY_MS = 6 * 3600 * 1000;

/**
 * Re-reads every connected number from Meta every 6 hours (T087). A credential error moves the
 * number CONNECTED -> ERROR and notifies admins (CREDENTIALS_FAILED); the dispatcher then
 * auto-pauses its running campaigns.
 */
@Injectable()
export class NumberRefreshProcessor implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly numbers: NumbersService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'number-refresh', () => this.numbers.refreshAll());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('number-refresh', { every: EVERY_MS }, { name: 'number-refresh', opts: { removeOnComplete: true, removeOnFail: 50 } });
  }
}
