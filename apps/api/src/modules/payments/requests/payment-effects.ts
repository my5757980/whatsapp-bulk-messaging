import { Inject, Injectable, Logger } from '@nestjs/common';
import { applyPaymentEvent, type ParsedStripeEvent, type PaymentEffect } from '@wbm/shared';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest, Prisma } from '../../../generated/prisma/client.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { StripeSession } from '../stripe.client.js';
import { chatSummary, eventPayment, stateOf } from './payment-views.js';

// What a payment change does (feature 008 US2, FR-011 – FR-013, FR-015, research R3, R5): one row
// lock per request, the shared rules decide, then the journey, outbound events, the chat item's
// summary, notifications, and the hooks other features register (flows, store orders, chat orders).

export type PaymentChange = PaymentEffect | 'EXPIRED' | 'CANCELLED';
/** Called after commit for every applied change; registered by flows (US3), stores (US3) and chat orders (US6). */
export type PaymentHook = (request: PaymentRequest, changes: PaymentChange[]) => Promise<void>;

export type ApplyOutcome = { result: 'APPLIED' | 'IGNORED' | 'PENDING'; requestId: string | null; reason?: string };

type Tx = Prisma.TransactionClient;

@Injectable()
export class PaymentEffects {
  private readonly logger = new Logger(PaymentEffects.name);
  private readonly hooks: PaymentHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: PlatformEvents,
    private readonly publisher: InboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  registerHook(hook: PaymentHook): void {
    this.hooks.push(hook);
  }

  linkBase(): string {
    return this.config.PUBLIC_LINK_BASE_URL ?? `${this.config.APP_URL.replace(/\/+$/, '')}/l`;
  }

  /** Applies a parsed Stripe event to its request: by our metadata, or by the payment intent for refunds. */
  async applyEvent(parsed: ParsedStripeEvent, livemode: boolean): Promise<ApplyOutcome> {
    let requestId = parsed.requestId;
    if (!requestId && parsed.paymentIntentId) {
      requestId = (await this.prisma.paymentRequest.findFirst({ where: { paymentIntentId: parsed.paymentIntentId }, select: { id: true } }))?.id ?? null;
    }
    if (!requestId) {
      // A refund that comes before its payment waits for the payment (R3).
      if (parsed.change?.kind === 'refunded' && !parsed.check && parsed.livemode === livemode) return { result: 'PENDING', requestId: null, reason: 'REFUND_BEFORE_PAYMENT' };
      return { result: 'IGNORED', requestId: null, reason: 'no payment request for this event' };
    }
    return this.applyTo(requestId, parsed, livemode);
  }

  /** A completed session read from Stripe (pay link, reconciler, expire answers) applied as a payment. */
  async applySessionPaid(requestId: string, session: StripeSession, livemode: boolean): Promise<ApplyOutcome> {
    const at = Math.floor(Date.now() / 1000);
    return this.applyTo(
      requestId,
      {
        id: `session:${session.id}`,
        type: 'checkout.session.completed',
        livemode,
        created: at,
        requestId,
        paymentIntentId: session.paymentIntentId,
        check: false,
        change: { kind: 'paid', at, amountMinor: session.amountTotal ?? 0, paymentIntentId: session.paymentIntentId, sessionId: session.id },
      },
      livemode,
    );
  }

  async applyTo(requestId: string, parsed: ParsedStripeEvent, livemode: boolean): Promise<ApplyOutcome> {
    const done = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const row = await tx.paymentRequest.findUnique({ where: { id: requestId } });
      if (!row) return { outcome: { result: 'IGNORED' as const, requestId: null, reason: 'unknown payment request' }, row: null, changes: [] as PaymentChange[] };
      const result = applyPaymentEvent(stateOf(row), parsed, livemode);
      if (result.outcome === 'ignored') return { outcome: { result: 'IGNORED' as const, requestId, reason: result.reason }, row: null, changes: [] };
      if (result.outcome === 'pending') return { outcome: { result: 'PENDING' as const, requestId, reason: result.reason }, row: null, changes: [] };
      const s = result.state;
      const now = new Date();
      const updated = await tx.paymentRequest.update({
        where: { id: requestId },
        data: {
          status: s.status,
          paidAt: s.paidAt === null ? null : new Date(s.paidAt),
          paidAmountMinor: s.paidAmountMinor === null ? null : BigInt(s.paidAmountMinor),
          paidLate: s.paidLate,
          paymentIntentId: s.paymentIntentId,
          failedAttempts: s.failedAttempts,
          lastFailureCode: s.lastFailureCode,
          refundedMinor: BigInt(s.refundedMinor),
          sessionId: s.sessionId,
          ...(s.sessionId === null ? { sessionUrl: null, sessionExpiresAt: null } : {}),
          ...(result.effects.includes('FAILED') ? { lastFailedAt: now } : {}),
          ...(result.effects.includes('REFUNDED') || result.effects.includes('PARTLY_REFUNDED') ? { refundedAt: now } : {}),
          // A paid request needs no reminders and its session needs no expiring.
          ...(result.effects.includes('PAID') ? { nextReminderAt: null, sessionExpirePending: false } : {}),
        },
      });
      await this.record(tx, updated, result.effects);
      return { outcome: { result: 'APPLIED' as const, requestId }, row: updated, changes: result.effects as PaymentChange[] };
    }, { timeout: 15_000 });
    if (done.row) await this.after(done.row, done.changes);
    return done.outcome;
  }

  /** The request was expired by the tick or cancelled by a member: journey, events, chat item, hooks. */
  async ended(tx: Tx, row: PaymentRequest, change: 'EXPIRED' | 'CANCELLED'): Promise<void> {
    await this.record(tx, row, [change]);
  }

  /** After commit for changes made elsewhere (tick, cancel). */
  async afterEnded(row: PaymentRequest, change: 'EXPIRED' | 'CANCELLED'): Promise<void> {
    await this.after(row, [change]);
  }

  /** The journey, outbound events and the chat item's summary, inside the change's transaction. */
  async record(tx: Tx, row: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    const journey: Array<'PAYMENT_PAID' | 'PAYMENT_REFUNDED' | 'PAYMENT_EXPIRED'> = [];
    if (changes.includes('PAID')) journey.push('PAYMENT_PAID');
    if (changes.includes('REFUNDED') || changes.includes('PARTLY_REFUNDED')) journey.push('PAYMENT_REFUNDED');
    if (changes.includes('EXPIRED')) journey.push('PAYMENT_EXPIRED');
    if (row.conversationId) {
      for (const type of journey) {
        await tx.conversationEvent.create({
          data: { conversationId: row.conversationId, type, actorType: 'SYSTEM', data: { paymentRequestId: row.id, amountMinor: Number(row.amountMinor), currency: row.currency, refundedMinor: Number(row.refundedMinor), paidLate: row.paidLate } },
        });
      }
    }
    const payment = eventPayment(row, this.linkBase());
    const type = changes.includes('PAID')
      ? 'payment.paid'
      : changes.includes('REFUNDED') || changes.includes('PARTLY_REFUNDED')
        ? 'payment.refunded'
        : changes.includes('FAILED')
          ? 'payment.failed'
          : changes.includes('EXPIRED')
            ? 'payment.expired'
            : changes.includes('CANCELLED')
              ? 'payment.cancelled'
              : null;
    if (type) await this.events.payment(tx, type, { payment, contactId: row.contactId });
    await this.writeSummary(tx, row);
  }

  /** Rewrites the payment summary kept in the request's chat item. */
  async writeSummary(db: Tx | PrismaService, row: PaymentRequest): Promise<void> {
    if (!row.chatItemId) return;
    const item = await db.chatMessage.findUnique({ where: { id: row.chatItemId }, select: { payload: true } });
    if (!item) return;
    const payload = { ...((item.payload ?? {}) as Record<string, unknown>), payment: chatSummary(row, this.linkBase()) };
    await db.chatMessage.update({ where: { id: row.chatItemId }, data: { payload: payload as Prisma.InputJsonValue } });
  }

  private async after(row: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    try {
      if (changes.includes('PAID') && row.createdById) {
        await this.notifications.notifyUsers([row.createdById], {
          type: 'PAYMENT_RECEIVED',
          title: 'Payment received',
          body: `${row.description} was paid.`,
          link: row.conversationId ? `/inbox?c=${row.conversationId}` : `/payments/${row.id}`,
        });
      }
      if (changes.includes('PAID_LATE')) {
        const staff = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'MANAGER'] }, status: 'ACTIVE' }, select: { id: true } });
        await this.notifications.notifyUsers(
          staff.map((u) => u.id),
          { type: 'PAYMENT_PAID_LATE', title: 'A payment arrived after its request ended', body: `${row.description} was paid after it expired or was cancelled; check whether to refund it in Stripe.`, link: `/payments/${row.id}` },
        );
      }
      if (row.chatItemId) await this.publisher.itemCreated(row.chatItemId);
    } catch (error) {
      this.logger.warn({ err: error, paymentRequestId: row.id }, 'Payment side effects failed');
    }
    for (const status of ['PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const) if (changes.includes(status)) this.metrics.paymentsTotal.inc({ status });
    for (const hook of this.hooks) {
      try {
        await hook(row, changes);
      } catch (error) {
        this.logger.warn({ err: error, paymentRequestId: row.id }, 'A payment hook failed');
      }
    }
  }
}
