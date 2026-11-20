import { Injectable } from '@nestjs/common';
import type { ChatContentType, ConversationState } from '../../../generated/prisma/client.js';

/** What the 002 inbound handler knows about a stored customer message. */
export interface AiInboundMessage {
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
 * Decides whether an AI agent answers a customer message (research R5, T020). It runs after the
 * flow router and before welcome and off-hours messages; when it queues a turn it returns true and
 * those automatic replies are skipped (FR-021). Eligibility and queueing arrive with US1.
 */
@Injectable()
export class AiAgentRouter {
  async onCustomerMessage(_message: AiInboundMessage): Promise<boolean> {
    return false;
  }
}
