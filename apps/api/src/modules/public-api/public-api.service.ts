import { HttpStatus, Injectable } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/phone/phone.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import type { MessageEventType, MessageStatus, Prisma, WhatsAppNumber } from '../../generated/prisma/client.js';
import { sendJobId } from '../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../sending/send-outcome.js';
import { HEADER_MEDIA_URL_PARAM, headerMediaType } from '../sending/template-payload.builder.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ApiKeyContext } from './api-key.guard.js';
import { IdempotencyService, requestHash } from './idempotency.service.js';

// POST /api/v1/messages and GET /api/v1/messages/{id} (FR-033-FR-036, T189).

export const SendRequestSchema = z
  .object({
    numberId: z.uuid().optional(),
    to: z.string().trim().min(1).max(32),
    template: z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15) }).strict(),
    params: z.record(z.string(), z.string().max(1024)).optional(),
    headerMediaUrl: z.url({ protocol: /^https$/ }).optional(),
    contact: z
      .object({ name: z.string().trim().max(120).optional(), optIn: z.boolean().optional(), optInSourceNote: z.string().trim().max(500).optional() })
      .strict()
      .refine((c) => c.optIn !== true || Boolean(c.optInSourceNote), { path: ['optInSourceNote'], error: 'is required to record an opt-in' })
      .optional(),
  })
  .strict();
export type SendRequest = z.infer<typeof SendRequestSchema>;

const refuse = (code: string, message: string, details?: ErrorDetail[]) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
const notFound = (code: string, message: string) => new AppError(HttpStatus.NOT_FOUND, code, message);

const PUBLIC_STATUS: Record<MessageStatus, string> = {
  PENDING: 'QUEUED',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'FAILED',
};
const HISTORY_STATUS: Record<MessageEventType, string> = {
  QUEUED: 'QUEUED',
  SENT_ACCEPTED: 'SENT',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  RETRY_SCHEDULED: 'RETRYING',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
  REQUEUED: 'QUEUED',
};

export interface Accepted {
  status: 200 | 202;
  body: { id: string; status: 'QUEUED'; createdAt: string };
}

@Injectable()
export class PublicApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly settings: SettingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async sendingNumber(numberId: string | undefined): Promise<WhatsAppNumber> {
    if (numberId) {
      const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
      if (!number) throw notFound('NUMBER_NOT_FOUND', 'No WhatsApp number with this id');
      return number;
    }
    const connected = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: 'CONNECTED' }, take: 2 });
    if (connected.length > 1) throw AppError.badRequest('numberId is required when more than one number is connected');
    if (!connected[0]) throw refuse('NUMBER_UNAVAILABLE', 'No WhatsApp number is connected');
    return connected[0];
  }

  async send(input: SendRequest, apiKey: ApiKeyContext, idempotencyKey: string | undefined): Promise<Accepted> {
    const hash = idempotencyKey ? requestHash(input) : null;
    if (idempotencyKey && hash) {
      const hit = await this.idempotency.lookup(apiKey.id, idempotencyKey, hash);
      if (hit?.kind === 'conflict') throw AppError.conflict('This Idempotency-Key was already used with a different request', 'IDEMPOTENCY_CONFLICT');
      if (hit?.kind === 'replay') return { status: 200, body: { id: hit.messageId, status: 'QUEUED', createdAt: hit.createdAt.toISOString() } };
    }

    const number = await this.sendingNumber(input.numberId);
    if (number.connectionStatus !== 'CONNECTED' || !number.sendingEnabled) throw refuse('NUMBER_UNAVAILABLE', 'The WhatsApp number is not available for sending');

    const template = await this.prisma.template.findUnique({
      where: { wabaId_name_language: { wabaId: number.wabaId, name: input.template.name, language: input.template.language } },
    });
    if (!template || template.status === 'DELETED') throw notFound('TEMPLATE_NOT_FOUND', 'No template with this name and language for the number');
    if (template.status !== 'APPROVED') throw refuse('TEMPLATE_NOT_APPROVED', `The template is ${template.status.toLowerCase()}, not approved`);

    const { defaultCountryCode } = await this.settings.get();
    const phone = normalizePhone(input.to, defaultCountryCode);
    if (!phone) throw refuse('INVALID_NUMBER', 'The phone number is not valid');

    const params = input.params ?? {};
    const keys = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
    const details: ErrorDetail[] = [
      ...keys.filter((k) => !params[k]?.trim()).map((k) => ({ field: `params.${k}`, issue: 'is required' })),
      ...Object.keys(params).filter((k) => !keys.includes(k)).map((k) => ({ field: `params.${k}`, issue: 'is not a variable of this template' })),
    ];
    const mediaType = headerMediaType(template.components as unknown as MetaTemplateComponent[]);
    if (mediaType && !input.headerMediaUrl) details.push({ field: 'headerMediaUrl', issue: `is required for a ${mediaType} header` });
    if (details.length) throw refuse('PARAMS_MISMATCH', 'The parameters do not match the template', details);

    const wantsOptIn = input.contact?.optIn === true;
    const note = input.contact?.optInSourceNote; // required with optIn (schema)
    const existing = await this.prisma.contact.findUnique({ where: { phoneE164: phone.e164 } });
    // An opt-out is only undone by the contact (keyword) or an admin, never by an API call.
    if (existing?.consentStatus === 'OPTED_OUT') throw refuse('CONTACT_OPTED_OUT', 'The contact has opted out');
    const consent = wantsOptIn ? 'OPTED_IN' : (existing?.consentStatus ?? 'UNKNOWN');
    if (template.category === 'MARKETING' && consent !== 'OPTED_IN') throw refuse('NO_OPT_IN', 'Marketing templates need the contact to have opted in');

    let message: { id: string; createdAt: Date };
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const contact = await tx.contact.upsert({
          where: { phoneE164: phone.e164 },
          create: { phoneE164: phone.e164, countryCode: phone.country, name: input.contact?.name || null },
          update: {},
        });
        if (input.contact?.name && !contact.name) await tx.contact.update({ where: { id: contact.id }, data: { name: input.contact.name } });
        if (wantsOptIn && contact.consentStatus === 'UNKNOWN') {
          await tx.contact.update({ where: { id: contact.id }, data: { consentStatus: 'OPTED_IN', consentSource: 'API', consentSourceNote: note, consentAt: now } });
          await tx.consentEvent.create({ data: { contactId: contact.id, status: 'OPTED_IN', source: 'API', note: note ?? null, createdAt: now } });
        }
        const created = await tx.message.create({
          data: {
            origin: 'API',
            apiKeyId: apiKey.id,
            contactId: contact.id,
            phoneE164: phone.e164,
            recipientCountry: phone.country,
            numberId: number.id,
            templateId: template.id,
            resolvedParams: { ...params, ...(input.headerMediaUrl ? { [HEADER_MEDIA_URL_PARAM]: input.headerMediaUrl } : {}) } as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: now,
          },
        });
        await tx.messageEvent.create({ data: { messageId: created.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${created.id}:queued` } });
        if (idempotencyKey && hash) await this.idempotency.remember(tx, apiKey.id, idempotencyKey, hash, created.id);
        return created;
      });
    } catch (error) {
      if (idempotencyKey && hash && isUniqueViolation(error)) {
        const hit = await this.idempotency.lookup(apiKey.id, idempotencyKey, hash); // a concurrent duplicate won the race
        if (hit?.kind === 'replay') return { status: 200, body: { id: hit.messageId, status: 'QUEUED', createdAt: hit.createdAt.toISOString() } };
        if (hit?.kind === 'conflict') throw AppError.conflict('This Idempotency-Key was already used with a different request', 'IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }

    try {
      await this.queues.sendQueue(number.id).add('send', { messageId: message.id }, {
        jobId: sendJobId(message.id),
        attempts: MAX_SEND_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      });
    } catch (error) {
      // Not queued: record the failure and free the Idempotency-Key so the caller's retry can send.
      await this.prisma.message.update({ where: { id: message.id }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
      if (idempotencyKey) await this.idempotency.forget(apiKey.id, idempotencyKey);
      throw error;
    }
    return { status: 202, body: { id: message.id, status: 'QUEUED', createdAt: message.createdAt.toISOString() } };
  }

  async status(id: string, apiKey: ApiKeyContext) {
    const message = await this.prisma.message.findFirst({ where: { id, apiKeyId: apiKey.id }, include: { events: { orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] } } });
    if (!message) throw notFound('NOT_FOUND', 'Message not found');
    const history: Array<{ status: string; at: string }> = [];
    for (const e of message.events) {
      const status = HISTORY_STATUS[e.type];
      if (history.at(-1)?.status !== status) history.push({ status, at: e.occurredAt.toISOString() });
    }
    return {
      id: message.id,
      status: PUBLIC_STATUS[message.status],
      failureCode: message.failureCode,
      failureReason: message.failureReason ?? (message.status === 'CANCELLED' ? 'cancelled' : null),
      history,
    };
  }

  async templates() {
    const rows = await this.prisma.template.findMany({ where: { status: 'APPROVED' }, orderBy: [{ name: 'asc' }, { language: 'asc' }] });
    return rows.map((t) => ({
      name: t.name,
      language: t.language,
      category: t.category,
      variables: ((Array.isArray(t.variables) ? t.variables : []) as Array<{ key: string }>).map((v) => v.key),
    }));
  }
}
