import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';

export const EXPIRED_SWEEP_JOB = 'expired-sweep';
const BATCH = 500;

/**
 * Feature 009 (research R8): Meta drops a template message that is not delivered within a time-to-live
 * it applies (codes and utility) and sends no error. Every few minutes this marks SENT messages whose
 * `expires_at` passed more than the grace ago as EXPIRED / NOT_DELIVERED_IN_TIME. A later delivered,
 * read or failed webhook still replaces the mark (status-update.ts).
 */
@Injectable()
export class ExpiredSweepProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ExpiredSweepProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly platformEvents: PlatformEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, EXPIRED_SWEEP_JOB, () => this.sweep());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler(EXPIRED_SWEEP_JOB, { every: this.config.EXPIRED_SWEEP_EVERY_SECONDS * 1000 }, { name: EXPIRED_SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  /** Marks the overdue messages and returns how many were marked. */
  async sweep(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.config.EXPIRED_SWEEP_GRACE_SECONDS * 1000);
    let total = 0;
    for (;;) {
      const due = await this.prisma.message.findMany({
        where: { status: 'SENT', expiresAt: { lt: before } },
        select: { id: true, origin: true, number: { select: { phoneNumberId: true } } },
        orderBy: { expiresAt: 'asc' },
        take: BATCH,
      });
      let marked = 0;
      for (const m of due) {
        try {
          const changed = await this.prisma.$transaction(async (tx) => {
            const { count } = await tx.message.updateMany({ where: { id: m.id, status: 'SENT' }, data: { status: 'EXPIRED', expiredReason: 'NOT_DELIVERED_IN_TIME' } });
            if (!count) return false;
            await tx.messageEvent.create({ data: { messageId: m.id, type: 'EXPIRED', occurredAt: now, payload: { reason: 'NOT_DELIVERED_IN_TIME' }, dedupeKey: `${m.id}:expired` } });
            // One-time codes also tell the company system (otp.status).
            if (m.origin === 'OTP') await this.platformEvents.otpStatus(tx, m.id);
            return true;
          });
          if (changed) {
            marked++;
            this.metrics.messagesTotal.inc({ status: 'EXPIRED', number: m.number.phoneNumberId });
          }
        } catch (error) {
          this.logger.warn({ messageId: m.id, err: (error as Error).message }, 'Could not mark a message as not delivered in time');
        }
      }
      total += marked;
      // A short batch is the last one; a batch where nothing changed would only repeat itself.
      if (due.length < BATCH || marked === 0) {
        if (total) this.logger.log({ marked: total }, 'Marked messages not delivered in time');
        return total;
      }
    }
  }
}
