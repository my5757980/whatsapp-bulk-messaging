import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { MB, type UploadedFileData } from '../../common/validation/uploaded-file.js';
import type { MediaAsset, Prisma, WhatsAppNumber } from '../../generated/prisma/client.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import { NumbersService } from '../numbers/numbers.service.js';

// Media for template samples and campaign headers (T090). Files live in object storage; the
// Meta media id is uploaded lazily per sending number and reused (cached in meta_media_ids).

const LIMITS: Record<string, { maxBytes: number; ext: string }> = {
  'image/jpeg': { maxBytes: 5 * MB, ext: 'jpg' },
  'image/png': { maxBytes: 5 * MB, ext: 'png' },
  'video/mp4': { maxBytes: 16 * MB, ext: 'mp4' },
  'video/3gpp': { maxBytes: 16 * MB, ext: '3gp' },
  'application/pdf': { maxBytes: 100 * MB, ext: 'pdf' },
};

/** Meta media ids expire after 30 days; re-upload a little earlier. */
const META_MEDIA_TTL_MS = 25 * 24 * 3600 * 1000;

export const MediaUploadSchema = z.object({ purpose: z.enum(['TEMPLATE_SAMPLE', 'CAMPAIGN_HEADER']) });
export type MediaUploadInput = z.infer<typeof MediaUploadSchema>;

export function toMediaDto(m: MediaAsset) {
  return { id: m.id, mimeType: m.mimeType, sizeBytes: m.sizeBytes, purpose: m.purpose };
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly meta: MetaGraphClient,
    private readonly numbers: NumbersService,
  ) {}

  async create(file: UploadedFileData | undefined, input: MediaUploadInput) {
    if (!file?.size) throw AppError.validation('Choose a file to upload', [{ field: 'file', issue: 'is required' }]);
    const limit = LIMITS[file.mimetype];
    if (!limit) {
      throw AppError.validation('Unsupported file type', [{ field: 'file', issue: `use JPEG, PNG, MP4, 3GPP or PDF (got ${file.mimetype})` }]);
    }
    if (file.size > limit.maxBytes) {
      throw AppError.validation('File too large', [{ field: 'file', issue: `must be at most ${limit.maxBytes / MB} MB for ${file.mimetype}` }]);
    }
    const storageKey = `media/${randomUUID()}.${limit.ext}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    const asset = await this.prisma.mediaAsset.create({
      data: { storageKey, mimeType: file.mimetype, sizeBytes: file.size, purpose: input.purpose },
    });
    return toMediaDto(asset);
  }

  /** Returns the number's Meta media id for an asset, uploading it on first use. */
  async ensureMetaMediaId(assetId: string, number: WhatsAppNumber): Promise<string> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new Error(`Media asset ${assetId} not found`);
    const cache = (asset.metaMediaIds ?? {}) as Record<string, { id: string; uploadedAt: string }>;
    const cached = cache[number.phoneNumberId];
    if (cached && Date.now() - Date.parse(cached.uploadedAt) < META_MEDIA_TTL_MS) return cached.id;

    const file = await this.storage.getBuffer(asset.storageKey);
    const filename = asset.storageKey.split('/').pop() ?? 'media';
    const { id } = await this.meta.uploadMedia(this.numbers.token(number), number.phoneNumberId, file, asset.mimeType, filename);
    cache[number.phoneNumberId] = { id, uploadedAt: new Date().toISOString() };
    await this.prisma.mediaAsset.update({ where: { id: assetId }, data: { metaMediaIds: cache as Prisma.InputJsonValue } });
    return id;
  }
}
