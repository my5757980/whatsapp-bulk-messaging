import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { TokenCipher } from '../../common/crypto/token-cipher.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import type { Prisma, WhatsAppNumber } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { ApiCampaignPauser } from '../integrations/api-campaigns/api-campaign-pauser.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { classifyMetaError, describeMetaError } from '../meta/meta-error-classifier.js';
import { MetaApiError, MetaGraphClient, type PhoneNumberInfo } from '../meta/meta-graph.client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { requestSendWorkerSync } from '../sending/send-jobs.js';

// WhatsApp number connection, validation and refresh (FR-001, FR-002, T085).

export const ConnectNumberSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    wabaId: z.string().trim().min(1).max(64),
    phoneNumberId: z.string().trim().min(1).max(64),
    accessToken: z.string().trim().min(1).max(2048),
  })
  .strict();
export type ConnectNumberInput = z.infer<typeof ConnectNumberSchema>;

export const UpdateNumberSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    sendRatePerSecond: z.number().int().min(1).max(80),
    sendingEnabled: z.boolean(),
    messagingLimitTier: z.string().trim().max(40).nullable(),
    accessToken: z.string().trim().min(1).max(2048),
  })
  .partial()
  .strict();
export type UpdateNumberInput = z.infer<typeof UpdateNumberSchema>;

type Quality = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export function mapQuality(value: string | undefined): Quality {
  const upper = value?.toUpperCase();
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED' ? upper : 'UNKNOWN';
}

/** Response shape (contract `WhatsAppNumber`); the access token is never included. */
export function toNumberDto(n: WhatsAppNumber) {
  return {
    id: n.id,
    label: n.label,
    wabaId: n.wabaId,
    phoneNumberId: n.phoneNumberId,
    displayPhoneNumber: n.displayPhoneNumber,
    verifiedName: n.verifiedName,
    connectionStatus: n.connectionStatus,
    qualityRating: n.qualityRating,
    messagingLimitTier: n.messagingLimitTier,
    throughputLevel: n.throughputLevel,
    sendRatePerSecond: n.sendRatePerSecond,
    sendingEnabled: n.sendingEnabled,
    lastSyncedAt: n.lastSyncedAt?.toISOString() ?? null,
    lastError: n.lastError,
  };
}

function infoFields(info: PhoneNumberInfo) {
  return {
    displayPhoneNumber: info.displayPhoneNumber,
    verifiedName: info.verifiedName,
    qualityRating: mapQuality(info.qualityRating),
    throughputLevel: info.throughputLevel ?? null,
    // Feature 010 (R11): the portfolio limit replaces the deprecated messaging_limit_tier field; the column stays.
    ...(info.messagingLimit ? { messagingLimitTier: info.messagingLimit } : {}),
    lastSyncedAt: new Date(),
    lastError: null,
  };
}

function metaReason(error: unknown): string {
  return error instanceof MetaApiError ? describeMetaError(error.code, error.message) : 'Could not reach Meta';
}

@Injectable()
export class NumbersService {
  private readonly logger = new Logger(NumbersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly meta: MetaGraphClient,
    private readonly queues: QueueRegistry,
    private readonly audit: AuditService,
    private readonly campaigns: CampaignsService,
    private readonly notifications: NotificationsService,
    private readonly apiCampaigns: ApiCampaignPauser,
  ) {}

  /** Decrypted access token, for Graph API calls only; never logged or returned. */
  token(number: Pick<WhatsAppNumber, 'accessTokenEnc'>): string {
    return this.cipher.decrypt(number.accessTokenEnc);
  }

  async getRow(id: string): Promise<WhatsAppNumber> {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id } });
    if (!number) throw AppError.notFound('WhatsApp number not found');
    return number;
  }

  async list() {
    const rows = await this.prisma.whatsAppNumber.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toNumberDto);
  }

  async get(id: string) {
    return toNumberDto(await this.getRow(id));
  }

  private async validate(token: string, phoneNumberId: string): Promise<PhoneNumberInfo> {
    try {
      return await this.meta.getPhoneNumber(token, phoneNumberId);
    } catch (error) {
      throw AppError.validation(`Meta rejected the credentials: ${metaReason(error)}`, undefined, 'META_ERROR');
    }
  }

  /** The per-number send rate is a BullMQ global rate limit, so changes apply live (T097). */
  async applyRateLimit(number: Pick<WhatsAppNumber, 'id' | 'sendRatePerSecond'>): Promise<void> {
    await this.queues.sendQueue(number.id).setGlobalRateLimit(number.sendRatePerSecond, 1000);
  }

  async connect(input: ConnectNumberInput, actor: AuditActor) {
    if (await this.prisma.whatsAppNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId }, select: { id: true } })) {
      throw AppError.conflict('This phone number is already added. Update its access token to reconnect it.');
    }
    const info = await this.validate(input.accessToken, input.phoneNumberId);
    let created: WhatsAppNumber;
    try {
      created = await this.prisma.whatsAppNumber.create({
        data: {
          label: input.label,
          wabaId: input.wabaId,
          phoneNumberId: input.phoneNumberId,
          accessTokenEnc: this.cipher.encrypt(input.accessToken),
          connectionStatus: 'CONNECTED',
          ...infoFields(info),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('This phone number is already added.');
      throw error;
    }
    await this.applyRateLimit(created);
    await requestSendWorkerSync(this.queues);
    await this.audit.record(actor, 'number.connected', { type: 'whatsapp_number', id: created.id }, {
      label: created.label,
      wabaId: created.wabaId,
      phoneNumberId: created.phoneNumberId,
    });
    return toNumberDto(created);
  }

  async update(id: string, patch: UpdateNumberInput, actor: AuditActor) {
    const number = await this.getRow(id);
    const data: Prisma.WhatsAppNumberUpdateInput = {};
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.sendRatePerSecond !== undefined) data.sendRatePerSecond = patch.sendRatePerSecond;
    if (patch.sendingEnabled !== undefined) data.sendingEnabled = patch.sendingEnabled;
    if (patch.messagingLimitTier !== undefined) data.messagingLimitTier = patch.messagingLimitTier;
    if (patch.accessToken !== undefined) {
      const info = await this.validate(patch.accessToken, number.phoneNumberId);
      Object.assign(data, infoFields(info), { accessTokenEnc: this.cipher.encrypt(patch.accessToken), connectionStatus: 'CONNECTED' });
    }
    const updated = await this.prisma.whatsAppNumber.update({ where: { id }, data });
    if (patch.sendRatePerSecond !== undefined) await this.applyRateLimit(updated);
    if (patch.accessToken !== undefined) {
      await this.audit.record(actor, 'number.credentials_changed', { type: 'whatsapp_number', id }, { phoneNumberId: number.phoneNumberId });
    }
    return toNumberDto(updated);
  }

  async disconnect(id: string, actor: AuditActor): Promise<void> {
    const number = await this.getRow(id);
    await this.prisma.whatsAppNumber.update({ where: { id }, data: { connectionStatus: 'DISCONNECTED' } });
    const running = await this.prisma.campaign.findMany({ where: { numberId: id, state: 'RUNNING' }, select: { id: true } });
    for (const campaign of running) await this.campaigns.autoPause(campaign.id, 'number_disconnected', actor);
    await this.apiCampaigns.pauseForNumber(id);
    await this.audit.record(actor, 'number.disconnected', { type: 'whatsapp_number', id }, { phoneNumberId: number.phoneNumberId });
  }

  /**
   * Re-reads the number from Meta. Credential errors move CONNECTED -> ERROR and notify admins
   * (CREDENTIALS_FAILED); transport errors only record `last_error`.
   */
  async refresh(id: string) {
    const number = await this.getRow(id);
    try {
      const info = await this.meta.getPhoneNumber(this.token(number), number.phoneNumberId);
      const updated = await this.prisma.whatsAppNumber.update({
        where: { id },
        data: { ...infoFields(info), ...(number.connectionStatus === 'ERROR' ? { connectionStatus: 'CONNECTED' as const } : {}) },
      });
      return toNumberDto(updated);
    } catch (error) {
      const reason = metaReason(error);
      const credentialProblem =
        error instanceof MetaApiError && (error.httpStatus === 401 || classifyMetaError(error.code, error.httpStatus) === 'BLOCKING');
      const updated = await this.prisma.whatsAppNumber.update({
        where: { id },
        data: { lastError: reason, ...(credentialProblem && number.connectionStatus === 'CONNECTED' ? { connectionStatus: 'ERROR' as const } : {}) },
      });
      if (credentialProblem && number.connectionStatus === 'CONNECTED') {
        await this.apiCampaigns.pauseForNumber(id);
        await this.notifications.notifyAdmins({
          type: 'CREDENTIALS_FAILED',
          title: 'WhatsApp number needs attention',
          body: `${number.label}: ${reason}. Update the access token to resume sending.`,
          link: '/settings/numbers',
        });
      }
      this.logger.warn({ numberId: id, reason }, 'Number refresh failed');
      return toNumberDto(updated);
    }
  }

  /**
   * A send failed with a credentials or account error (e.g. 190 token expired): CONNECTED -> ERROR,
   * so resume stays blocked until the token is fixed, and admins are told once (FR-027).
   */
  async markUnavailable(numberId: string, reason: string): Promise<void> {
    const { count } = await this.prisma.whatsAppNumber.updateMany({
      where: { id: numberId, connectionStatus: 'CONNECTED' },
      data: { connectionStatus: 'ERROR', lastError: reason },
    });
    if (!count) return;
    await this.apiCampaigns.pauseForNumber(numberId);
    const number = await this.getRow(numberId);
    await this.notifications.notifyAdmins({
      type: 'CREDENTIALS_FAILED',
      title: 'WhatsApp number needs attention',
      body: `${number.label}: ${reason}. Update the access token to resume sending.`,
      link: '/settings/numbers',
    });
  }

  /** Repeatable refresh of every connected number (T087). */
  async refreshAll(): Promise<number> {
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: { not: 'DISCONNECTED' } }, select: { id: true } });
    for (const { id } of numbers) await this.refresh(id);
    return numbers.length;
  }
}
