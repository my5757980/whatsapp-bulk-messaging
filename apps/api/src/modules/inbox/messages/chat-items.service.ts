import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { decodeCursor, encodeCursor, ITEM_INCLUDE, toItemDto } from '../conversations/conversation-views.js';
import type { Viewer } from '../conversations/visibility.js';

export const ItemsQuerySchema = z.object({
  before: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ItemsQuery = z.infer<typeof ItemsQuerySchema>;

/** The chat timeline, newest first, with keyset paging on (occurred_at, id) (T029, research R2). */
@Injectable()
export class ChatItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
  ) {}

  async list(viewer: Viewer, conversationId: string, query: ItemsQuery) {
    await this.conversations.loadVisible(viewer, conversationId);
    const before = decodeCursor(query.before);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationId,
        ...(before ? { OR: [{ occurredAt: { lt: before.at } }, { occurredAt: before.at, id: { lt: before.id } }] } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: ITEM_INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toItemDto),
      nextBefore: rows.length > query.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }
}
