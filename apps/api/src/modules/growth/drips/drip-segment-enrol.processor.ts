import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { BulkActionsService } from '../../contacts/bulk-actions.service.js';
import { EnrolmentsService } from './enrolments.service.js';

/**
 * Feature 010 (research R2, FR-005): enrols the current members of a segment in a drip as a background bulk
 * action, with the 005 rules and counts (opted out, already in, not found).
 */
@Injectable()
export class DripSegmentEnrolProcessor implements OnModuleInit {
  private readonly logger = new Logger(DripSegmentEnrolProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly bulk: BulkActionsService,
    private readonly enrolments: EnrolmentsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.BULK, 'drip-enrol', (job: Job<{ actionId: string }>) => this.run(job.data.actionId), { concurrency: 1 });
  }

  async run(actionId: string): Promise<void> {
    const action = await this.bulk.start(actionId, ['DRIP_ENROL']);
    if (!action) return;
    const { dripId } = (action.params ?? {}) as { dripId?: string };
    const selection = action.selection as unknown as { segmentId?: string };
    try {
      if (!dripId || !selection.segmentId) throw new Error('The drip or the segment is missing');
      await this.bulk.progress(actionId, { total: await this.bulk.total({ segmentId: selection.segmentId }) });
      const result = await this.enrolments.enrol(dripId, { segmentId: selection.segmentId }, { userId: action.createdById ?? null });
      const processed = result.enrolled + result.skippedOptedOut + result.skippedAlreadyIn + result.skippedNotFound;
      await this.bulk.progress(actionId, { processed, changed: result.enrolled });
      await this.bulk.finish(actionId, { result: { ...result } });
    } catch (error) {
      this.logger.error({ actionId, err: (error as Error).message }, 'Segment drip enrolment failed');
      await this.bulk.finish(actionId, { error: (error as Error).message });
    }
  }
}
