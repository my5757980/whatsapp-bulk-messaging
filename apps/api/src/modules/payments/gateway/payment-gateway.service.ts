import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  STRIPE_KEY_PATTERN,
  STRIPE_WEBHOOK_SECRET_PATTERN,
  gatewayChecks,
  gatewayReady,
  keyInfo,
  minimumMinor,
  type GatewayCheck,
  type GatewayFacts,
} from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { PaymentGateway, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { NOTIFICATION_CHECK_TIMEOUT_JOB, NOTIFICATION_CHECK_TIMEOUT_MS, type NotificationCheckTimeoutData } from '../jobs.js';
import { StripeApiError, StripeClient } from '../stripe.client.js';

// The Stripe connection (feature 008 US1, FR-001 – FR-005, research R1, R4,
// contracts/commerce-api.openapi.yaml tag payments-gateway): one row, the key and signing secrets
// encrypted with the 001 TokenCipher and never returned, the checks with a fix each, automatic or
// manual notification address, and the notification check (a check session made and expired at once
// whose expired event must arrive signed within two minutes).

export const SaveGatewaySchema = z
  .object({
    secretKey: z.string().trim().regex(STRIPE_KEY_PATTERN, 'paste a Stripe secret or restricted key (rk_… or sk_…)'),
    registerEndpoint: z.boolean(),
    webhookSecret: z.string().trim().regex(STRIPE_WEBHOOK_SECRET_PATTERN, 'paste the signing secret (whsec_…)').optional(),
  })
  .strict()
  .refine((v) => v.registerEndpoint || Boolean(v.webhookSecret), { message: 'paste the signing secret, or let the platform register the address', path: ['webhookSecret'] });
export type SaveGatewayInput = z.infer<typeof SaveGatewaySchema>;

/** Signing secrets stay valid this long after they are replaced (Stripe signs with both during a roll). */
const SECRET_ROLL_MS = 24 * 60 * 60_000;

export interface NotificationCheckState {
  status: 'NOT_RUN' | 'PENDING' | 'PASSED' | 'FAILED';
  sessionId?: string | null;
  startedAt?: string | null;
  passedAt?: string | null;
  fix?: string | null;
}

/** What other payments services get: the row with the decrypted key and secrets. */
export interface GatewayAccess {
  row: PaymentGateway;
  key: string;
  /** The current signing secret, plus the previous one during a roll. */
  webhookSecrets: string[];
  livemode: boolean;
  currency: string;
}

@Injectable()
export class PaymentGatewayService {
  private readonly logger = new Logger(PaymentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly queues: QueueRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The address Stripe posts notifications to. */
  webhookUrl(): string {
    return `${this.config.APP_URL.replace(/\/+$/, '')}/api/payments/stripe/webhook`;
  }

  async get() {
    const row = await this.prisma.paymentGateway.findFirst();
    return row ? this.dto(row) : null;
  }

  async save(input: SaveGatewayInput, actor: AuditActor) {
    const key = input.secretKey.trim();
    const info = keyInfo(key);
    const existing = await this.prisma.paymentGateway.findFirst();

    const account = await this.accountFacts(key);
    const currency = (account.ok ? account.currency : null) ?? existing?.currency ?? 'aed';
    const checkout = await this.checkoutFacts(key, currency);

    let webhook: GatewayFacts['webhook'];
    let webhookSecret: string | null = null;
    let webhookEndpointId: string | null = null;
    if (input.registerEndpoint) {
      if (existing?.webhookEndpointId) await this.deleteEndpointQuietly(this.cipher.decrypt(existing.secretKeyEnc), existing.webhookEndpointId);
      try {
        const endpoint = await this.stripe.createWebhookEndpoint(key, { url: this.webhookUrl(), idempotencyKey: `wbm-endpoint-${randomUUID()}` });
        webhookEndpointId = endpoint.id;
        webhookSecret = endpoint.secret;
        webhook = { mode: 'auto', ok: true };
      } catch (error) {
        webhook = { mode: 'auto', ok: false, ...this.failure(error) };
      }
    } else {
      webhookSecret = input.webhookSecret ?? null;
      webhook = { mode: 'manual', secretGiven: Boolean(webhookSecret) };
    }

    const checks = gatewayChecks({ key, account, checkout, webhook });
    const ready = gatewayReady(checks);
    const previousSecret = existing?.webhookSecretEnc && webhookSecret ? existing.webhookSecretEnc : null;
    const data = {
      provider: 'STRIPE' as const,
      mode: info.mode ?? 'TEST',
      accountId: account.ok ? (account.id ?? null) : (existing?.accountId ?? null),
      accountName: account.ok ? account.name : (existing?.accountName ?? null),
      country: account.ok ? account.country : (existing?.country ?? null),
      currency,
      secretKeyEnc: this.cipher.encrypt(key),
      keyKind: info.kind ?? 'secret',
      webhookSecretEnc: webhookSecret ? this.cipher.encrypt(webhookSecret) : null,
      previousWebhookSecretEnc: previousSecret,
      previousSecretUntil: previousSecret ? new Date(Date.now() + SECRET_ROLL_MS) : null,
      webhookEndpointId,
      status: ready ? ('CONNECTED' as const) : ('ERROR' as const),
      checks: checks as unknown as Prisma.InputJsonValue,
      notificationCheck: { status: 'NOT_RUN' } as Prisma.InputJsonValue,
      lastCheckedAt: new Date(),
      connectedById: actor.userId ?? null,
    };
    const row = existing ? await this.prisma.paymentGateway.update({ where: { id: existing.id }, data }) : await this.prisma.paymentGateway.create({ data });
    await this.audit.record(actor, existing ? 'payments.gateway_keys_replaced' : 'payments.gateway_connected', { type: 'payment_gateway', id: row.id }, {
      mode: row.mode,
      accountId: row.accountId,
      keyKind: row.keyKind,
      endpointRegistered: Boolean(row.webhookEndpointId),
      ready,
    });
    return this.dto(row);
  }

  async recheck(actor: AuditActor) {
    const row = await this.mustGet();
    const key = this.cipher.decrypt(row.secretKeyEnc);
    const account = await this.accountFacts(key);
    const checkout = await this.checkoutFacts(key, row.currency);
    const webhook: GatewayFacts['webhook'] = row.webhookEndpointId ? { mode: 'auto', ok: true } : { mode: 'manual', secretGiven: Boolean(row.webhookSecretEnc) };
    const checks = gatewayChecks({ key, account, checkout, webhook });
    const ready = gatewayReady(checks);
    const updated = await this.prisma.paymentGateway.update({
      where: { id: row.id },
      data: {
        checks: checks as unknown as Prisma.InputJsonValue,
        status: ready ? 'CONNECTED' : 'ERROR',
        lastCheckedAt: new Date(),
        ...(account.ok ? { accountName: account.name, country: account.country, accountId: account.id ?? row.accountId } : {}),
      },
    });
    if (!ready) await this.alert(checks.filter((c) => c.result === 'FAILED').map((c) => c.detail).join(' '));
    this.logger.log({ ready, by: actor.userId }, 'Stripe connection checks run');
    return this.dto(updated);
  }

  /** Starts the notification check: a check session made and expired at once (R4). */
  async startNotificationCheck(actor: AuditActor) {
    const row = await this.mustGet();
    if (!row.webhookSecretEnc) throw AppError.conflict('Save the signing secret or register the notification address first', 'GATEWAY_NOT_READY');
    const key = this.cipher.decrypt(row.secretKeyEnc);
    let sessionId: string;
    try {
      const session = await this.stripe.createCheckoutSession(key, {
        requestId: null,
        check: true,
        amountMinor: minimumMinor(row.currency),
        currency: row.currency,
        description: 'Connection check',
        expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
        successUrl: this.config.APP_URL,
        idempotencyKey: `wbm-check-${randomUUID()}`,
      });
      sessionId = session.id;
      await this.stripe.expireCheckoutSession(key, session.id, `wbm-check-x-${session.id}`);
    } catch (error) {
      throw this.gatewayError(error);
    }
    const state: NotificationCheckState = { status: 'PENDING', sessionId, startedAt: new Date().toISOString(), passedAt: null, fix: null };
    const updated = await this.prisma.paymentGateway.update({ where: { id: row.id }, data: { notificationCheck: state as unknown as Prisma.InputJsonValue } });
    const data: NotificationCheckTimeoutData = { sessionId };
    await this.queues.get(QUEUES.PAYMENTS).add(NOTIFICATION_CHECK_TIMEOUT_JOB, data, { delay: NOTIFICATION_CHECK_TIMEOUT_MS, jobId: `nc-${sessionId}`, removeOnComplete: true, removeOnFail: 20 });
    this.logger.log({ by: actor.userId }, 'Stripe notification check started');
    return this.dto(updated);
  }

  /** The check session's event arrived signed: the check passes (called by the event processor). */
  async notificationArrived(sessionId: string): Promise<boolean> {
    const row = await this.prisma.paymentGateway.findFirst();
    const state = (row?.notificationCheck ?? {}) as unknown as NotificationCheckState;
    if (!row || state.status !== 'PENDING' || state.sessionId !== sessionId) return false;
    const passed: NotificationCheckState = { ...state, status: 'PASSED', passedAt: new Date().toISOString(), fix: null };
    await this.prisma.paymentGateway.update({ where: { id: row.id }, data: { notificationCheck: passed as unknown as Prisma.InputJsonValue } });
    return true;
  }

  /** Two minutes passed without the event: the check fails with the fix (R4). */
  async notificationCheckTimeout(sessionId: string): Promise<boolean> {
    const row = await this.prisma.paymentGateway.findFirst();
    const state = (row?.notificationCheck ?? {}) as unknown as NotificationCheckState;
    if (!row || state.status !== 'PENDING' || state.sessionId !== sessionId) return false;
    const fix = row.webhookEndpointId
      ? `No notification arrived. Check that the Stripe endpoint for the address ${this.webhookUrl()} is enabled and that this server can be reached from the internet.`
      : `No notification arrived. In Stripe, add ${this.webhookUrl()} with the six events listed here, and paste that endpoint's signing secret.`;
    const failed: NotificationCheckState = { ...state, status: 'FAILED', fix };
    await this.prisma.paymentGateway.update({ where: { id: row.id }, data: { notificationCheck: failed as unknown as Prisma.InputJsonValue } });
    return true;
  }

  async disconnect(actor: AuditActor): Promise<void> {
    const row = await this.mustGet();
    if (row.webhookEndpointId) await this.deleteEndpointQuietly(this.cipher.decrypt(row.secretKeyEnc), row.webhookEndpointId);
    await this.prisma.paymentGateway.delete({ where: { id: row.id } });
    await this.audit.record(actor, 'payments.gateway_disconnected', { type: 'payment_gateway', id: row.id }, { accountId: row.accountId, mode: row.mode });
  }

  /** The connection with its decrypted key and secrets, or null when nothing is connected. */
  async access(): Promise<GatewayAccess | null> {
    const row = await this.prisma.paymentGateway.findFirst();
    if (!row) return null;
    const secrets = [row.webhookSecretEnc ? this.cipher.decrypt(row.webhookSecretEnc) : null];
    if (row.previousWebhookSecretEnc && row.previousSecretUntil && row.previousSecretUntil > new Date()) secrets.push(this.cipher.decrypt(row.previousWebhookSecretEnc));
    return { row, key: this.cipher.decrypt(row.secretKeyEnc), webhookSecrets: secrets.filter((s): s is string => Boolean(s)), livemode: row.mode === 'LIVE', currency: row.currency };
  }

  /** The connection when payments may be made (FR-002), or 409 GATEWAY_NOT_READY. */
  async requireReady(): Promise<GatewayAccess> {
    const access = await this.access();
    if (!access) throw AppError.conflict('Connect Stripe first (Payments > Gateway)', 'GATEWAY_NOT_READY');
    if (access.row.status !== 'CONNECTED') throw AppError.conflict('The Stripe connection has a problem; run its checks and fix it first', 'GATEWAY_NOT_READY');
    return access;
  }

  /** Stripe refused the stored key (401): the connection needs attention. */
  async markError(reason: string): Promise<void> {
    const row = await this.prisma.paymentGateway.findFirst();
    if (!row || row.status === 'ERROR') return;
    await this.prisma.paymentGateway.update({ where: { id: row.id }, data: { status: 'ERROR' } });
    await this.alert(reason);
  }

  async eventSeen(at = new Date()): Promise<void> {
    await this.prisma.paymentGateway.updateMany({ data: { lastEventAt: at } });
  }

  /** Stripe errors as API errors: refused requests 422 GATEWAY_REFUSED, outages 502 GATEWAY_UNAVAILABLE. */
  gatewayError(error: unknown): AppError {
    if (error instanceof StripeApiError && error.status === 401) {
      void this.markError('Stripe no longer accepts the saved key.');
      return AppError.conflict('Stripe no longer accepts the saved key; replace it on Payments > Gateway', 'GATEWAY_NOT_READY');
    }
    if (error instanceof StripeApiError && error.status < 500 && error.status !== 429) {
      return AppError.validation(error.message, error.param ? [{ field: error.param, issue: error.message }] : undefined, 'GATEWAY_REFUSED');
    }
    return new AppError(HttpStatus.BAD_GATEWAY, 'GATEWAY_UNAVAILABLE', 'Stripe could not be reached; nothing was sent. Try again in a moment.');
  }

  private async mustGet(): Promise<PaymentGateway> {
    const row = await this.prisma.paymentGateway.findFirst();
    if (!row) throw AppError.notFound('Stripe is not connected');
    return row;
  }

  private async accountFacts(key: string): Promise<GatewayFacts['account'] & { id?: string }> {
    try {
      const a = await this.stripe.account(key);
      return { ok: true, id: a.id, name: a.name, country: a.country, currency: a.defaultCurrency, chargesEnabled: a.chargesEnabled, detailsSubmitted: a.detailsSubmitted, currentlyDue: a.currentlyDue };
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 401) {
        throw AppError.validation('Stripe does not accept this key', [{ field: 'secretKey', issue: error.message }], 'KEY_INVALID');
      }
      return { ok: false, ...this.failure(error) };
    }
  }

  private async checkoutFacts(key: string, currency: string): Promise<GatewayFacts['checkout']> {
    try {
      const session = await this.stripe.createCheckoutSession(key, {
        requestId: null,
        check: true,
        amountMinor: minimumMinor(currency),
        currency,
        description: 'Connection check',
        expiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
        successUrl: this.config.APP_URL,
        idempotencyKey: `wbm-check-${randomUUID()}`,
      });
      await this.stripe.expireCheckoutSession(key, session.id, `wbm-check-x-${session.id}`).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 401) {
        throw AppError.validation('Stripe does not accept this key', [{ field: 'secretKey', issue: error.message }], 'KEY_INVALID');
      }
      return { ok: false, ...this.failure(error) };
    }
  }

  private failure(error: unknown): { status: number; message: string } {
    if (error instanceof StripeApiError) return { status: error.status, message: error.message };
    return { status: 0, message: error instanceof Error ? error.message : 'Stripe could not be reached' };
  }

  private async deleteEndpointQuietly(key: string, endpointId: string): Promise<void> {
    try {
      await this.stripe.deleteWebhookEndpoint(key, endpointId);
    } catch (error) {
      this.logger.warn({ endpointId, error: error instanceof Error ? error.message : String(error) }, 'Could not delete the old Stripe webhook endpoint');
    }
  }

  private async alert(reason: string): Promise<void> {
    await this.notifications.notifyAdmins({ type: 'PAYMENTS_CONNECTION_ERROR', title: 'The Stripe connection needs attention', body: reason || 'A check failed.', link: '/payments/gateway' });
  }

  private dto(row: PaymentGateway) {
    const state = (row.notificationCheck ?? { status: 'NOT_RUN' }) as unknown as NotificationCheckState;
    return {
      provider: row.provider,
      mode: row.mode,
      accountId: row.accountId,
      accountName: row.accountName,
      country: row.country,
      currency: row.currency,
      keyKind: row.keyKind === 'restricted' ? ('restricted' as const) : ('secret' as const),
      endpointRegistered: Boolean(row.webhookEndpointId),
      status: row.status,
      checks: row.checks as unknown as GatewayCheck[],
      notificationCheck: { status: state.status ?? 'NOT_RUN', startedAt: state.startedAt ?? null, passedAt: state.passedAt ?? null, fix: state.fix ?? null },
      webhookUrl: this.webhookUrl(),
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
    };
  }
}
