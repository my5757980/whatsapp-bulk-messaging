import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';

/** PDF parsing is the heaviest work in the app, so knowledge jobs run one at a time (research R11). */
const KNOWLEDGE_CONCURRENCY = 1;

/**
 * Worker for the `ai-knowledge` queue (feature 004, T018): routes jobs by name. Reading files and
 * websites (US1) and the weekly refresh sweep register their handlers here.
 */
@Injectable()
export class KnowledgeQueueProcessor implements OnModuleInit {
  private readonly handlers = new Map<string, (job: Job) => Promise<unknown>>();

  constructor(private readonly registry: ProcessorRegistry) {}

  onModuleInit(): void {
    this.registry.register<unknown, unknown>(QUEUES.AI_KNOWLEDGE, (job) => this.run(job), { concurrency: KNOWLEDGE_CONCURRENCY });
  }

  handle(name: string, handler: (job: Job) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }

  private async run(job: Job): Promise<unknown> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new UnrecoverableError(`No handler for "${job.name}" jobs on the ai-knowledge queue`);
    return handler(job);
  }
}
