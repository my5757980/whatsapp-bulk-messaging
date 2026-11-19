import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES, sendQueueName } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { backoffDelay } from './send-outcome.js';
import { SendProcessor, type SendJobData } from './send.processor.js';

/** Enough parallel Graph calls to reach 80 msg/s at ~500 ms latency; the rate limit caps it. */
const SEND_CONCURRENCY = 50;

/**
 * One send queue + Worker per WhatsApp number (T097). The per-number rate is a BullMQ global
 * rate limit `{max: send_rate_per_second, duration: 1000}` stored in Redis, so rate changes made
 * by the API apply live without restarting workers.
 */
@Injectable()
export class SendQueueManager implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SendQueueManager.name);
  private readonly active = new Set<string>();

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly sender: SendProcessor,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'send-workers', () => this.ensureAll());
  }

  /** Starts workers for every usable number; runs at boot and every 30 s (API sends have no dispatcher). */
  async ensureAll(): Promise<void> {
    const numbers = await this.prisma.whatsAppNumber.findMany({
      where: { connectionStatus: { not: 'DISCONNECTED' } },
      select: { id: true, sendRatePerSecond: true },
    });
    for (const n of numbers) await this.ensureWorker(n.id, n.sendRatePerSecond);
  }

  /**
   * Starts workers for known numbers so leftover jobs drain after a restart. A database or Redis
   * hiccup at boot is not fatal: the 30 s sync and the dispatcher start workers later.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('send-workers', { every: 30_000 }, { name: 'send-workers', opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule the send-worker sync'));
    try {
      await this.ensureAll();
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'Could not start send workers at boot; they start on the next sync');
    }
  }

  async ensureWorker(numberId: string, ratePerSecond: number): Promise<void> {
    if (this.active.has(numberId)) return;
    this.active.add(numberId);
    try {
      await this.queues.sendQueue(numberId).setGlobalRateLimit(ratePerSecond, 1000);
      this.registry.register<SendJobData, unknown>(sendQueueName(numberId), (job) => this.run(job), {
        concurrency: SEND_CONCURRENCY,
        settings: { backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade) },
      });
    } catch (error) {
      this.active.delete(numberId); // retried on the next dispatcher tick
      throw error;
    }
    this.logger.log({ numberId, ratePerSecond }, 'Send worker started');
  }

  /** BullMQ adapter: transient failures throw (retry with backoff), permanent ones are final. */
  private async run(job: Job<SendJobData>) {
    const outcome = await this.sender.process(job.data.messageId, job.attemptsMade + 1);
    if (outcome.result === 'retry') throw new Error(outcome.reason);
    if (outcome.result === 'failed') throw new UnrecoverableError(outcome.reason);
    return outcome;
  }
}
