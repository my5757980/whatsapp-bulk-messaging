import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MAX_IN_FLIGHT_PER_ENDPOINT,
  buildEvent,
  eventPayload,
  isEventType,
  nextAttemptAt,
  shouldAutoPause,
  signatureHeader,
  type Hmac,
} from '@wbm/shared';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { SafeHttpError, safeRequest, type SafeHttpFailure } from '../../../common/http/safe-http.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry, REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { OutboundEvents, deliverJobId } from './outbound-events.js';

// Webhook deliveries (feature 006, research R2, FR-005 - FR-008), shared by the worker (one job per
// attempt, webhook-delivery.processor.ts) and the HTTP app (the test button, resume and resend).
// The delivery row is the source of truth (attempts, next attempt, the last answer). At most five
// deliveries per endpoint are in flight (a Redis counter), so a slow endpoint holds only its own
// deliveries. A success after failures makes the endpoint's waiting deliveries due at once, and 24
// hours without success with 10 failed attempts pauses the endpoint and tells admins.

export type DeliveryOutcome = 'delivered' | 'retry' | 'failed' | 'deferred' | 'paused' | 'skipped';
export type DeliveryError = 'TIMEOUT' | 'BLOCKED_ADDRESS' | 'NETWORK' | 'REDIRECT' | 'HTTP_4XX' | 'HTTP_5XX';

const hmac: Hmac = (key, content) => createHmac('sha256', key).update(content).digest('base64');
const ANSWER_BYTES = 4096;
/** A deferred delivery (endpoint busy) tries again after about this long. */
const DEFER_MS = 1_000;

const ERROR_OF: Record<SafeHttpFailure, DeliveryError> = {
  BAD_URL: 'NETWORK',
  NOT_HTTPS: 'BLOCKED_ADDRESS',
  BLOCKED_ADDRESS: 'BLOCKED_ADDRESS',
  REDIRECT: 'REDIRECT',
  TIMEOUT: 'TIMEOUT',
  TOO_LARGE: 'NETWORK',
  NETWORK: 'NETWORK',
};

type DeliveryWithParts = Prisma.WebhookDeliveryGetPayload<{ include: { endpoint: true; event: true } }>;

export interface AttemptResult {
  ok: boolean;
  statusCode: number | null;
  error: DeliveryError | null;
  durationMs: number;
}

@Injectable()
export class WebhookDeliveries {
  private readonly logger = new Logger(WebhookDeliveries.name);
  /** The endpoint answer limit (10 s); tests make it shorter. */
  timeoutMs = 10_000;

  constructor(
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly notifications: NotificationsService,
    private readonly events: OutboundEvents,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  /** Deliveries of one endpoint in flight now (for tests and the health of the counter). */
  async inFlight(endpointId: string): Promise<number> {
    return Number((await this.redis.get(inFlightKey(endpointId))) ?? 0);
  }

  /**
   * One attempt of one delivery. With `attempt`, a job for an attempt that already happened is
   * stale and does nothing.
   */
  async deliver(deliveryId: string, options: { attempt?: number } = {}): Promise<DeliveryOutcome> {
    const lock = `wbm:webhooks:lock:${deliveryId}`;
    if ((await this.redis.set(lock, '1', 'PX', 30_000, 'NX')) !== 'OK') return 'skipped';
    try {
      const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true, event: true } });
      if (!delivery || delivery.status !== 'PENDING') return 'skipped';
      if (options.attempt !== undefined && options.attempt !== delivery.attempts) return 'skipped';
      if (delivery.endpoint.status !== 'ACTIVE') {
        // Paused endpoints keep their waiting deliveries without a due time; resume makes them due.
        if (delivery.nextAttemptAt) await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { nextAttemptAt: null } });
        return 'paused';
      }
      const counter = inFlightKey(delivery.endpointId);
      const inFlight = await this.redis.incr(counter);
      await this.redis.pexpire(counter, 60_000);
      if (inFlight > MAX_IN_FLIGHT_PER_ENDPOINT) {
        await this.redis.decr(counter);
        await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { nextAttemptAt: new Date(Date.now() + DEFER_MS) } });
        this.events.enqueue(deliveryId, delivery.attempts, DEFER_MS + Math.floor(Math.random() * 500), `d${Date.now()}`);
        return 'deferred';
      }
      try {
        const result = await this.send(delivery);
        const outcome = result.ok ? await this.succeeded(delivery, result) : await this.failed(delivery, result);
        this.metrics.webhookDeliveriesTotal.inc({ result: outcome });
        if (outcome === 'delivered') this.metrics.webhookDeliverySeconds.observe(Math.max(0, Date.now() - delivery.event.occurredAt.getTime()) / 1000);
        return outcome;
      } finally {
        await this.redis.decr(counter);
      }
    } finally {
      await this.redis.del(lock);
    }
  }

  /**
   * The endpoint's test button: one attempt now, no retries; the result shows on the screen and in
   * the delivery log.
   */
  async attemptOnce(deliveryId: string): Promise<AttemptResult> {
    const delivery = await this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { endpoint: true, event: true } });
    const result = await this.send(delivery);
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: result.ok ? 'DELIVERED' : 'FAILED',
        attempts: { increment: 1 },
        nextAttemptAt: null,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        lastDurationMs: result.durationMs,
        deliveredAt: result.ok ? new Date() : null,
      },
    });
    return result;
  }

  /** Builds, signs and sends the request. Never throws for endpoint problems. */
  private async send(delivery: DeliveryWithParts): Promise<AttemptResult> {
    const { endpoint, event } = delivery;
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const webhookId = `evt_${event.id}`;
    const type = isEventType(event.type) ? event.type : 'test.ping';
    const data = buildEvent(type, event.data as Record<string, unknown>, endpoint.includeContent);
    const body = JSON.stringify(eventPayload(webhookId, type, event.occurredAt, data));
    const secrets = [this.cipher.decrypt(endpoint.secretEncrypted)];
    if (endpoint.previousSecretEncrypted && endpoint.previousSecretUntil && endpoint.previousSecretUntil > now) secrets.push(this.cipher.decrypt(endpoint.previousSecretEncrypted));
    const started = Date.now();
    try {
      const res = await safeRequest({
        method: 'POST',
        url: endpoint.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'wbm-webhooks/1',
          'webhook-id': webhookId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signatureHeader(hmac, secrets, webhookId, timestamp, body),
        },
        body,
        timeoutMs: this.timeoutMs,
        maxBytes: ANSWER_BYTES,
        onLimit: 'truncate',
        allowLocal: this.config.OUTBOUND_ALLOW_LOCAL,
      });
      const ok = res.status >= 200 && res.status < 300;
      return { ok, statusCode: res.status, error: ok ? null : res.status >= 400 && res.status < 500 ? 'HTTP_4XX' : 'HTTP_5XX', durationMs: res.durationMs };
    } catch (error) {
      return { ok: false, statusCode: null, error: error instanceof SafeHttpError ? ERROR_OF[error.reason] : 'NETWORK', durationMs: Date.now() - started };
    }
  }

  private async succeeded(delivery: DeliveryWithParts, result: AttemptResult): Promise<DeliveryOutcome> {
    const now = new Date();
    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', attempts: { increment: 1 }, nextAttemptAt: null, lastStatusCode: result.statusCode, lastError: null, lastDurationMs: result.durationMs, deliveredAt: now },
    });
    const hadFailures = delivery.endpoint.consecutiveFailures > 0 || delivery.endpoint.failingSince !== null;
    await this.prisma.webhookEndpoint.update({ where: { id: delivery.endpointId }, data: { lastSuccessAt: now, consecutiveFailures: 0, failingSince: null } });
    // The endpoint is back: its waiting deliveries go now instead of after their waits (SC-001).
    if (hadFailures) await this.dueNow(delivery.endpointId);
    return 'delivered';
  }

  private async failed(delivery: DeliveryWithParts, result: AttemptResult): Promise<DeliveryOutcome> {
    const now = new Date();
    const attempts = delivery.attempts + 1;
    const next = nextAttemptAt(attempts, now);
    const endpoint = delivery.endpoint;
    const failingSince = endpoint.failingSince ?? now;
    const consecutiveFailures = endpoint.consecutiveFailures + 1;
    const pause = endpoint.status === 'ACTIVE' && shouldAutoPause({ failingSince, consecutiveFailures, now });
    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: next ? 'PENDING' : 'FAILED',
        attempts,
        nextAttemptAt: next && !pause ? next : null,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        lastDurationMs: result.durationMs,
      },
    });
    await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { lastFailureAt: now, failingSince, consecutiveFailures, ...(pause ? { status: 'FAILING' as const } : {}) },
    });
    if (pause) await this.pausedForFailures(endpoint.id, endpoint.name);
    else if (next) this.events.enqueue(delivery.id, attempts, next.getTime() - now.getTime());
    return next ? 'retry' : 'failed';
  }

  /** Makes an endpoint's waiting deliveries due at once and queues them. */
  async dueNow(endpointId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; attempts: number }>>`
      UPDATE webhook_deliveries SET next_attempt_at = now(), updated_at = now()
       WHERE endpoint_id = ${endpointId}::uuid AND status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at > now())
      RETURNING id, attempts::int AS attempts`;
    const queue = this.queues.get(QUEUES.WEBHOOKS_OUT);
    for (const row of rows) {
      const job = await queue.getJob(deliverJobId(row.id, row.attempts));
      if (job && (await job.isDelayed())) await job.promote().catch(() => undefined);
      else this.events.enqueue(row.id, row.attempts, 0, `n${Date.now()}`);
    }
    return rows.length;
  }

  private async pausedForFailures(endpointId: string, name: string): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({ where: { endpointId, status: 'PENDING' }, data: { nextAttemptAt: null } });
    this.logger.warn({ endpointId }, 'Webhook endpoint paused after 24 hours of failures');
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
    await this.notifications.notifyUsers(
      admins.map((a) => a.id),
      {
        type: 'WEBHOOK_ENDPOINT_FAILING',
        title: 'Webhook endpoint paused',
        body: `"${name}" had no successful delivery for 24 hours and was paused. Its events are kept for 3 days: fix the receiver, then resume it.`,
        link: `/settings/webhooks/${endpointId}`,
      },
    );
  }
}

function inFlightKey(endpointId: string): string {
  return `wbm:webhooks:inflight:${endpointId}`;
}
