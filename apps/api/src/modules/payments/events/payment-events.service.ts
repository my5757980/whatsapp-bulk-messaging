import { createHmac } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { redactStripeEvent, verifyStripeSignature, type HmacHex } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PAYMENT_EVENT_JOB, type PaymentEventJobData } from '../jobs.js';

// Stripe notifications in (feature 008, FR-004, research R3): the signature is checked on the raw body
// first; a valid event is stored once by its id (card and customer details removed) and queued, and
// Stripe gets its 200 at once. Rejected requests are recorded and change nothing.

const hmacHex: HmacHex = (secret, content) => createHmac('sha256', secret).update(content).digest('hex');
const REJECTED_BODY_BYTES = 2048;

export type EventSource = 'WEBHOOK' | 'RECONCILE';

@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly queues: QueueRegistry,
  ) {}

  /** The webhook route: verify, store, queue. */
  async receive(raw: Buffer, header: string | undefined): Promise<{ received: true }> {
    const access = await this.gateway.access();
    const rawBody = raw.toString('utf8');
    const verified = verifyStripeSignature({ rawBody, header, secrets: access?.webhookSecrets ?? [], nowSeconds: Math.floor(Date.now() / 1000), hmacHex });
    if (!verified.ok) {
      await this.prisma.paymentEvent.create({
        data: {
          type: 'unknown',
          signatureValid: false,
          source: 'WEBHOOK',
          result: 'REJECTED',
          error: verified.reason,
          body: { signatureHeader: header ? 'present' : 'missing', reason: verified.reason, bodyStart: rawBody.slice(0, REJECTED_BODY_BYTES) },
          processedAt: new Date(),
        },
      });
      this.logger.warn({ reason: verified.reason }, 'Stripe notification rejected');
      throw new AppError(HttpStatus.BAD_REQUEST, 'SIGNATURE_INVALID', 'The Stripe signature is missing or does not match');
    }
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SIGNATURE_INVALID', 'The notification body is not JSON');
    }
    await this.store(event, 'WEBHOOK');
    return { received: true };
  }

  /** Stores an event once (by Stripe's id) and queues it; returns the row id, or null for a repeat. */
  async store(event: unknown, source: EventSource): Promise<string | null> {
    const e = (event ?? {}) as { id?: unknown; type?: unknown; livemode?: unknown; created?: unknown };
    const stripeEventId = typeof e.id === 'string' && e.id ? e.id : null;
    if (!stripeEventId) return null;
    try {
      const row = await this.prisma.paymentEvent.create({
        data: {
          stripeEventId,
          type: typeof e.type === 'string' ? e.type.slice(0, 80) : 'unknown',
          livemode: typeof e.livemode === 'boolean' ? e.livemode : null,
          signatureValid: true,
          source,
          result: 'PENDING',
          body: redactStripeEvent(event) as Prisma.InputJsonValue,
          stripeCreatedAt: typeof e.created === 'number' ? new Date(e.created * 1000) : null,
        },
      });
      const data: PaymentEventJobData = { eventRowId: row.id };
      await this.queues.get(QUEUES.PAYMENTS).add(PAYMENT_EVENT_JOB, data, { jobId: `pe-${row.id}`, attempts: 5, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: true, removeOnFail: 100 });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }
}
