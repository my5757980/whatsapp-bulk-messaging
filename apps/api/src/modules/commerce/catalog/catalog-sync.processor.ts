import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { CatalogFill } from './catalog-fill.js';
import { CATALOG_BATCH_STATUS_JOB, CATALOG_EVERY_MS, CATALOG_FILL_JOB, CATALOG_SYNC_JOB, CatalogService } from './catalog.service.js';

// The `catalog` queue (feature 008 US5, research R8, R9): the product copy every hour and on demand,
// the store fill every hour when it is on, and the batch status checks of a fill.

@Injectable()
export class CatalogSyncProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly catalog: CatalogService,
    private readonly fill: CatalogFill,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.CATALOG, CATALOG_SYNC_JOB, async () => {
      const { products } = await this.catalog.copy();
      this.logger.log({ products }, 'Catalog copied');
    });
    this.registry.registerHandler(QUEUES.CATALOG, CATALOG_FILL_JOB, async () => {
      await this.fill.run();
    });
    this.registry.registerHandler(QUEUES.CATALOG, CATALOG_BATCH_STATUS_JOB, async (job) => {
      await this.fill.checkBatch((job.data as { handle: string }).handle);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QUEUES.CATALOG);
    await queue.upsertJobScheduler(`${CATALOG_SYNC_JOB}-hourly`, { every: CATALOG_EVERY_MS }, { name: CATALOG_SYNC_JOB, data: { reason: 'hourly' }, opts: { removeOnComplete: true, removeOnFail: 20 } });
    await queue.upsertJobScheduler(`${CATALOG_FILL_JOB}-hourly`, { every: CATALOG_EVERY_MS }, { name: CATALOG_FILL_JOB, data: { reason: 'hourly' }, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }
}
