import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { BulkActionsService, type Selection } from './bulk-actions.service.js';
import { ContactsService } from './contacts.service.js';

/**
 * Feature 010 (research R3, FR-008, FR-009): adds or removes tags for a bulk action, batch by batch, saving
 * progress after each batch. One worker with concurrency 1 runs bulk actions in order.
 */
@Injectable()
export class BulkTagsProcessor implements OnModuleInit {
  private readonly logger = new Logger(BulkTagsProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly bulk: BulkActionsService,
    private readonly contacts: ContactsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.BULK, 'tags', (job: Job<{ actionId: string }>) => this.run(job.data.actionId), { concurrency: 1 });
  }

  async run(actionId: string): Promise<void> {
    const action = await this.bulk.start(actionId);
    if (!action || (action.kind !== 'TAG_ADD' && action.kind !== 'TAG_REMOVE')) return;
    const selection = action.selection as unknown as Selection;
    const tagIds = ((action.params ?? {}) as { tagIds?: string[] }).tagIds ?? [];
    const add = action.kind === 'TAG_ADD';
    let processed = 0;
    let changed = 0;
    try {
      await this.bulk.progress(actionId, { total: await this.bulk.total(selection) });
      for await (const ids of this.bulk.batches(selection)) {
        changed += await this.contacts.tagMany(ids, tagIds, add);
        processed += ids.length;
        await this.bulk.progress(actionId, { processed, changed });
      }
      await this.bulk.finish(actionId, { result: { processed, changed } });
      const by = 'contactIds' in selection ? 'contacts' : 'segmentId' in selection ? 'segment' : 'filter';
      await this.audit.record({ userId: action.createdById ?? null }, 'contacts.bulk_tagged', { type: 'bulk_action', id: actionId }, { kind: action.kind, tagIds, by, processed, changed });
    } catch (error) {
      this.logger.error({ actionId, err: (error as Error).message }, 'Bulk tag action failed');
      await this.bulk.finish(actionId, { error: (error as Error).message });
    }
  }
}
