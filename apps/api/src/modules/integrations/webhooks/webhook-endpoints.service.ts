import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { EVENT_GROUPS, EVENT_LABELS, SUBSCRIBABLE_EVENT_TYPES, makeWebhookSecret } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isBlockedAddress } from '../../../common/http/safe-http.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { PageQuerySchema } from '../../../common/validation/pagination.js';
import type { Prisma, WebhookEndpoint } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { OutboundEvents } from './outbound-events.js';
import { WebhookDeliveries, type AttemptResult } from './webhook-deliveries.service.js';

// Webhook endpoints (feature 006 US1, FR-001 - FR-009, contracts/integrations-api.openapi.yaml).
// Secrets are shown once and stored encrypted; addresses are https and never private or local
// (outside the local-test allowance). Admins only (integrations.manage).

const MAX_ENDPOINTS = 20;
const SECRET_OVERLAP_MS = 24 * 3600 * 1000;
const eventType = z.enum(SUBSCRIBABLE_EVENT_TYPES as [string, ...string[]]);

export const WebhookEndpointInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.string().trim().min(1).max(2000),
    eventTypes: z.array(eventType).min(1).max(SUBSCRIBABLE_EVENT_TYPES.length),
    includeContent: z.boolean().default(true),
  })
  .strict();
export type WebhookEndpointInput = z.infer<typeof WebhookEndpointInputSchema>;

export const WebhookEndpointPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    eventTypes: z.array(eventType).min(1).max(SUBSCRIBABLE_EVENT_TYPES.length).optional(),
    includeContent: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field' });
export type WebhookEndpointPatch = z.infer<typeof WebhookEndpointPatchSchema>;

export const DeliveryListQuerySchema = PageQuerySchema.extend({
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED', 'CANCELLED']).optional(),
  type: z.string().trim().max(40).optional(),
});
export type DeliveryListQuery = z.infer<typeof DeliveryListQuerySchema>;

export interface WebhookEndpointDto {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  includeContent: boolean;
  status: string;
  secretHint: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failingSince: string | null;
  waiting: number;
  createdAt: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly events: OutboundEvents,
    private readonly deliveries: WebhookDeliveries,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  eventTypes() {
    return SUBSCRIBABLE_EVENT_TYPES.map((type) => ({ type, label: EVENT_LABELS[type], group: EVENT_GROUPS[type] }));
  }

  async list(): Promise<WebhookEndpointDto[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } });
    const waiting = await this.waitingCounts(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, waiting.get(r.id) ?? 0));
  }

  async get(id: string): Promise<WebhookEndpointDto> {
    const row = await this.find(id);
    return this.toDto(row, (await this.waitingCounts([id])).get(id) ?? 0);
  }

  async create(input: WebhookEndpointInput, actor: AuditActor): Promise<WebhookEndpointDto & { secret: string }> {
    this.assertUrl(input.url);
    if ((await this.prisma.webhookEndpoint.count()) >= MAX_ENDPOINTS) {
      throw AppError.conflict(`Up to ${MAX_ENDPOINTS} webhook endpoints can be added`, 'TOO_MANY_ENDPOINTS');
    }
    const secret = makeWebhookSecret(randomBytes(32));
    let row: WebhookEndpoint;
    try {
      row = await this.prisma.webhookEndpoint.create({
        data: {
          name: input.name,
          url: input.url,
          eventTypes: [...new Set(input.eventTypes)],
          includeContent: input.includeContent,
          secretEncrypted: this.cipher.encrypt(secret),
          createdById: actor.userId ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('Another endpoint already has this name', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'webhook_endpoint.created', { type: 'webhook_endpoint', id: row.id }, { name: row.name, eventTypes: row.eventTypes, includeContent: row.includeContent });
    this.events.invalidate();
    return { ...this.toDto(row, 0), secret };
  }

  async update(id: string, patch: WebhookEndpointPatch, actor: AuditActor): Promise<WebhookEndpointDto> {
    await this.find(id);
    if (patch.url !== undefined) this.assertUrl(patch.url);
    try {
      await this.prisma.webhookEndpoint.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.url !== undefined ? { url: patch.url } : {}),
          ...(patch.eventTypes !== undefined ? { eventTypes: [...new Set(patch.eventTypes)] } : {}),
          ...(patch.includeContent !== undefined ? { includeContent: patch.includeContent } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('Another endpoint already has this name', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'webhook_endpoint.updated', { type: 'webhook_endpoint', id }, { changed: Object.keys(patch) });
    this.events.invalidate();
    return this.get(id);
  }

  async pause(id: string, actor: AuditActor): Promise<WebhookEndpointDto> {
    await this.find(id);
    await this.prisma.$transaction([
      this.prisma.webhookEndpoint.update({ where: { id }, data: { status: 'PAUSED' } }),
      // Waiting deliveries keep their place without a due time until resume.
      this.prisma.webhookDelivery.updateMany({ where: { endpointId: id, status: 'PENDING' }, data: { nextAttemptAt: null } }),
    ]);
    await this.audit.record(actor, 'webhook_endpoint.paused', { type: 'webhook_endpoint', id });
    return this.get(id);
  }

  async resume(id: string, actor: AuditActor): Promise<WebhookEndpointDto> {
    await this.find(id);
    await this.prisma.webhookEndpoint.update({ where: { id }, data: { status: 'ACTIVE', consecutiveFailures: 0, failingSince: null } });
    await this.audit.record(actor, 'webhook_endpoint.resumed', { type: 'webhook_endpoint', id });
    await this.deliveries.dueNow(id);
    return this.get(id);
  }

  async renewSecret(id: string, actor: AuditActor): Promise<WebhookEndpointDto & { secret: string }> {
    const row = await this.find(id);
    const secret = makeWebhookSecret(randomBytes(32));
    // The old secret keeps signing for 24 hours, so receivers can switch without missing events.
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { secretEncrypted: this.cipher.encrypt(secret), previousSecretEncrypted: row.secretEncrypted, previousSecretUntil: new Date(Date.now() + SECRET_OVERLAP_MS) },
    });
    await this.audit.record(actor, 'webhook_endpoint.secret_renewed', { type: 'webhook_endpoint', id });
    return { ...this.toDto(updated, (await this.waitingCounts([id])).get(id) ?? 0), secret };
  }

  /** The test button: one signed `test.ping` now, with the endpoint's answer (no retries). */
  async test(id: string, actor: AuditActor): Promise<AttemptResult> {
    await this.find(id);
    const user = actor.userId ? await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true } }) : null;
    const eventId = uuidv7();
    const deliveryId = uuidv7();
    await this.prisma.$transaction([
      this.prisma.outboundEvent.create({ data: { id: eventId, type: 'test.ping', occurredAt: new Date(), data: { endpointId: id, sentBy: user ? { id: user.id, name: user.name } : null } } }),
      this.prisma.webhookDelivery.create({ data: { id: deliveryId, endpointId: id, eventId, status: 'PENDING', nextAttemptAt: null } }),
    ]);
    return this.deliveries.attemptOnce(deliveryId);
  }

  async deliveriesOf(id: string, query: DeliveryListQuery) {
    await this.find(id);
    const where: Prisma.WebhookDeliveryWhereInput = {
      endpointId: id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { event: { type: query.type } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        include: { event: { select: { id: true, type: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return { items: rows.map(deliveryDto), total };
  }

  /** Sends a delivery again with the same event id (FR-007). */
  async resend(deliveryId: string, actor: AuditActor) {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: { select: { status: true } } } });
    if (!delivery) throw AppError.notFound('Delivery not found');
    const active = delivery.endpoint.status === 'ACTIVE';
    const updated = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', nextAttemptAt: active ? new Date() : null },
      include: { event: { select: { id: true, type: true } } },
    });
    if (active) this.events.enqueue(deliveryId, updated.attempts, 0, `r${Date.now()}`);
    await this.audit.record(actor, 'webhook_delivery.resent', { type: 'webhook_endpoint', id: delivery.endpointId }, { deliveryId });
    return deliveryDto(updated);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.find(id);
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.updateMany({ where: { endpointId: id, status: 'PENDING' }, data: { status: 'CANCELLED', nextAttemptAt: null } }),
      this.prisma.webhookEndpoint.delete({ where: { id } }),
    ]);
    await this.audit.record(actor, 'webhook_endpoint.deleted', { type: 'webhook_endpoint', id }, { name: row.name });
    this.events.invalidate();
  }

  private async find(id: string): Promise<WebhookEndpoint> {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Webhook endpoint not found');
    return row;
  }

  private async waitingCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.webhookDelivery.groupBy({ by: ['endpointId'], where: { endpointId: { in: ids }, status: 'PENDING' }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.endpointId, r._count._all]));
  }

  /** https only, no user name or password, never a private, local or reserved address (FR-001). */
  private assertUrl(value: string): void {
    const refuse = (issue: string) => AppError.validation('This address cannot receive webhooks', [{ field: 'url', issue }]);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw refuse('not a valid web address');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const local = this.config.OUTBOUND_ALLOW_LOCAL && this.config.NODE_ENV !== 'production' && LOCAL_HOSTS.has(host);
    if (url.username || url.password) throw refuse('must not contain a user name or password');
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw refuse('must start with https://');
    if (!local && ((isIP(host) !== 0 && isBlockedAddress(host)) || host === 'localhost' || host.endsWith('.localhost'))) {
      throw refuse('must not be a private, local or reserved address');
    }
  }

  private toDto(row: WebhookEndpoint, waiting: number): WebhookEndpointDto {
    const secret = this.cipher.decrypt(row.secretEncrypted);
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      eventTypes: row.eventTypes,
      includeContent: row.includeContent,
      status: row.status,
      secretHint: `…${secret.slice(-4)}`,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
      failingSince: row.failingSince?.toISOString() ?? null,
      waiting,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function deliveryDto(row: Prisma.WebhookDeliveryGetPayload<{ include: { event: { select: { id: true; type: true } } } }>) {
  return {
    id: row.id,
    eventId: `evt_${row.event.id}`,
    type: row.event.type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
