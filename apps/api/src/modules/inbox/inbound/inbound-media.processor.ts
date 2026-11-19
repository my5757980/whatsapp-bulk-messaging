import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { MediaTooLargeError, MetaGraphClient } from '../../meta/meta-graph.client.js';
import { INBOUND_MEDIA_ATTEMPTS, type InboundMediaJobData } from '../inbox-queue.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** Meta's largest media type (documents); anything bigger is refused (research R4). */
export const MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;

export type InboundMediaOutcome = 'ready' | 'retry' | 'failed' | 'ignored';

/**
 * Keeps our own copy of media customers send (T028, research R4): Meta's download links expire,
 * so the file is fetched right away with the number's token and stored under media/inbound/.
 */
@Injectable()
export class InboundMediaProcessor {
  private readonly logger = new Logger(InboundMediaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly cipher: TokenCipher,
    private readonly storage: StorageService,
    private readonly publisher: InboxPublisher,
  ) {}

  async process(data: InboundMediaJobData, attempt: number): Promise<InboundMediaOutcome> {
    const item = await this.prisma.chatMessage.findUnique({
      where: { id: data.chatMessageId },
      select: { id: true, mediaState: true, payload: true, conversation: { select: { number: { select: { accessTokenEnc: true } } } } },
    });
    if (!item || item.mediaState !== 'PENDING') return 'ignored';
    const payload = (item.payload ?? {}) as Record<string, unknown>;

    try {
      const token = this.cipher.decrypt(item.conversation.number.accessTokenEnc);
      const info = await this.meta.getMedia(token, data.metaMediaId);
      if (info.fileSize !== undefined && info.fileSize > MAX_INBOUND_MEDIA_BYTES) throw new MediaTooLargeError(info.fileSize, MAX_INBOUND_MEDIA_BYTES);
      const bytes = await this.meta.downloadMedia(token, info.url, MAX_INBOUND_MEDIA_BYTES);
      const mimeType = info.mimeType ?? (typeof payload.mimeType === 'string' ? payload.mimeType : 'application/octet-stream');
      const storageKey = `media/inbound/${uuidv7()}`;
      await this.storage.put(storageKey, bytes, mimeType);
      await this.prisma.$transaction(async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            storageKey,
            mimeType,
            sizeBytes: bytes.length,
            purpose: 'INBOUND',
            displayName: typeof payload.fileName === 'string' ? payload.fileName.slice(0, 240) : null,
          },
        });
        await tx.chatMessage.updateMany({
          where: { id: item.id, mediaState: 'PENDING' },
          data: { mediaAssetId: asset.id, mediaState: 'READY', payload: { ...payload, mimeType, sizeBytes: bytes.length } as Prisma.InputJsonValue },
        });
      });
      await this.publisher.itemStatus(item.id);
      return 'ready';
    } catch (error) {
      const tooLarge = error instanceof MediaTooLargeError;
      this.logger.warn({ err: (error as Error).message, chatMessageId: item.id, attempt }, 'Inbound media download failed');
      if (!tooLarge && attempt < INBOUND_MEDIA_ATTEMPTS) return 'retry';
      await this.prisma.chatMessage.updateMany({ where: { id: item.id, mediaState: 'PENDING' }, data: { mediaState: 'FAILED' } });
      await this.publisher.itemStatus(item.id);
      return 'failed';
    }
  }
}
