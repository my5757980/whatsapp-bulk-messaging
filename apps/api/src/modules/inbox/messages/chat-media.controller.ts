import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

/** Shown in the page; anything else downloads, so uploaded files never render as documents. */
const INLINE_TYPES = /^(image|video|audio)\//;

/**
 * Serves stored chat media to members (T034, research R4): never a storage URL, always behind the
 * session and, for customer media, the chat's visibility rules.
 */
@Controller('inbox')
export class ChatMediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly conversations: ConversationsService,
  ) {}

  @Get('media/:id')
  @Require('inbox.view')
  async media(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset || (asset.purpose !== 'INBOUND' && asset.purpose !== 'LIBRARY')) throw AppError.notFound('File not found');
    if (asset.purpose === 'INBOUND') {
      const item = await this.prisma.chatMessage.findFirst({ where: { mediaAssetId: id }, select: { conversationId: true } });
      if (!item) throw AppError.notFound('File not found');
      await this.conversations.loadVisible({ id: user.id, role: user.role }, item.conversationId);
    }
    const stream = await this.storage.getStream(asset.storageKey);
    const fileName = (asset.displayName ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.sizeBytes),
      'Content-Disposition': `${INLINE_TYPES.test(asset.mimeType) ? 'inline' : 'attachment'}; filename="${fileName}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
