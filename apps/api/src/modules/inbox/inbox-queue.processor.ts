import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { InboundMediaProcessor } from './inbound/inbound-media.processor.js';
import { INBOX_QUEUE, type InboundMediaJobData, type InboxNotifyJobData, type ReadReceiptJobData } from './inbox-queue.js';
import { InboxNotifyProcessor } from './notifications/inbox-notify.processor.js';
import { ReadReceiptProcessor } from './messages/read-receipt.processor.js';

/** Media downloads hold whole files in memory, so only a few run at once per worker. */
const INBOX_CONCURRENCY = 3;

/** Worker for the `inbox` queue: routes jobs by name (research R4, R9, R11). */
@Injectable()
export class InboxQueueProcessor implements OnModuleInit {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly media: InboundMediaProcessor,
    private readonly receipts: ReadReceiptProcessor,
    private readonly notify: InboxNotifyProcessor,
  ) {}

  onModuleInit(): void {
    this.registry.register<unknown, unknown>(INBOX_QUEUE, (job) => this.run(job), { concurrency: INBOX_CONCURRENCY });
  }

  private async run(job: Job) {
    switch (job.name) {
      case 'media': {
        const outcome = await this.media.process(job.data as InboundMediaJobData, job.attemptsMade + 1);
        if (outcome === 'retry') throw new Error('Media download failed; retrying');
        return outcome;
      }
      case 'mark-read':
        return this.receipts.process((job.data as ReadReceiptJobData).conversationId);
      case 'notify':
        return this.notify.process(job.data as InboxNotifyJobData);
      default:
        throw new UnrecoverableError(`No handler for "${job.name}" jobs on the inbox queue`);
    }
  }
}
