import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ITEM_INCLUDE, SUMMARY_INCLUDE, toItemDto, toSummaryDto, type ConversationRow } from '../conversations/conversation-views.js';
import type { ConversationState } from '../inbox-common.js';
import { InboxEventsService } from './inbox-events.service.js';

/** Visibility facts of a chat before a change (realtime-events.md rule 1). */
export interface PreviousFacts {
  state: ConversationState;
  intervenedById: string | null;
  blocked: boolean;
}

/**
 * Builds live chat events from the database and publishes them (contracts/realtime-events.md).
 * Call after the change has committed. Event data never holds the customer's phone number:
 * clients refetch over REST, where masking applies.
 */
@Injectable()
export class InboxPublisher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InboxEventsService,
  ) {}

  /** conversation.upserted; pass the facts before the change when visibility may have changed. */
  async conversation(conversationId: string, prev?: PreviousFacts): Promise<void> {
    const row = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: SUMMARY_INCLUDE });
    if (!row) return;
    const { phone: _phone, unread: _unread, ...summary } = toSummaryDto(row, 0);
    await this.events.publish({ type: 'conversation.upserted', ...facts(row), ...(prev ? { prev } : {}), data: { ...summary } });
  }

  /** conversation.window_closed: the chat moves from the live tabs to Past chats (SC-005). */
  async windowClosed(conversationId: string): Promise<void> {
    const row = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: SUMMARY_INCLUDE });
    if (!row) return;
    await this.events.publish({ type: 'conversation.window_closed', ...facts(row), data: { conversationId: row.id } });
  }

  /** message.created (or note.created) with the full timeline item. */
  async itemCreated(itemId: string, mentions?: string[]): Promise<void> {
    const found = await this.prisma.chatMessage.findUnique({ where: { id: itemId }, include: { ...ITEM_INCLUDE, conversation: { include: SUMMARY_INCLUDE } } });
    if (!found) return;
    const { conversation, ...item } = found;
    await this.events.publish({
      type: item.kind === 'NOTE' ? 'note.created' : 'message.created',
      ...facts(conversation),
      data: { conversationId: conversation.id, item: { ...toItemDto(item) }, ...(mentions ? { mentions } : {}) },
    });
  }

  /** message.status: a tick changed, a reply failed, or inbound media became ready or failed. */
  async itemStatus(itemId: string): Promise<void> {
    const found = await this.prisma.chatMessage.findUnique({ where: { id: itemId }, include: { ...ITEM_INCLUDE, conversation: { include: SUMMARY_INCLUDE } } });
    if (!found) return;
    const { conversation, ...item } = found;
    const dto = toItemDto(item);
    await this.events.publish({
      type: 'message.status',
      ...facts(conversation),
      data: { conversationId: conversation.id, itemId: item.id, status: dto.status, failureReason: dto.failureReason, mediaState: dto.media?.state ?? null },
    });
  }
}

function facts(row: ConversationRow) {
  return {
    conversationId: row.id,
    numberId: row.numberId,
    contactId: row.contactId,
    state: row.state,
    intervenedById: row.intervenedById,
    blocked: row.contact?.blockedAt != null,
  };
}
