import { createHash, createHmac } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { TokenCipher } from '../../common/crypto/token-cipher.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QueueRegistry, REDIS_CLIENT } from '../../common/queue/queue.module.js';
import type { Template, WhatsAppNumber } from '../../generated/prisma/client.js';
import { otpStatusDto } from './otp-status.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { otpSendJob } from '../sending/send-jobs.js';
import { SettingsService } from '../settings/settings.service.js';

// One-time codes for company systems (feature 009 US1, research R3 - R5,
// contracts/public-otp-v1.openapi.yaml). The code is never stored: the message row keeps a masked copy
// and the send job carries it encrypted, removed when the job ends.

export const MASKED_CODE = '••••';

export const SendCodeSchema = z
  .object({
    to: z.string().trim().min(1).max(32),
    code: z.string().regex(/^[0-9A-Za-z]{4,15}$/, '4 to 15 letters or digits'),
    template: z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15) }).strict().optional(),
    numberId: z.uuid().optional(),
  })
  .strict();
export type SendCodeInput = z.infer<typeof SendCodeSchema>;

export const OtpSettingsSchema = z
  .object({
    defaultTemplateId: z.uuid().nullable(),
    defaultNumberId: z.uuid().nullable(),
    limitPerPhone: z.number().int().min(1).max(50),
    limitWindowMinutes: z.number().int().min(1).max(1440),
  })
  .strict();
export type OtpSettingsInput = z.infer<typeof OtpSettingsSchema>;

export { otpStatusDto } from './otp-status.js';

const err = (status: HttpStatus, code: string, message: string, extra?: Record<string, unknown>) => new AppError(status, code, message, undefined, extra);

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly queues: QueueRegistry,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The settings row, made with the defaults on first use. */
  private async row() {
    return (await this.prisma.otpSettings.findFirst()) ?? this.prisma.otpSettings.create({ data: {} });
  }

  async settings() {
    const row = await this.row();
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const counts = await this.prisma.message.groupBy({ by: ['status'], where: { origin: 'OTP', createdAt: { gte: since } }, _count: { _all: true } });
    const count = (statuses: string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count._all, 0);
    const refused = Number((await this.redis.get(this.refusedKey())) ?? 0);
    return {
      defaultTemplateId: row.defaultTemplateId,
      defaultNumberId: row.defaultNumberId,
      limitPerPhone: row.limitPerPhone,
      limitWindowMinutes: row.limitWindowMinutes,
      last24h: {
        requested: counts.reduce((n, c) => n + c._count._all, 0),
        sent: count(['SENT', 'DELIVERED', 'READ']),
        delivered: count(['DELIVERED', 'READ']),
        failed: count(['FAILED', 'SKIPPED', 'CANCELLED']),
        expired: count(['EXPIRED']),
        refusedByLimit: refused,
      },
    };
  }

  async saveSettings(input: OtpSettingsInput, actor: AuditActor) {
    if (input.defaultTemplateId) {
      const template = await this.prisma.template.findUnique({ where: { id: input.defaultTemplateId } });
      if (!template || template.kind !== 'AUTHENTICATION' || template.status !== 'APPROVED') {
        throw AppError.validation('Choose an approved one-time code template', [{ field: 'defaultTemplateId', issue: 'is not an approved one-time code template' }], 'TEMPLATE_NOT_AUTHENTICATION');
      }
    }
    if (input.defaultNumberId) {
      const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: input.defaultNumberId } });
      if (!number || number.connectionStatus !== 'CONNECTED') throw AppError.validation('Choose a connected number', [{ field: 'defaultNumberId', issue: 'is not connected' }], 'NUMBER_NOT_CONNECTED');
    }
    const row = await this.row();
    await this.prisma.otpSettings.update({ where: { id: row.id }, data: { ...input, updatedById: actor.userId ?? null } });
    await this.audit.record(actor, 'otp_settings.changed', { type: 'otp_settings', id: row.id }, { ...input });
    return this.settings();
  }

  /** What the idempotency record keeps instead of the code (research R4): a keyed fingerprint. */
  idempotencyBody(input: SendCodeInput): Record<string, unknown> {
    const { code, ...rest } = input;
    return { ...rest, code: createHmac('sha256', this.config.TOKEN_ENCRYPTION_KEY).update(`otp:${code}`).digest('hex') };
  }

  private refusedKey(): string {
    return `wbm:otp:refused:${new Date().toISOString().slice(0, 10)}`;
  }

  /** Counts a code for the phone; returns the seconds to wait when the limit is reached. */
  private async takeSlot(phone: string, limit: number, windowMinutes: number): Promise<number | null> {
    const key = `wbm:otp:phone:${createHash('sha256').update(phone).digest('hex')}`;
    const [[, count], [, ttl]] = (await this.redis.multi().incr(key).ttl(key).exec()) as [[Error | null, number], [Error | null, number]];
    if (ttl < 0) await this.redis.expire(key, windowMinutes * 60);
    if (count <= limit) return null;
    await this.redis.multi().incr(this.refusedKey()).expire(this.refusedKey(), 2 * 86_400).exec();
    return ttl > 0 ? ttl : windowMinutes * 60;
  }

  private async template(input: SendCodeInput, defaultTemplateId: string | null): Promise<Template> {
    const template = input.template
      ? await this.prisma.template.findFirst({ where: { name: input.template.name, language: input.template.language, status: { not: 'DELETED' } }, orderBy: { updatedAt: 'desc' } })
      : defaultTemplateId
        ? await this.prisma.template.findUnique({ where: { id: defaultTemplateId } })
        : null;
    if (!template) {
      if (!input.template) throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'NO_DEFAULT_TEMPLATE', 'Name a template, or choose a default one-time code template in the settings');
      throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'TEMPLATE_NOT_FOUND', 'No template with this name and language');
    }
    if (template.kind !== 'AUTHENTICATION') throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'TEMPLATE_NOT_AUTHENTICATION', 'The template is not a one-time code template');
    if (template.status !== 'APPROVED') throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'TEMPLATE_NOT_APPROVED', 'The template is not approved by Meta');
    return template;
  }

  private async number(input: SendCodeInput, template: Template, defaultNumberId: string | null): Promise<WhatsAppNumber> {
    const id = input.numberId ?? defaultNumberId;
    const number = id
      ? await this.prisma.whatsAppNumber.findUnique({ where: { id } })
      : await this.prisma.whatsAppNumber.findFirst({ where: { wabaId: template.wabaId, connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
    if (!number || number.connectionStatus !== 'CONNECTED') throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'NUMBER_NOT_CONNECTED', 'The WhatsApp number is not connected');
    if (number.wabaId !== template.wabaId) throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'TEMPLATE_NOT_FOUND', 'The template does not belong to this number\'s WhatsApp account');
    if (!number.sendingEnabled) throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'NUMBER_NOT_SENDING', 'Sending is stopped on this number (quality or messaging limit)');
    return number;
  }

  /** POST /api/v1/otp (R3): checks, the per-phone limit, a masked message row and an encrypted job. */
  async send(input: SendCodeInput, apiKeyId: string): Promise<{ status: number; body: { id: string; status: 'queued' } }> {
    const company = await this.settingsService.get();
    const phone = normalizePhone(input.to, company.defaultCountryCode);
    if (!phone) throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_NUMBER', 'The phone number is not valid');
    const blocked = await this.prisma.contact.findFirst({ where: { phoneE164: phone.e164, blockedAt: { not: null } }, select: { id: true } });
    if (blocked) throw err(HttpStatus.UNPROCESSABLE_ENTITY, 'RECIPIENT_BLOCKED', 'This number is blocked');
    const settings = await this.row();
    const template = await this.template(input, settings.defaultTemplateId);
    const number = await this.number(input, template, settings.defaultNumberId);
    const wait = await this.takeSlot(phone.e164, settings.limitPerPhone, settings.limitWindowMinutes);
    if (wait !== null) throw err(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_CODES', 'Too many codes for this number; try again later', { retryAfterSeconds: wait });

    const message = await this.prisma.message.create({
      data: {
        origin: 'OTP',
        apiKeyId,
        phoneE164: phone.e164,
        recipientCountry: phone.country,
        numberId: number.id,
        templateId: template.id,
        resolvedParams: { 'BODY.1': MASKED_CODE },
        status: 'QUEUED',
        queuedAt: new Date(),
      },
    });
    const job = otpSendJob(message.id, this.cipher.encrypt(input.code));
    try {
      await this.queues.sendQueue(number.id).add(job.name, job.data, job.opts);
    } catch (error) {
      this.logger.error({ messageId: message.id, err: (error as Error).message }, 'Could not queue a one-time code');
      await this.prisma.message.update({ where: { id: message.id }, data: { status: 'FAILED', failureReason: 'Could not queue the code', failedAt: new Date() } });
      throw err(HttpStatus.SERVICE_UNAVAILABLE, 'UNAVAILABLE', 'The code could not be queued; try again');
    }
    return { status: 202, body: { id: message.id, status: 'queued' } };
  }

  /** GET /api/v1/otp/{id}: the key's own codes, for the 30 days they are kept. */
  async status(id: string, apiKeyId: string) {
    const parsed = z.uuid().safeParse(id);
    const m = parsed.success ? await this.prisma.message.findFirst({ where: { id, origin: 'OTP', apiKeyId } }) : null;
    if (!m) throw AppError.notFound('Code not found');
    return otpStatusDto(m);
  }
}
