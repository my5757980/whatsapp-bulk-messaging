import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { ChatContentType, ConversationState } from '../../../generated/prisma/client.js';
import { aiTurnJob } from '../ai-jobs.js';
import { AgentSelector } from './agent-selector.js';
import { AiConversationsService } from './ai-conversations.service.js';

/** What the 002 inbound handler knows about a stored customer message. */
export interface AiInboundMessage {
  /** The stored chat item, flagged as waiting for the agent's reply. */
  messageId: string;
  conversationId: string;
  numberId: string;
  contactId: string;
  senderPhone: string;
  chatState: ConversationState;
  optOutKeyword: boolean;
  humanKeyword: boolean;
  newChat: boolean;
  contentType: ChatContentType;
  text: string | null;
}

/**
 * Decides whether an AI agent answers a customer message (research R5, T042). It runs after the
 * flow router and before welcome and off-hours messages; when it queues a turn it returns true and
 * those automatic replies are skipped (FR-021). Opt-out and "talk to a person" keywords are left to
 * the 001/002 rules (FR-025, FR-027); only Open chats of contacts who may be answered qualify (FR-016).
 */
@Injectable()
export class AiAgentRouter {
  private readonly logger = new Logger(AiAgentRouter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly selector: AgentSelector,
    private readonly queues: QueueRegistry,
    private readonly conversations: AiConversationsService,
  ) {}

  /**
   * An opt-out keyword (the 001 consent rules recorded it): the agent stops in this chat (FR-027).
   * The inbound handler calls this before the flow router, which answers opt-outs itself.
   */
  async onOptOut(conversationId: string): Promise<void> {
    await this.conversations.endForConversation(conversationId, 'OPTED_OUT');
  }

  async onCustomerMessage(message: AiInboundMessage): Promise<boolean> {
    if (message.optOutKeyword || message.humanKeyword || message.chatState !== 'ACTIVE') return false;
    // A reaction is not a message to answer.
    if (message.contentType === 'REACTION') return false;
    const contact = await this.prisma.contact.findUnique({ where: { id: message.contactId }, select: { blockedAt: true, consentStatus: true } });
    if (!contact || contact.blockedAt || contact.consentStatus === 'OPTED_OUT') return false;
    const agent = await this.selector.select({ id: message.conversationId, numberId: message.numberId }, message.senderPhone);
    if (!agent) return false;
    try {
      // The turn answers every flagged message of the chat at once (research R5).
      await this.prisma.chatMessage.update({ where: { id: message.messageId }, data: { aiPending: true } });
      const job = aiTurnJob(message.conversationId);
      await this.queues.get(QUEUES.AI).add(job.name, job.data, job.opts);
      return true;
    } catch (error) {
      // Without a queued turn the 002 automatic replies still answer.
      this.logger.error({ err: (error as Error).message, conversationId: message.conversationId }, 'Could not queue an AI turn');
      await this.prisma.chatMessage.updateMany({ where: { id: message.messageId }, data: { aiPending: false } }).catch(() => undefined);
      return false;
    }
  }
}
