import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { checkBusinessProfile, checkProfilePicture, type FieldIssue } from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { TokenCipher } from '../../common/crypto/token-cipher.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { UploadedFileData } from '../../common/validation/uploaded-file.js';
import type { NumberBusinessProfile, WhatsAppNumber } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { MetaApiError, MetaGraphClient, type BusinessProfileInfo, type NumberStatusInfo } from '../meta/meta-graph.client.js';
import { imageSize } from './image-size.js';
import { mapQuality } from './numbers.service.js';

// Feature 010 (US7, research R11, contracts/meta-business-profile.md): the WhatsApp Business profile and the
// number's display name status through Meta. Our limits are checked before any call; values Meta returns are
// cached 5 minutes per number. The audit keeps field names only (values can hold personal details).

export const BusinessProfileInputSchema = z
  .object({
    about: z.string().trim().optional(),
    address: z.string().trim().optional(),
    description: z.string().trim().optional(),
    email: z.string().trim().optional(),
    websites: z.array(z.string().trim()).optional(),
    vertical: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'change at least one field');
export type BusinessProfileInput = z.infer<typeof BusinessProfileInputSchema>;

const CACHE_MS = 5 * 60_000;
const FIELDS = ['about', 'address', 'description', 'email', 'websites', 'vertical'] as const;

const toDto = (row: NumberBusinessProfile, number: Pick<WhatsAppNumber, 'id' | 'qualityRating' | 'messagingLimitTier'>) => ({
  numberId: number.id,
  about: row.about,
  address: row.address,
  description: row.description,
  email: row.email,
  websites: row.websites,
  vertical: row.vertical,
  profilePictureUrl: row.profilePictureUrl,
  verifiedName: row.verifiedName,
  nameStatus: row.nameStatus,
  newNameStatus: row.newNameStatus,
  qualityRating: number.qualityRating,
  messagingLimit: number.messagingLimitTier,
  readAt: row.readAt.toISOString(),
  changedAt: row.changedAt?.toISOString() ?? null,
});

/** The field Meta's message names, when it names one. */
function metaField(message: string): string {
  const lower = message.toLowerCase();
  return [...FIELDS, 'profile_picture_handle'].find((f) => lower.includes(f)) ?? 'meta';
}

/** Fields whose new value differs from what Meta holds now. */
export function changedFields(input: BusinessProfileInput, current: BusinessProfileInfo): Record<string, string | string[]> {
  const changed: Record<string, string | string[]> = {};
  for (const field of FIELDS) {
    const next = input[field];
    if (next === undefined) continue;
    const now = current[field];
    const same = Array.isArray(next) ? JSON.stringify(next) === JSON.stringify(now ?? []) : next === (now ?? '');
    if (!same) changed[field] = next;
  }
  return changed;
}

@Injectable()
export class BusinessProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The number, or 404; a number that is not connected answers 409 without calling Meta. */
  private async connected(numberId: string): Promise<WhatsAppNumber> {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
    if (!number) throw AppError.notFound('WhatsApp number not found');
    if (number.connectionStatus !== 'CONNECTED') throw AppError.conflict('Connect the number first', 'NUMBER_NOT_CONNECTED');
    return number;
  }

  /** Runs Graph calls, mapping failures to 502 META_UNAVAILABLE or META_REFUSED (with Meta's message). */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MetaApiError && error.httpStatus < 500) {
        throw new AppError(HttpStatus.BAD_GATEWAY, 'META_REFUSED', 'Meta refused the request', [{ field: metaField(error.message), issue: error.message }]);
      }
      throw new AppError(HttpStatus.BAD_GATEWAY, 'META_UNAVAILABLE', 'Meta could not be reached. Try again in a few minutes.');
    }
  }

  async get(numberId: string) {
    const number = await this.connected(numberId);
    const row = await this.prisma.numberBusinessProfile.findUnique({ where: { numberId } });
    if (row && Date.now() - row.readAt.getTime() < CACHE_MS) return toDto(row, number);
    return this.read(number);
  }

  /** Reads the profile and the number status from Meta and keeps them (5-minute cache). */
  private async read(number: WhatsAppNumber, changedBy?: AuditActor) {
    const token = this.cipher.decrypt(number.accessTokenEnc);
    const [profile, status] = await this.call(() => Promise.all([this.meta.getBusinessProfile(token, number.phoneNumberId), this.meta.getNumberStatus(token, number.phoneNumberId)]));
    const now = new Date();
    const values = {
      about: profile.about ?? null,
      address: profile.address ?? null,
      description: profile.description ?? null,
      email: profile.email ?? null,
      vertical: profile.vertical ?? null,
      websites: profile.websites ?? [],
      profilePictureUrl: profile.profile_picture_url ?? null,
      verifiedName: status.verifiedName,
      nameStatus: status.nameStatus,
      newNameStatus: status.newNameStatus,
      readAt: now,
      ...(changedBy ? { changedAt: now, changedById: changedBy.userId ?? null } : {}),
    };
    const row = await this.prisma.numberBusinessProfile.upsert({ where: { numberId: number.id }, create: { numberId: number.id, ...values }, update: values });
    const updated = await this.syncNumber(number, status);
    return toDto(row, updated);
  }

  /** The status call also refreshes the number's quality, name and portfolio messaging limit. */
  private async syncNumber(number: WhatsAppNumber, status: NumberStatusInfo) {
    return this.prisma.whatsAppNumber.update({
      where: { id: number.id },
      data: {
        ...(status.qualityRating ? { qualityRating: mapQuality(status.qualityRating) } : {}),
        ...(status.verifiedName ? { verifiedName: status.verifiedName } : {}),
        ...(status.messagingLimit ? { messagingLimitTier: status.messagingLimit } : {}),
      },
      select: { id: true, qualityRating: true, messagingLimitTier: true },
    });
  }

  /** Sends only the fields that changed, then returns what Meta holds. */
  async update(numberId: string, input: BusinessProfileInput, actor: AuditActor) {
    const issues = checkBusinessProfile(input);
    if (issues.length) throw AppError.validation('Check the profile fields', issues);
    const number = await this.connected(numberId);
    const token = this.cipher.decrypt(number.accessTokenEnc);
    const current = await this.call(() => this.meta.getBusinessProfile(token, number.phoneNumberId));
    const changed = changedFields(input, current);
    const fields = Object.keys(changed);
    if (fields.length) await this.call(() => this.meta.updateBusinessProfile(token, number.phoneNumberId, changed));
    const dto = await this.read(number, fields.length ? actor : undefined);
    if (fields.length) await this.audit.record(actor, 'business_profile.changed', { type: 'whatsapp_number', id: number.id }, { fields });
    return dto;
  }

  /** A new profile picture: checked here, uploaded with the Resumable Upload flow, never stored by us. */
  async uploadPicture(numberId: string, file: UploadedFileData | undefined, actor: AuditActor) {
    const number = await this.connected(numberId);
    if (!file) throw AppError.validation('Choose a picture', [{ field: 'file', issue: 'is required' }], 'PICTURE_RULES');
    const size = imageSize(file.buffer);
    const issues: FieldIssue[] = size
      ? checkProfilePicture({ type: size.type, bytes: file.size, width: size.width, height: size.height })
      : [{ field: 'file', issue: 'must be a JPEG or PNG image' }, ...(file.size > 5 * 1024 * 1024 ? [{ field: 'file', issue: 'must be 5 MB or smaller' }] : [])];
    if (issues.length) throw AppError.validation('The picture does not meet the rules', issues, 'PICTURE_RULES');
    const appId = this.config.META_APP_ID;
    if (!appId) throw AppError.validation('Profile pictures need the Meta app id on the server (META_APP_ID)', [{ field: 'file', issue: 'uploads are not configured on this server' }], 'PICTURE_RULES');
    const token = this.cipher.decrypt(number.accessTokenEnc);
    const handle = await this.call(async () => {
      const session = await this.meta.createUploadSession(token, appId, { name: size!.type === 'image/png' ? 'profile.png' : 'profile.jpg', length: file.size, type: size!.type });
      return this.meta.uploadSessionData(token, session, file.buffer);
    });
    await this.call(() => this.meta.updateBusinessProfile(token, number.phoneNumberId, { profile_picture_handle: handle }));
    const dto = await this.read(number, actor);
    await this.audit.record(actor, 'business_profile.changed', { type: 'whatsapp_number', id: number.id }, { fields: ['profile_picture'] });
    return dto;
  }
}
