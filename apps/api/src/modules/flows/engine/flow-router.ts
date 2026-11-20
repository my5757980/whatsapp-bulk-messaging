import { Injectable, Logger } from '@nestjs/common';
import { FlowSessionService } from './session.service.js';

/** What the 002 inbound handler knows about a stored customer message. */
export interface CustomerMessageContext {
  conversationId: string;
  numberId: string;
  contactId: string;
  /** E.164 phone of the customer (test numbers, FR-034). */
  senderPhone: string;
  /** The chat's state after this message (002: ACTIVE = Open). */
  chatState: 'ACTIVE' | 'REQUESTING' | 'INTERVENED';
  optOutKeyword: boolean;
  optInKeyword: boolean;
  humanKeyword: boolean;
  /** A new chat on this number (first message from the contact here). */
  newChat: boolean;
  message: {
    contentType: string;
    text: string | null;
    /** Id of a tapped reply button or list row. */
    replyId: string | null;
    /** wamid the customer replied to (template quick replies carry it). */
    replyToWaId: string | null;
  };
}

/**
 * Routes a customer message to chatbot flows (003 research R5, T012), in this order: opt-out ends
 * any session with no reply; "talk to a person" ends it (002 then moves the chat to Waiting for
 * agent); opt-in keywords are left to 001; a running session takes the message as its input; an Open
 * chat may start a flow from a trigger. Returns true when a flow answered, so the 002 welcome and
 * off-hours messages are skipped (FR-029).
 */
@Injectable()
export class FlowRouter {
  private readonly logger = new Logger(FlowRouter.name);

  constructor(private readonly sessions: FlowSessionService) {}

  async onCustomerMessage(ctx: CustomerMessageContext): Promise<boolean> {
    try {
      if (ctx.optOutKeyword) {
        await this.sessions.endRunning(ctx.conversationId, 'OPTED_OUT');
        return true;
      }
      if (ctx.humanKeyword) {
        await this.sessions.endRunning(ctx.conversationId, 'HANDED_OVER');
        return false;
      }
      if (ctx.optInKeyword) return false;

      // Waiting for agent or Taken: only a session a member started keeps answering (FR-025).
      const continued = await this.sessions.continueWith(
        ctx.conversationId,
        { kind: 'message', text: ctx.message.text, replyId: ctx.message.replyId, contentType: ctx.message.contentType },
        { memberStartedOnly: ctx.chatState !== 'ACTIVE' },
      );
      if (continued) return true;
      if (ctx.chatState !== 'ACTIVE') return false;
      return await this.startFromTriggers(ctx);
    } catch (error) {
      // A flow problem must never stop live chat from storing and showing the message.
      this.logger.error({ err: (error as Error).message, conversationId: ctx.conversationId }, 'Flow routing failed');
      return false;
    }
  }

  /** Trigger matching arrives with US1 (keywords) and US6 (patterns, template buttons, first messages). */
  protected async startFromTriggers(ctx: CustomerMessageContext): Promise<boolean> {
    void ctx;
    return false;
  }
}
