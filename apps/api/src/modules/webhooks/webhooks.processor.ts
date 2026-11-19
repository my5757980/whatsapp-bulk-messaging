import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import type { WebhookJobData } from './webhooks.controller.js';
import { WebhookRouter } from './webhook-router.js';

const WEBHOOK_CONCURRENCY = 10;

/**
 * Processes stored webhook events (T062). Idempotent: an already-processed event is skipped,
 * and handlers dedupe on their own keys. Failures are recorded on webhook_events.error and the
 * job is retried; exhausted jobs stay in the failed set (dead-letter view, Principle IV).
 */
@Injectable()
export class WebhooksProcessor implements OnModuleInit {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly router: WebhookRouter,
  ) {}

  onModuleInit(): void {
    // Parallel processing keeps status lag low at 80 msg/s (3 webhooks per message); the status
    // handler serialises updates per message row.
    this.registry.register<WebhookJobData, void>(QUEUES.WEBHOOKS, (job: Job<WebhookJobData>) => this.process(job.data.webhookEventId), {
      concurrency: WEBHOOK_CONCURRENCY,
    });
  }

  async process(webhookEventId: string): Promise<void> {
    const event = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event || !event.signatureValid || event.processedAt) return;
    try {
      await this.router.route(event.payload, { webhookEventId });
      await this.prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processedAt: new Date(), error: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { error: message.slice(0, 2000) } });
      throw error;
    }
  }
}
