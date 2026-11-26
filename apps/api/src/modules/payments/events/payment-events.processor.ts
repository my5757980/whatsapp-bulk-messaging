import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { parseStripeEvent } from '@wbm/shared';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { NOTIFICATION_CHECK_TIMEOUT_JOB, PAYMENT_EVENT_JOB, type NotificationCheckTimeoutData, type PaymentEventJobData } from '../jobs.js';
import { PaymentEffects } from '../requests/payment-effects.js';

// Applies stored Stripe notifications (feature 008, research R3). Check-session events complete the
// notification check (US1); payment events change their request through PaymentEffects (US2). A refund
// that comes before its payment waits as PENDING and is applied once the payment is known.

type Result = 'APPLIED' | 'IGNORED' | 'PENDING' | 'FAILED' | 'DUPLICATE' | 'REJECTED' | 'MISSING';

@Injectable()
export class PaymentEventsProcessor implements OnModuleInit {
  private readonly logger = new Logger(PaymentEventsProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly effects: PaymentEffects,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.PAYMENTS, PAYMENT_EVENT_JOB, async (job: Job) => {
      await this.process((job.data as PaymentEventJobData).eventRowId);
    });
    this.registry.registerHandler(QUEUES.PAYMENTS, NOTIFICATION_CHECK_TIMEOUT_JOB, async (job: Job) => {
      await this.gateway.notificationCheckTimeout((job.data as NotificationCheckTimeoutData).sessionId);
    });
  }

  /** Applies one stored event once; returns its result. */
  async process(eventRowId: string): Promise<Result> {
    const row = await this.prisma.paymentEvent.findUnique({ where: { id: eventRowId } });
    if (!row) return 'MISSING';
    if (row.processedAt) return row.result as Result;
    const parsed = parseStripeEvent(row.body);
    if (row.source === 'WEBHOOK') await this.gateway.eventSeen();
    if (parsed.check) {
      if (parsed.change?.kind === 'sessionExpired') await this.gateway.notificationArrived(parsed.change.sessionId);
      return this.finish(row.id, 'IGNORED', null);
    }
    const access = await this.gateway.access();
    if (!access) return this.finish(row.id, 'IGNORED', 'Stripe is not connected');
    try {
      const outcome = await this.effects.applyEvent(parsed, access.livemode);
      const result = await this.finish(row.id, outcome.result, outcome.reason ?? null, outcome.requestId);
      // A payment makes its payment intent known: refunds that came first can be applied now.
      if (outcome.result === 'APPLIED' && parsed.change?.kind === 'paid' && parsed.paymentIntentId) await this.retryPendingRefunds(parsed.paymentIntentId);
      return result;
    } catch (error) {
      this.logger.warn({ err: error, eventRowId }, 'Applying a Stripe event failed');
      await this.prisma.paymentEvent.update({ where: { id: row.id }, data: { error: error instanceof Error ? error.message.slice(0, 500) : 'failed' } });
      throw error;
    }
  }

  private async retryPendingRefunds(paymentIntentId: string): Promise<void> {
    const pending = await this.prisma.paymentEvent.findMany({
      where: { result: 'PENDING', type: 'charge.refunded', body: { path: ['data', 'object', 'payment_intent'], equals: paymentIntentId } },
      select: { id: true },
      orderBy: { receivedAt: 'asc' },
    });
    for (const event of pending) await this.process(event.id);
  }

  private async finish(id: string, result: 'APPLIED' | 'IGNORED' | 'FAILED' | 'PENDING', error: string | null, paymentRequestId?: string | null): Promise<Result> {
    await this.prisma.paymentEvent.update({
      where: { id },
      data: {
        result,
        error,
        processedAt: result === 'PENDING' ? null : new Date(),
        ...(paymentRequestId ? { paymentRequestId } : {}),
      },
    });
    return result;
  }
}
