import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';

/** Turns mostly wait for the AI service, so several run at once per worker (research R5). */
const AI_CONCURRENCY = 10;

/**
 * Worker for the `ai` queue (feature 004, T018): routes jobs by name. Customer turns (US1), the
 * AI conversation expiry sweep (US2) and team assistant requests (US9) register their handlers here.
 */
@Injectable()
export class AiQueueProcessor implements OnModuleInit {
  private readonly handlers = new Map<string, (job: Job) => Promise<unknown>>();

  constructor(private readonly registry: ProcessorRegistry) {}

  onModuleInit(): void {
    this.registry.register<unknown, unknown>(QUEUES.AI, (job) => this.run(job), { concurrency: AI_CONCURRENCY });
  }

  /** Lets a processor handle a job name on the ai queue. */
  handle(name: string, handler: (job: Job) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }

  private async run(job: Job): Promise<unknown> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new UnrecoverableError(`No handler for "${job.name}" jobs on the ai queue`);
    return handler(job);
  }
}
