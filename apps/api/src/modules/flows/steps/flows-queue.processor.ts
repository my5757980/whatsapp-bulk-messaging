import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';

/** Timers and API calls are small; a few run at once per worker. */
const FLOWS_CONCURRENCY = 5;

/**
 * Worker for the `flows` queue (003 research R10, R11, T011): routes jobs by name. Timers (US2),
 * API calls (US5) and the expiry sweep (US2) register their handlers here as they arrive.
 */
@Injectable()
export class FlowsQueueProcessor implements OnModuleInit {
  private readonly handlers = new Map<string, (job: Job) => Promise<unknown>>();

  constructor(private readonly registry: ProcessorRegistry) {}

  onModuleInit(): void {
    this.registry.register<unknown, unknown>(QUEUES.FLOWS, (job) => this.run(job), { concurrency: FLOWS_CONCURRENCY });
  }

  /** Lets step processors handle a job name on the flows queue. */
  handle(name: string, handler: (job: Job) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }

  private async run(job: Job): Promise<unknown> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new UnrecoverableError(`No handler for "${job.name}" jobs on the flows queue`);
    return handler(job);
  }
}
