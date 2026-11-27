import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PAYMENT_LIMITS } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import { PAYMENTS_TICK_EVERY_MS, PAYMENTS_TICK_JOB } from '../jobs.js';
import { PaymentEffects } from '../requests/payment-effects.js';
import { PaymentSessions } from '../requests/payment-sessions.js';
import { PaymentReminders } from './payment-reminders.js';

// The payments tick (feature 008, research R6): every 60 seconds, from due times in Postgres, waiting
// requests past their expiry become EXPIRED and their sessions are expired at Stripe (retried by later
// ticks, at most 10 times), and due reminders are sent (US4, payment-reminders.ts).

const BATCH = 500;

@Injectable()
export class PaymentsTickProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsTickProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly effects: PaymentEffects,
    private readonly sessions: PaymentSessions,
    private readonly reminders: PaymentReminders,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.PAYMENTS, PAYMENTS_TICK_JOB, async () => {
      await this.runTick();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.PAYMENTS)
      .upsertJobScheduler(PAYMENTS_TICK_JOB, { every: PAYMENTS_TICK_EVERY_MS }, { name: PAYMENTS_TICK_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  async runTick(now = new Date()): Promise<{ expired: number; sessionsClosed: number; reminders: number }> {
    const expired = await this.expireDue(now);
    const sessionsClosed = await this.closePendingSessions();
    const reminders = await this.reminders.sendDue(now);
    return { expired, sessionsClosed, reminders };
  }

  /** Waiting requests past their expiry become EXPIRED (FR-012). */
  private async expireDue(now: Date): Promise<number> {
    const rows = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM payment_requests
         WHERE status = 'WAITING' AND expires_at <= ${now}
         ORDER BY expires_at
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
      const done: PaymentRequest[] = [];
      for (const { id } of due) {
        const current = await tx.paymentRequest.findUniqueOrThrow({ where: { id } });
        const updated = await tx.paymentRequest.update({
          where: { id },
          data: { status: 'EXPIRED', expiredAt: now, nextReminderAt: null, sessionExpirePending: Boolean(current.sessionId) },
        });
        await this.effects.ended(tx, updated, 'EXPIRED');
        done.push(updated);
      }
      return done;
    }, { timeout: 30_000 });
    for (const row of rows) await this.effects.afterEnded(row, 'EXPIRED');
    return rows.length;
  }

  /** Expires sessions at Stripe that our expiry or a cancel left open (best effort, retried). */
  private async closePendingSessions(): Promise<number> {
    const rows = await this.prisma.paymentRequest.findMany({
      where: { sessionExpirePending: true, sessionExpireAttempts: { lt: PAYMENT_LIMITS.sessionExpireAttemptsMax } },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    let closed = 0;
    for (const row of rows) {
      const ok = await this.sessions.closeSession(row);
      await this.prisma.paymentRequest.update({
        where: { id: row.id },
        data: ok ? { sessionExpirePending: false } : { sessionExpireAttempts: { increment: 1 } },
      });
      if (ok) closed += 1;
      else this.logger.warn({ paymentRequestId: row.id, attempts: row.sessionExpireAttempts + 1 }, 'The Stripe session could not be expired yet');
    }
    return closed;
  }
}
