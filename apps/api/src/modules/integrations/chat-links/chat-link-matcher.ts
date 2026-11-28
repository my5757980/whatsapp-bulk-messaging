import { Inject, Injectable, Logger } from '@nestjs/common';
import { findChatRef } from '@wbm/shared';
import { ruleLabel, type StoredRule } from '../chat-widgets/chat-widgets.service.js';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { FlowSessionService } from '../../flows/engine/session.service.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { newContactKey } from '../../webhooks/handlers/inbound.handler.js';
import { PlatformEvents } from '../webhooks/platform-events.js';

export interface ChatLinkMessage {
  numberId: string;
  conversationId: string;
  contactId: string;
  /** The message id; the 001 inbound handler flags messages that created their contact. */
  waMessageId: string;
  /** The chat's state after this message (002: ACTIVE = Open). */
  chatState: 'ACTIVE' | 'REQUESTING' | 'INTERVENED';
  text: string | null;
}

/**
 * The pre-filled message of a chat link (feature 006 US7, FR-048, research R12), called by the 002
 * inbound handler before the 003 flow router. The last "(ref XXXXXX)" names the link: the chat counts
 * as started for it (a contact once a day), the contact gets the link's tag, and the link's flow starts,
 * unless a flow is running or the chat is a member's. A message whose reference was edited, or that
 * names a link of another number or one turned off, is a normal customer message.
 */
@Injectable()
export class ChatLinkMatcher {
  private readonly logger = new Logger(ChatLinkMatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: FlowSessionService,
    private readonly journey: JourneyService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** True when the link's flow started and so answered the message. */
  async onCustomerMessage(msg: ChatLinkMessage): Promise<boolean> {
    const ref = findChatRef(msg.text);
    if (!ref) return false;
    try {
      const link = await this.prisma.chatLink.findUnique({
        where: { ref },
        select: {
          id: true,
          name: true,
          numberId: true,
          status: true,
          deletedAt: true,
          tagId: true,
          tag: { select: { name: true } },
          widgetRuleId: true,
          widget: { select: { rules: true } },
          flow: { select: { id: true, status: true, deletedAt: true, publishedVersionId: true, allNumbers: true, numbers: { where: { numberId: msg.numberId }, select: { numberId: true } } } },
        },
      });
      if (!link || link.deletedAt || link.status !== 'ACTIVE' || link.numberId !== msg.numberId) return false;
      const newContact = (await this.redis.exists(newContactKey(msg.waMessageId)).catch(() => 0)) > 0;

      const counted = await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO chat_link_starts (id, chat_link_id, contact_id, conversation_id, new_contact, started_at)
          VALUES (${uuidv7()}::uuid, ${link.id}::uuid, ${msg.contactId}::uuid, ${msg.conversationId}::uuid, ${newContact}, now())
          ON CONFLICT DO NOTHING`;
        if (link.tagId && link.tag) {
          const added = await tx.contactTag.createManyAndReturn({ data: [{ contactId: msg.contactId, tagId: link.tagId }], skipDuplicates: true, select: { contactId: true, tagId: true } });
          if (added.length) {
            // As with tags added by flows: drips that start on the tag, webhook endpoints and the journey.
            await this.dripEvents.recordTagAddedToMany(tx, added);
            await this.platformEvents.tagLinksChanged(tx, added);
            const chats = await tx.conversation.findMany({ where: { contactId: msg.contactId }, select: { id: true } });
            await tx.conversationEvent.createMany({ data: chats.map((c) => ({ conversationId: c.id, type: 'TAG_ADDED' as const, actorType: 'SYSTEM' as const, data: { tag: link.tag!.name, chatLinkName: link.name } })) });
          }
        }
        return inserted > 0;
      });
      if (counted) {
        // Feature 009: a website button's start reads "From the website button · {rule or Default}".
        const label = link.widget ? `From the website button · ${ruleLabel((link.widget.rules ?? []) as unknown as StoredRule[], link.widgetRuleId)}` : link.name;
        await this.journey.recordForContact(msg.contactId, { type: 'CHAT_LINK_STARTED', actorType: 'CUSTOMER', data: { chatLinkId: link.id, chatLinkName: label, newContact } });
      }

      const flow = link.flow;
      const runnable = flow && !flow.deletedAt && flow.status === 'PUBLISHED' && flow.publishedVersionId && (flow.allNumbers || flow.numbers.length > 0);
      if (!runnable || msg.chatState !== 'ACTIVE') return false;
      // A running session refuses the start ('busy'); the flow router then gives it this message.
      const outcome = await this.sessions.start({ flowId: flow.id, versionId: flow.publishedVersionId, conversationId: msg.conversationId, startedBy: 'TRIGGER', triggerKey: 'chat_link' });
      return outcome.started;
    } catch (error) {
      // A chat link problem never stops live chat, flows or the AI agent from handling the message.
      this.logger.error({ err: (error as Error).message, conversationId: msg.conversationId }, 'Chat link matching failed');
      return false;
    }
  }
}
