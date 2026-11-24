import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { REDIS_OPTIONS } from './queue.module.js';
import type { RedisConnectionOptions } from './redis-connection.js';

export type JobProcessor<T = unknown, R = unknown> = (job: Job<T>) => Promise<R>;

interface Definition {
  queue: string;
  processor: JobProcessor;
  options: Partial<WorkerOptions>;
}

/**
 * Worker-process registry: processors register in onModuleInit; BullMQ Workers start once the
 * application has bootstrapped and close gracefully on shutdown (ADR-0002 process model).
 */
@Injectable()
export class ProcessorRegistry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProcessorRegistry.name);
  private readonly definitions = new Map<string, Definition>();
  private readonly workers = new Map<string, Worker>();
  private readonly named = new Map<string, Map<string, JobProcessor>>();
  private started = false;

  constructor(@Inject(REDIS_OPTIONS) private readonly connection: RedisConnectionOptions) {}

  register<T, R>(queue: string, processor: JobProcessor<T, R>, options: Partial<WorkerOptions> = {}): void {
    const definition: Definition = { queue, processor: processor as JobProcessor, options };
    this.definitions.set(queue, definition);
    if (this.started) this.start(definition);
  }

  /**
   * Registers a handler for one job name on a queue shared by several job types (e.g. the
   * maintenance queue). The queue's single Worker routes jobs by `job.name`.
   */
  registerHandler<T, R>(queue: string, jobName: string, handler: JobProcessor<T, R>, options: Partial<WorkerOptions> = {}): void {
    let handlers = this.named.get(queue);
    // Worker options (for example concurrency) given by any handler apply to the queue's one Worker.
    const existing = this.definitions.get(queue);
    if (existing && Object.keys(options).length) existing.options = { ...existing.options, ...options };
    if (!handlers) {
      const routes = new Map<string, JobProcessor>();
      handlers = routes;
      this.named.set(queue, routes);
      this.register(queue, async (job: Job) => {
        const route = routes.get(job.name);
        if (!route) throw new Error(`No handler for job "${job.name}" on queue "${queue}"`);
        return route(job);
      }, options);
    }
    handlers.set(jobName, handler as JobProcessor);
  }

  isRunning(queue: string): boolean {
    return this.workers.has(queue);
  }

  async stop(queue: string): Promise<void> {
    const worker = this.workers.get(queue);
    this.definitions.delete(queue);
    this.workers.delete(queue);
    await worker?.close();
  }

  onApplicationBootstrap(): void {
    this.started = true;
    for (const definition of this.definitions.values()) this.start(definition);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    this.workers.clear();
  }

  private start(definition: Definition): void {
    if (this.workers.has(definition.queue)) return;
    const worker = new Worker(definition.queue, definition.processor, {
      connection: this.connection,
      concurrency: 1,
      ...definition.options,
    });
    worker.on('failed', (job, error) =>
      this.logger.warn({ queue: definition.queue, jobId: job?.id, attempts: job?.attemptsMade, err: error.message }, 'Job failed'),
    );
    worker.on('error', (error) => this.logger.error({ queue: definition.queue, err: error.message }, 'Worker error'));
    this.workers.set(definition.queue, worker);
  }
}

@Global()
@Module({ providers: [ProcessorRegistry], exports: [ProcessorRegistry] })
export class WorkerRuntimeModule {}
