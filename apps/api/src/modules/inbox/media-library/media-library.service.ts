import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { chatMediaKind, checkChatMedia, CHAT_MEDIA_LIMITS, type ChatMediaKind } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AuditService } from '../../audit/audit.service.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import { MB, type UploadedFileData } from '../../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { MediaAsset } from '../../../generated/prisma/client.js';

export const MediaListQuerySchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;

const UploadBodySchema = z.object({ displayName: z.string().trim().max(240).optional() });

type AssetWithUploader = MediaAsset & { uploadedBy: { id: string; name: string } | null };

function toItem(asset: AssetWithUploader) {
  return {
    id: asset.id,
    displayName: asset.displayName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    kind: chatMediaKind(asset.mimeType) ?? 'document',
    uploadedBy: asset.uploadedBy,
    createdAt: asset.createdAt.toISOString(),
  };
}

/** MIME types of a kind, for filtering the library list. */
const typesOf = (kind: ChatMediaKind) => [...CHAT_MEDIA_LIMITS[kind].types];

/**
 * The media library (T064, FR-032): files uploaded once and reused in chats and saved replies.
 * Removing an item hides it from the library; chats that already sent it keep their copy.
 */
@Injectable()
export class MediaLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async list(query: MediaListQuery) {
    const where = {
      purpose: 'LIBRARY' as const,
      removedAt: null,
      ...(query.kind ? { OR: typesOf(query.kind).map((t) => ({ mimeType: { startsWith: t } })) } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.mediaAsset.count({ where }),
      this.prisma.mediaAsset.findMany({
        where,
        include: { uploadedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toItem), page: { page: query.page, pageSize: query.pageSize, total } };
  }

  async upload(file: UploadedFileData | undefined, displayName: string | undefined, userId: string) {
    if (!file?.size) throw AppError.validation('Choose a file to upload', [{ field: 'file', issue: 'is required' }]);
    const check = checkChatMedia(file.mimetype, file.size);
    if (!check.ok) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, check.code, check.message);
    const storageKey = `media/library/${uuidv7()}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    const asset = await this.prisma.mediaAsset.create({
      data: {
        storageKey,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        purpose: 'LIBRARY',
        displayName: (displayName || file.originalname || 'file').slice(0, 240),
        uploadedById: userId,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return toItem(asset);
  }

  /** Library media usable in a send; refuses removed or non-library files. */
  async usable(id: string): Promise<MediaAsset> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.purpose !== 'LIBRARY' || asset.removedAt) {
      throw AppError.validation('Choose a file from the media library', [{ field: 'mediaAssetId', issue: 'is not a library file' }]);
    }
    return asset;
  }

  async remove(id: string, actorId: string, ip: string | null = null): Promise<void> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id }, select: { purpose: true, removedAt: true, storageKey: true, mimeType: true, sizeBytes: true } });
    if (!asset || asset.purpose !== 'LIBRARY' || asset.removedAt) throw AppError.notFound('File not found');
    const inUse = (await this.prisma.chatMessage.count({ where: { mediaAssetId: id } })) + (await this.prisma.cannedMessage.count({ where: { mediaAssetId: id } }));
    await this.audit.record({ userId: actorId, ip }, 'media.removed', { type: 'media_asset', id }, { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, keptForChats: inUse > 0 });
    if (inUse) {
      await this.prisma.mediaAsset.update({ where: { id }, data: { removedAt: new Date() } });
      return;
    }
    await this.prisma.mediaAsset.delete({ where: { id } });
    await this.storage.delete(asset.storageKey).catch(() => undefined);
  }
}

/** /media-library (contracts/inbox-api.openapi.yaml). */
@Controller('media-library')
export class MediaLibraryController {
  constructor(private readonly library: MediaLibraryService) {}

  @Get()
  @Require('inbox.view')
  list(@Query(new ZodValidationPipe(MediaListQuerySchema)) query: MediaListQuery) {
    return this.library.list(query);
  }

  @Post()
  @Require('inbox.reply')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * MB + 1, files: 1 } }))
  upload(@CurrentUser() user: RequestUser, @UploadedFile() file: UploadedFileData | undefined, @Body(new ZodValidationPipe(UploadBodySchema)) body: { displayName?: string }) {
    return this.library.upload(file, body.displayName, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('media.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null): Promise<void> {
    await this.library.remove(id, user.id, ip);
  }
}
