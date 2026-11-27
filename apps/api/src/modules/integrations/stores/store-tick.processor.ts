import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { CodService, STORE_ACTION_JOB, STORE_MARK_PAID_JOB, type StoreActionData } from './cod.service.js';
import { StoreCarts } from './store-carts.js';

// The store tick (feature 006 US5 and US6, research R10 - R11): every 30 seconds it handles the COD
// reminders and finals that are due (claimed with FOR UPDATE SKIP LOCKED, the 005 drip tick
// pattern); cart reminders join here in US6. It also runs the retried store actions of COD answers.

const TICK_JOB = 'store-tick';
const EVERY_MS = 30_000;

@Injectable()
export class StoreTickProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(StoreTickProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly cod: CodService,
    private readonly carts: StoreCarts,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.STORES, TICK_JOB, () => this.tick());
    this.registry.registerHandler(QUEUES.STORES, STORE_ACTION_JOB, async (job) => {
      await this.cod.runAction(job.data as StoreActionData);
    });
    this.registry.registerHandler(QUEUES.STORES, STORE_MARK_PAID_JOB, async (job) => {
      await this.cod.markPaid((job.data as { orderId: string }).orderId);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues.get(QUEUES.STORES).upsertJobScheduler(TICK_JOB, { every: EVERY_MS }, { name: TICK_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  async tick(now: Date = new Date()): Promise<void> {
    const handled = (await this.cod.tick(now)) + (await this.carts.remindDue(now));
    if (handled) this.logger.debug({ handled }, 'COD and cart reminders handled');
  }
}
