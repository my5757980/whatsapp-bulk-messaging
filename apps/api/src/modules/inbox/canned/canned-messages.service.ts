import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { parameterCount } from './canned-render.js';

/** At most this many saved replies (FR-030). */
export const MAX_CANNED_MESSAGES = 200;

export const CannedInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['TEXT', 'MEDIA']),
    text: z.string().max(4096).optional(),
    variableFallbacks: z.record(z.string(), z.string().max(200)).default({}),
    mediaAssetId: z.uuid().optional(),
    mediaUrl: z.url().regex(/^https:\/\//, 'must be an https link').optional(),
    fileName: z.string().max(240).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'TEXT' && !value.text?.trim()) ctx.addIssue({ code: 'custom', path: ['text'], message: 'is required for a text reply' });
    if (value.type === 'MEDIA' && Boolean(value.mediaAssetId) === Boolean(value.mediaUrl)) {
      ctx.addIssue({ code: 'custom', path: ['mediaAssetId'], message: 'choose either a library file or a link' });
    }
  });
export type CannedInput = z.infer<typeof CannedInputSchema>;

export const CannedListQuerySchema = z.object({ q: z.string().trim().max(80).optional() });

const INCLUDE = (userId: string) =>
  ({ createdBy: { select: { id: true, name: true } }, favorites: { where: { userId }, select: { userId: true } } }) satisfies Prisma.CannedMessageInclude;
type Row = Prisma.CannedMessageGetPayload<{ include: ReturnType<typeof INCLUDE> }>;

function toDto(row: Row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ...(row.text !== null ? { text: row.text } : {}),
    variableFallbacks: (row.variableFallbacks ?? {}) as Record<string, string>,
    ...(row.mediaAssetId ? { mediaAssetId: row.mediaAssetId } : {}),
    ...(row.mediaUrl ? { mediaUrl: row.mediaUrl } : {}),
    ...(row.fileName ? { fileName: row.fileName } : {}),
    favorite: row.favorites.length > 0,
    parameterCount: parameterCount(row.text ?? ''),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Saved replies (T063, FR-030, FR-031): shared by the team, favourites per member. */
@Injectable()
export class CannedMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, q?: string) {
    const rows = await this.prisma.cannedMessage.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { text: { contains: q, mode: 'insensitive' } }] } : {},
      include: INCLUDE(userId),
      orderBy: { name: 'asc' },
    });
    return rows.map(toDto).sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }

  async get(id: string, userId: string) {
    const row = await this.prisma.cannedMessage.findUnique({ where: { id }, include: INCLUDE(userId) });
    if (!row) throw AppError.notFound('Saved reply not found');
    return row;
  }

  async create(input: CannedInput, actorId: string) {
    await this.assertMedia(input);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // Serialise creations so the limit holds under concurrent requests.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('canned_messages'))`;
        if ((await tx.cannedMessage.count()) >= MAX_CANNED_MESSAGES) {
          throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'LIMIT_REACHED', `You can keep at most ${MAX_CANNED_MESSAGES} saved replies`);
        }
        return tx.cannedMessage.create({ data: { ...this.data(input), createdById: actorId }, include: INCLUDE(actorId) });
      });
      return toDto(row);
    } catch (error) {
      throw this.nameTaken(error);
    }
  }

  async update(id: string, input: CannedInput, actorId: string) {
    await this.get(id, actorId);
    await this.assertMedia(input);
    try {
      return toDto(await this.prisma.cannedMessage.update({ where: { id }, data: this.data(input), include: INCLUDE(actorId) }));
    } catch (error) {
      throw this.nameTaken(error);
    }
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.cannedMessage.deleteMany({ where: { id } });
    if (!count) throw AppError.notFound('Saved reply not found');
  }

  async setFavorite(id: string, userId: string, favorite: boolean): Promise<void> {
    await this.get(id, userId);
    if (favorite) {
      await this.prisma.cannedMessageFavorite.upsert({ where: { userId_cannedMessageId: { userId, cannedMessageId: id } }, create: { userId, cannedMessageId: id }, update: {} });
    } else {
      await this.prisma.cannedMessageFavorite.deleteMany({ where: { userId, cannedMessageId: id } });
    }
  }

  private data(input: CannedInput) {
    return {
      name: input.name,
      type: input.type,
      text: input.text?.trim() ? input.text : null,
      variableFallbacks: input.variableFallbacks as Prisma.InputJsonValue,
      mediaAssetId: input.type === 'MEDIA' ? (input.mediaAssetId ?? null) : null,
      mediaUrl: input.type === 'MEDIA' ? (input.mediaUrl ?? null) : null,
      fileName: input.fileName ?? null,
    };
  }

  private async assertMedia(input: CannedInput): Promise<void> {
    if (input.type !== 'MEDIA' || !input.mediaAssetId) return;
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: input.mediaAssetId }, select: { purpose: true, removedAt: true } });
    if (!asset || asset.purpose !== 'LIBRARY' || asset.removedAt) {
      throw AppError.validation('Choose a file from the media library', [{ field: 'mediaAssetId', issue: 'is not a library file' }]);
    }
  }

  private nameTaken(error: unknown): unknown {
    return isUniqueViolation(error) ? AppError.conflict('A saved reply with this name already exists', 'NAME_TAKEN') : error;
  }
}

/** /canned-messages (contracts/inbox-api.openapi.yaml). */
@Controller('canned-messages')
export class CannedMessagesController {
  constructor(private readonly canned: CannedMessagesService) {}

  @Get()
  @Require('inbox.view')
  list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(CannedListQuerySchema)) query: { q?: string }) {
    return this.canned.list(user.id, query.q);
  }

  @Post()
  @Require('canned.manage')
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(CannedInputSchema)) body: CannedInput) {
    return this.canned.create(body, user.id);
  }

  @Patch(':id')
  @Require('canned.manage')
  update(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CannedInputSchema)) body: CannedInput) {
    return this.canned.update(id, body, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('canned.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.canned.remove(id);
  }

  @Put(':id/favorite')
  @HttpCode(204)
  @Require('inbox.view')
  async favorite(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.canned.setFavorite(id, user.id, true);
  }

  @Delete(':id/favorite')
  @HttpCode(204)
  @Require('inbox.view')
  async unfavorite(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.canned.setFavorite(id, user.id, false);
  }
}
