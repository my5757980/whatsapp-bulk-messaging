import { Injectable, Logger } from '@nestjs/common';
import { sessionExpiresAt } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import { PaymentGatewayService, type GatewayAccess } from '../gateway/payment-gateway.service.js';
import { StripeApiError, StripeClient, type StripeSession } from '../stripe.client.js';
import { PaymentEffects } from './payment-effects.js';
import { payUrl } from './payment-views.js';

// Stripe Checkout Sessions behind our pay link (feature 008, research R2): the first session is made
// eagerly for single requests; on open, the open session is reused or, while the request waits, a new
// one is made under a row lock after the old one is expired, so only one session can be paid at a time.

export type OpenResult = { url: string } | { page: 'PAID' | 'EXPIRED' | 'CANCELLED' | 'PAUSED' | 'PREVIEW' };

/** A session closer than this to its end is replaced rather than handed out. */
const SESSION_MARGIN_MS = 60_000;

@Injectable()
export class PaymentSessions {
  private readonly logger = new Logger(PaymentSessions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly gateway: PaymentGatewayService,
    private readonly effects: PaymentEffects,
  ) {}

  /** Makes session number `sequence` for a request; Stripe errors become API errors (422 / 502). */
  async create(
    access: GatewayAccess,
    input: { requestId: string; code: string; amountMinor: number; currency: string; description: string; reference: string | null; expiresAt: Date; sequence: number },
  ): Promise<{ id: string; url: string; expiresAt: Date }> {
    try {
      const session = await this.stripe.createCheckoutSession(access.key, {
        requestId: input.requestId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        description: input.description,
        reference: input.reference,
        expiresAt: sessionExpiresAt(Date.now(), input.expiresAt.getTime()),
        successUrl: `${payUrl(this.effects.linkBase(), input.code)}?paid=1`,
        idempotencyKey: `wbm-pr-${input.requestId}-s${input.sequence}`,
      });
      if (!session.url) throw new StripeApiError(502, 'api_error', null, null, null, 'Stripe returned no payment page address');
      return { id: session.id, url: session.url, expiresAt: new Date(session.expiresAt * 1000) };
    } catch (error) {
      throw this.gateway.gatewayError(error);
    }
  }

  /** On open (R2): the open session's address, a new session while the request waits, or the page to show. */
  async ensureOpen(requestId: string, now = new Date(), opts: { create?: boolean } = {}): Promise<OpenResult> {
    const found: { session: StripeSession | null; livemode: boolean } = { session: null, livemode: false };
    const result = await this.prisma.$transaction(
      async (tx): Promise<OpenResult> => {
        await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
        const row = await tx.paymentRequest.findUniqueOrThrow({ where: { id: requestId } });
        const ended = this.endedPage(row, now);
        if (ended) return ended;
        if (row.sessionId && row.sessionUrl && row.sessionExpiresAt && row.sessionExpiresAt.getTime() > now.getTime() + SESSION_MARGIN_MS) return { url: row.sessionUrl };
        if (opts.create === false) return { page: 'PREVIEW' };
        const access = await this.gateway.access();
        if (!access || access.row.status !== 'CONNECTED') return { page: 'PAUSED' };
        found.livemode = access.livemode;
        if (row.sessionId) {
          const closed = await this.expireAtStripe(access, row);
          if (closed === 'paid') {
            found.session = await this.stripe.retrieveCheckoutSession(access.key, row.sessionId).catch(() => null);
            return { page: 'PAID' };
          }
          if (closed === 'failed') return { page: 'PAUSED' };
        }
        const sequence = row.sessionsCreated + 1;
        let session: { id: string; url: string; expiresAt: Date };
        try {
          session = await this.create(access, {
            requestId: row.id,
            code: row.code,
            amountMinor: Number(row.amountMinor),
            currency: row.currency,
            description: row.description,
            reference: row.reference,
            expiresAt: row.expiresAt,
            sequence,
          });
        } catch (error) {
          this.logger.warn({ err: error, paymentRequestId: row.id }, 'Could not make a new Stripe session');
          return { page: 'PAUSED' };
        }
        await tx.paymentRequest.update({ where: { id: row.id }, data: { sessionId: session.id, sessionUrl: session.url, sessionExpiresAt: session.expiresAt, sessionsCreated: sequence } });
        return { url: session.url };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    if (found.session) await this.effects.applySessionPaid(requestId, found.session, found.livemode);
    return result;
  }

  /**
   * Expires the request's current session at Stripe (cancel, expiry, before a new one). 'done' when
   * nothing payable is left, 'paid' when Stripe says it was completed, 'failed' when Stripe could not
   * be reached (the caller retries later).
   */
  async expireAtStripe(access: GatewayAccess, row: PaymentRequest): Promise<'done' | 'paid' | 'failed'> {
    if (!row.sessionId) return 'done';
    try {
      await this.stripe.expireCheckoutSession(access.key, row.sessionId, `wbm-pr-${row.id}-x${row.sessionsCreated}`);
      return 'done';
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 400) {
        // No longer open: expired already, or completed.
        try {
          const session = await this.stripe.retrieveCheckoutSession(access.key, row.sessionId);
          return session.status === 'complete' && session.paymentStatus === 'paid' ? 'paid' : 'done';
        } catch {
          return 'failed';
        }
      }
      if (error instanceof StripeApiError && error.status === 404) return 'done';
      this.logger.warn({ err: error, paymentRequestId: row.id }, 'Could not expire the Stripe session');
      return 'failed';
    }
  }

  /** Expires a request's session after a cancel or the tick; applies a payment Stripe reports instead. */
  async closeSession(row: PaymentRequest): Promise<boolean> {
    const access = await this.gateway.access();
    if (!access) return false;
    const closed = await this.expireAtStripe(access, row);
    if (closed === 'failed') return false;
    if (closed === 'paid' && row.sessionId) {
      const session = await this.stripe.retrieveCheckoutSession(access.key, row.sessionId).catch(() => null);
      if (session) await this.effects.applySessionPaid(row.id, session, access.livemode);
    }
    return true;
  }

  private endedPage(row: PaymentRequest, now: Date): OpenResult | null {
    if (row.status === 'PAID' || row.status === 'REFUNDED') return { page: 'PAID' };
    if (row.status === 'CANCELLED') return { page: 'CANCELLED' };
    if (row.status === 'EXPIRED' || row.expiresAt.getTime() <= now.getTime()) return { page: 'EXPIRED' };
    return null;
  }
}
