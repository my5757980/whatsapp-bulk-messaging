import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { normalizePhone, waIdToE164 } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { SettingsService } from '../../settings/settings.service.js';
import { normalizeKeyword } from '../../webhooks/handlers/inbound.handler.js';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../../webhooks/webhook-router.js';
import { AiAgentRouter } from '../../ai/turns/ai-router.js';
import { FlowRouter } from '../../flows/engine/flow-router.js';
import { AutoRepliesService } from '../automation/auto-replies.service.js';
import { InboxNotifier } from '../notifications/inbox-notifier.js';
import { onCustomerMessage } from '../conversations/conversation-state.js';
import { isLive, startsOpening } from '../conversations/window.js';
import type { ConversationState } from '../inbox-common.js';
import { INBOX_QUEUE, inboundMediaJob } from '../inbox-queue.js';
import { ChatTimelineService } from '../messages/chat-timeline.service.js';
import { InboxPublisher, type PreviousFacts } from '../realtime/inbox-publisher.js';
import { ChatRoutingService } from '../routing/chat-routing.service.js';
import { LiveChatSettingsService } from '../settings/live-chat-settings.service.js';
import { parseInboundMessage, previewOf, type ParsedInbound } from './message-parser.js';

interface LockedChat {
  id: string;
  state: ConversationState;
  intervened_by_id: string | null;
  last_customer_message_at: Date | null;
}

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Customer messages into live chat (T027; contracts/meta-graph-inbox.md §1 processing order).
 * Runs after the 001 consent handler, which has already applied STOP/START and created the
 * contact. Each message is stored once (unique wamid), so repeated webhooks add nothing.
 */
@Injectable()
export class InboundChatHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'messages';
  readonly order = 10;
  private readonly logger = new Logger(InboundChatHandler.name);

  constructor(
    private readonly router: WebhookRouter,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly timeline: ChatTimelineService,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
    private readonly liveChat: LiveChatSettingsService,
    private readonly routing: ChatRoutingService,
    private readonly autoReplies: AutoRepliesService,
    private readonly notifier: InboxNotifier,
    private readonly metrics: MetricsService,
    private readonly flows: FlowRouter,
    private readonly aiAgents: AiAgentRouter,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    const messages = Array.isArray(change.value.messages) ? change.value.messages : [];
    if (!messages.length) return;
    const phoneNumberId = obj(change.value.metadata)?.phone_number_id;
    if (typeof phoneNumberId !== 'string') return;
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { phoneNumberId }, select: { id: true } });
    if (!number) {
      this.logger.warn({ phoneNumberId }, 'Customer message for an unknown number; not added to live chat');
      return;
    }
    const { defaultCountryCode, optOutKeywords, optInKeywords } = await this.settings.get();
    // Read fresh for every webhook (one row): a cache in the worker would miss changes made in the app.
    const { humanKeywords } = await this.liveChat.get();
    for (const raw of messages) {
      const parsed = parseInboundMessage(raw, change.value.contacts);
      if (!parsed) {
        this.logger.warn({ phoneNumberId }, 'Skipped a malformed customer message');
        continue;
      }
      // Text, button and list replies can carry a "talk to a person" keyword (research R13).
      const normalized = parsed.text !== null ? normalizeKeyword(parsed.text) : null;
      const humanKeyword = normalized !== null && humanKeywords.includes(normalized);
      // Opt-out and opt-in keywords never get an automatic reply either (FR-036).
      const optOutKeyword = normalized !== null && optOutKeywords.includes(normalized);
      const consentKeyword = optOutKeyword || (normalized !== null && optInKeywords.includes(normalized));
      await this.store(number.id, parsed, defaultCountryCode, humanKeyword, consentKeyword, optOutKeyword);
    }
  }

  private async store(numberId: string, msg: ParsedInbound, defaultCountry: string, humanKeyword: boolean, consentKeyword: boolean, optOutKeyword: boolean): Promise<void> {
    const phone = normalizePhone(waIdToE164(msg.waId), defaultCountry);
    if (!phone) {
      this.logger.warn({ numberId }, 'Customer message from a number that cannot be normalised; not added to live chat');
      return;
    }
    const contact = await this.prisma.contact.upsert({
      where: { phoneE164: phone.e164 },
      create: { phoneE164: phone.e164, countryCode: phone.country, name: msg.profileName?.slice(0, 120) ?? null, leadSource: 'Organic' },
      update: {},
      select: { id: true, blockedAt: true },
    });

    const itemId = uuidv7();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const lock = () => tx.$queryRaw<LockedChat[]>`
        SELECT id, state, intervened_by_id, last_customer_message_at FROM conversations
         WHERE contact_id = ${contact.id}::uuid AND number_id = ${numberId}::uuid FOR UPDATE`;
      let [chat] = await lock();
      let created = false;
      if (!chat) {
        // Two first messages at once: one insert wins, the other waits and then locks that row.
        created =
          (await tx.$executeRaw`
            INSERT INTO conversations (id, contact_id, number_id, state, last_activity_at, unresolved_requests, created_at, updated_at)
            VALUES (${uuidv7()}::uuid, ${contact.id}::uuid, ${numberId}::uuid, 'ACTIVE', ${msg.occurredAt}, 0, now(), now())
            ON CONFLICT (contact_id, number_id) DO NOTHING`) > 0;
        [chat] = await lock();
      }
      if (!chat) throw new Error('Could not create or lock the chat');

      const inserted = await tx.$executeRaw`
        INSERT INTO chat_messages (id, conversation_id, kind, origin, content_type, text, payload, media_state, wa_message_id,
                                   reply_to_wa_id, occurred_at, attempts, created_at, updated_at)
        VALUES (${itemId}::uuid, ${chat.id}::uuid, 'INBOUND', 'CUSTOMER', ${msg.contentType}::"ChatContentType", ${msg.text},
                ${JSON.stringify(msg.payload)}::jsonb, ${msg.media ? 'PENDING' : null}::"MediaState", ${msg.waMessageId},
                ${msg.replyToWaId}, ${msg.occurredAt}, 0, now(), now())
        ON CONFLICT (wa_message_id) DO NOTHING`;
      if (!inserted) return null; // a repeated webhook

      const previous: PreviousFacts = { state: chat.state, intervenedById: chat.intervened_by_id, blocked: contact.blockedAt !== null };
      const { next, countRequest, becameRequesting } = onCustomerMessage(created ? null : { state: chat.state, intervenedById: chat.intervened_by_id }, {
        humanKeyword,
        windowWasOpen: isLive(chat.last_customer_message_at, msg.occurredAt),
      });
      if (becameRequesting) {
        await tx.conversationEvent.create({ data: { conversationId: chat.id, type: 'REQUESTED', actorType: 'CUSTOMER', occurredAt: msg.occurredAt } });
      }
      const preview = previewOf(msg);
      // SET expressions see the old row, so the preview only changes for the newest message.
      await tx.$executeRaw`
        UPDATE conversations
           SET state = ${next.state}::"ConversationState",
               intervened_by_id = ${next.intervenedById}::uuid,
               intervened_at = CASE WHEN ${next.state} = 'INTERVENED' THEN intervened_at ELSE NULL END,
               last_customer_message_at = GREATEST(last_customer_message_at, ${msg.occurredAt}),
               last_inbound_at = GREATEST(last_inbound_at, ${msg.occurredAt}),
               last_message_preview = CASE WHEN ${msg.occurredAt} >= last_activity_at THEN ${preview} ELSE last_message_preview END,
               last_activity_at = GREATEST(last_activity_at, ${msg.occurredAt}),
               unresolved_requests = unresolved_requests + ${countRequest ? 1 : 0},
               updated_at = now()
         WHERE id = ${chat.id}::uuid`;
      const newOpening = startsOpening(chat.last_customer_message_at, msg.occurredAt);
      if (newOpening) await tx.conversationOpening.create({ data: { conversationId: chat.id, openedAt: msg.occurredAt } });
      if (created) await this.timeline.backfill(tx, chat.id, contact.id, numberId);
      return { conversationId: chat.id, created, previous, becameRequesting, newOpening, state: next.state };
    });
    if (!outcome) return;
    this.metrics.inboxMessagesTotal.inc({ direction: 'in', kind: msg.contentType.toLowerCase() });

    if (msg.media) await this.queueMediaDownload(itemId, msg.media.metaMediaId);
    // Blocked contacts' messages are kept, without live events, alerts or automatic replies (FR-034).
    if (contact.blockedAt) return;
    await this.publisher.itemCreated(itemId);
    await this.publisher.conversation(outcome.conversationId, outcome.created ? undefined : outcome.previous);
    // A chat that starts waiting for an agent gets that alert instead of a new-message alert.
    if (outcome.becameRequesting) await this.routing.alertRequesting(outcome.conversationId);
    else await this.notifier.queue({ kind: 'message', conversationId: outcome.conversationId, itemId });
    // An opt-out stops the AI agent at once; the flow router below ends flows and answers it (004 FR-027).
    if (optOutKeyword) await this.aiAgents.onOptOut(outcome.conversationId);
    // Chatbot flows answer first (003 research R5); a flow answer replaces welcome/off-hours (FR-029).
    const flowAnswered = await this.flows.onCustomerMessage({
      conversationId: outcome.conversationId,
      numberId,
      contactId: contact.id,
      senderPhone: phone.e164,
      chatState: outcome.state,
      optOutKeyword,
      optInKeyword: consentKeyword && !optOutKeyword,
      humanKeyword,
      newChat: outcome.created,
      message: { contentType: msg.contentType, text: msg.text, replyId: typeof msg.payload.id === 'string' ? msg.payload.id : null, replyToWaId: msg.replyToWaId },
    });
    if (flowAnswered) return;
    // AI agents answer what flows left (004 research R5); a queued AI turn replaces welcome/off-hours (FR-021).
    const aiQueued = await this.aiAgents.onCustomerMessage({
      messageId: itemId,
      conversationId: outcome.conversationId,
      numberId,
      contactId: contact.id,
      senderPhone: phone.e164,
      chatState: outcome.state,
      optOutKeyword,
      humanKeyword,
      newChat: outcome.created,
      contentType: msg.contentType,
      text: msg.text,
    });
    if (aiQueued) return;
    await this.autoReplies.handle({
      conversationId: outcome.conversationId,
      contactId: contact.id,
      newOpening: outcome.newOpening,
      keyword: humanKeyword || consentKeyword,
    });
  }

  private async queueMediaDownload(chatMessageId: string, metaMediaId: string): Promise<void> {
    try {
      const job = inboundMediaJob({ chatMessageId, metaMediaId });
      await this.queues.get(INBOX_QUEUE).add(job.name, job.data, job.opts);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, chatMessageId }, 'Could not queue a media download');
      await this.prisma.chatMessage.updateMany({ where: { id: chatMessageId, mediaState: 'PENDING' }, data: { mediaState: 'FAILED' } });
    }
  }
}
