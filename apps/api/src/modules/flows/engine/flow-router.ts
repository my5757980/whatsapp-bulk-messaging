import { Injectable, Logger } from '@nestjs/common';
import { FlowSessionService } from './session.service.js';
import { TriggerMatcher } from './trigger-matcher.js';

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
 * Routes a customer message to chatbot flows (003 research R5, T012, T025), in this order: opt-out
 * ends any session with no reply; "talk to a person" ends it (002 then moves the chat to Waiting
 * for agent); opt-in keywords are left to 001; a running session takes the message, unless a "can
 * interrupt" trigger replaces it (FR-022); an Open chat may start a flow from a trigger. Returns true
 * when a flow answered, so the 002 welcome and off-hours messages are skipped (FR-029).
 */
@Injectable()
export class FlowRouter {
  private readonly logger = new Logger(FlowRouter.name);

  constructor(
    private readonly sessions: FlowSessionService,
    private readonly matcher: TriggerMatcher,
  ) {}

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

      const input = { kind: 'message' as const, text: ctx.message.text, replyId: ctx.message.replyId, contentType: ctx.message.contentType };
      const running = await this.sessions.runningSession(ctx.conversationId);
      if (running) {
        // Waiting for agent or Taken: only a session a member started keeps answering (FR-025).
        if (ctx.chatState !== 'ACTIVE' && running.startedBy !== 'MEMBER') return false;
        if (ctx.chatState === 'ACTIVE' && !ctx.message.replyId) {
          const interrupt = await this.matcher.keyword(ctx.numberId, ctx.message.text, { interruptingOnly: true });
          if (interrupt && interrupt.flowId !== running.flowId) {
            const started = await this.sessions.start({ flowId: interrupt.flowId, versionId: interrupt.versionId, conversationId: ctx.conversationId, startedBy: 'TRIGGER', triggerKey: interrupt.triggerKey, replaceRunning: 'INTERRUPTED' });
            if (started.started) return true;
          }
        }
        return await this.sessions.continueWith(ctx.conversationId, input, { memberStartedOnly: ctx.chatState !== 'ACTIVE' });
      }
      if (ctx.chatState !== 'ACTIVE') return false;
      return await this.startFromTriggers(ctx, input);
    } catch (error) {
      // A flow problem must never stop live chat from storing and showing the message.
      this.logger.error({ err: (error as Error).message, conversationId: ctx.conversationId }, 'Flow routing failed');
      return false;
    }
  }

  /** Keyword triggers (US1); patterns, template buttons and first-message rules arrive with US6. */
  protected async startFromTriggers(ctx: CustomerMessageContext, input: { kind: 'message'; text: string | null; replyId: string | null; contentType: string }): Promise<boolean> {
    const match = await this.matcher.keyword(ctx.numberId, ctx.message.text);
    if (!match) return false;
    const outcome = await this.sessions.start({ flowId: match.flowId, versionId: match.versionId, conversationId: ctx.conversationId, startedBy: 'TRIGGER', triggerKey: match.triggerKey });
    if (outcome.started) return true;
    // Another message started a session a moment ago: this one is its input.
    if (outcome.reason === 'busy') return this.sessions.continueWith(ctx.conversationId, input);
    return false;
  }
}
