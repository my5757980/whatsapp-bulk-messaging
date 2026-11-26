import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { PaymentGatewayService, type GatewayAccess } from '../gateway/payment-gateway.service.js';
import { PAYMENTS_RECONCILE_EVERY_MS, PAYMENTS_RECONCILE_JOB, PAYMENTS_RECONCILE_OVERLAP_SECONDS } from '../jobs.js';
import { PaymentEffects } from '../requests/payment-effects.js';
import { StripeApiError, StripeClient } from '../stripe.client.js';
import { PaymentEventsProcessor } from './payment-events.processor.js';
import { PaymentEventsService } from './payment-events.service.js';

// The reconciler (feature 008, research R3): every 15 minutes it reads Stripe's event list from its
// cursor (minus 10 minutes), stores what the webhook missed with source RECONCILE and applies it. A
// key without Events access falls back to reading the sessions of opened requests whose session ended.

const FALLBACK_AFTER_MS = 15 * 60_000;
const MAX_PAGES = 20;

@Injectable()
export class PaymentsReconcileProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsReconcileProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly stripe: StripeClient,
    private readonly events: PaymentEventsService,
    private readonly processor: PaymentEventsProcessor,
    private readonly effects: PaymentEffects,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.PAYMENTS, PAYMENTS_RECONCILE_JOB, async () => {
      await this.reconcile();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.PAYMENTS)
      .upsertJobScheduler(PAYMENTS_RECONCILE_JOB, { every: PAYMENTS_RECONCILE_EVERY_MS }, { name: PAYMENTS_RECONCILE_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  /** Returns how many missed events (or sessions) were applied. */
  async reconcile(now = new Date()): Promise<number> {
    const access = await this.gateway.access();
    if (!access || access.row.status !== 'CONNECTED') return 0;
    const cursor = access.row.eventsCursor ?? new Date(now.getTime() - 24 * 60 * 60_000);
    const createdAfter = Math.floor(cursor.getTime() / 1000) - PAYMENTS_RECONCILE_OVERLAP_SECONDS;
    let found = 0;
    let newest = Math.floor(cursor.getTime() / 1000);
    try {
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const list = await this.stripe.listEvents(access.key, { createdAfter, startingAfter });
        for (const event of list.data) {
          const e = event as { id?: string; created?: number };
          if (typeof e.created === 'number') newest = Math.max(newest, e.created);
          const rowId = await this.events.store(event, 'RECONCILE');
          if (rowId) {
            found += 1;
            await this.processor.process(rowId);
          }
        }
        if (!list.hasMore || list.data.length === 0) break;
        startingAfter = (list.data.at(-1) as { id?: string }).id;
      }
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 403) return this.fallback(access, now);
      this.logger.warn({ err: error }, 'Reading Stripe events failed');
      return found;
    }
    await this.prisma.paymentGateway.update({ where: { id: access.row.id }, data: { eventsCursor: new Date(newest * 1000) } });
    if (found) this.logger.warn({ found }, 'Stripe events were found that the webhook missed');
    return found;
  }

  /** Without Events access: read the sessions of opened waiting requests whose session ended. */
  private async fallback(access: GatewayAccess, now: Date): Promise<number> {
    const rows = await this.prisma.paymentRequest.findMany({
      where: { status: 'WAITING', sessionId: { not: null }, firstOpenedAt: { not: null }, sessionExpiresAt: { lt: new Date(now.getTime() - FALLBACK_AFTER_MS) } },
      take: 100,
    });
    let found = 0;
    for (const row of rows) {
      try {
        const session = await this.stripe.retrieveCheckoutSession(access.key, row.sessionId as string);
        if (session.status === 'complete' && session.paymentStatus === 'paid') {
          const outcome = await this.effects.applySessionPaid(row.id, session, access.livemode);
          if (outcome.result === 'APPLIED') found += 1;
        }
      } catch (error) {
        this.logger.warn({ err: error, paymentRequestId: row.id }, 'Reading a Stripe session failed');
      }
    }
    return found;
  }
}
