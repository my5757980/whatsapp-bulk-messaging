import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** How a `messages` row shows in a chat: who sent the template. */
const REF_ORIGIN_SQL = Prisma.sql`CASE m.origin
  WHEN 'API' THEN 'API'::"ChatOrigin"
  WHEN 'INBOX' THEN (CASE WHEN m.automatic THEN 'AUTOMATIC' ELSE 'MEMBER' END)::"ChatOrigin"
  WHEN 'DRIP' THEN 'AUTOMATIC'::"ChatOrigin"
  WHEN 'STORE' THEN 'AUTOMATIC'::"ChatOrigin"
  ELSE 'CAMPAIGN'::"ChatOrigin" END`;

/**
 * Template messages in the chat timeline (research R2): `MESSAGE_REF` rows point at `messages`
 * (campaign, API and chat templates), so one table orders and pages the whole timeline.
 */
@Injectable()
export class ChatTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
  ) {}

  /**
   * For a new chat: references to the templates already sent to the contact on that number.
   * Runs inside the caller's transaction; idempotent (one reference per message).
   */
  async backfill(tx: Prisma.TransactionClient, conversationId: string, contactId: string, numberId: string): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO chat_messages (id, conversation_id, kind, origin, content_type, payload, message_id, occurred_at, attempts, created_at, updated_at)
      SELECT gen_random_uuid(), ${conversationId}::uuid, 'MESSAGE_REF'::"ChatItemKind", ${REF_ORIGIN_SQL}, 'TEMPLATE'::"ChatContentType",
             '{}'::jsonb, m.id, COALESCE(m.sent_at, m.failed_at, m.created_at), 0, now(), now()
        FROM messages m
       WHERE m.contact_id = ${contactId}::uuid AND m.number_id = ${numberId}::uuid
         AND m.status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
      ON CONFLICT (message_id) DO NOTHING`;
  }

  /**
   * Called once Meta accepted a template message: adds it to the contact's chat on that number,
   * when there is one. Chats that do not exist yet are back-filled when the customer writes.
   */
  async appendRef(messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, origin: true, contactId: true, numberId: true, sentAt: true, template: { select: { name: true } } },
    });
    if (!message?.contactId) return;
    const chat = await this.prisma.conversation.findUnique({
      where: { contactId_numberId: { contactId: message.contactId, numberId: message.numberId } },
      select: { id: true },
    });
    if (!chat) return;

    const id = uuidv7();
    const occurredAt = message.sentAt ?? new Date();
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO chat_messages (id, conversation_id, kind, origin, content_type, payload, message_id, occurred_at, attempts, created_at, updated_at)
      SELECT ${id}::uuid, ${chat.id}::uuid, 'MESSAGE_REF'::"ChatItemKind", ${REF_ORIGIN_SQL}, 'TEMPLATE'::"ChatContentType",
             '{}'::jsonb, m.id, ${occurredAt}, 0, now(), now()
        FROM messages m WHERE m.id = ${message.id}::uuid
      ON CONFLICT (message_id) DO NOTHING`;
    if (!inserted) return;

    // Templates a member sent move the chat up the list; broadcasts do not reorder every chat.
    if (message.origin === 'INBOX') {
      await this.prisma.$executeRaw`
        UPDATE conversations
           SET last_activity_at = GREATEST(last_activity_at, ${occurredAt}),
               last_message_preview = ${`Template: ${message.template.name}`.slice(0, 120)},
               updated_at = now()
         WHERE id = ${chat.id}::uuid`;
      await this.publisher.conversation(chat.id);
    }
    await this.publisher.itemCreated(id);
  }
}
