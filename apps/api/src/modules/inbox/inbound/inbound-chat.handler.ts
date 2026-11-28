import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { CHAT_ORDERS, type ChatOrdersPort } from './chat-orders.port.js';
import { FORM_ANSWERS, type FormAnswersPort } from './form-answers.port.js';
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
import { DripLeaving } from '../../growth/drips/drip-leaving.js';
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
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { CodService } from '../../integrations/stores/cod.service.js';
import { AdChatMatcher } from '../../ads/chats/ad-chat-matcher.js';
import { ChatLinkMatcher } from '../../integrations/chat-links/chat-link-matcher.js';
import { parseInboundMessage, previewOf, type ParsedInbound } from './message-parser.js';
import { stopContactCarts } from '../../integrations/stores/store-carts.js';
import { leadSourceFor } from '../../contacts/lead-source.js';
import { REPLY_WINDOW_HOURS } from '../../campaigns/replied.sql.js';
import { AutoTagService } from '../../contacts/auto-tags.service.js';

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
    private readonly drips: DripLeaving,
    private readonly platformEvents: PlatformEvents,
    private readonly cod: CodService,
    private readonly chatLinks: ChatLinkMatcher,
    private readonly adChats: AdChatMatcher,
    private readonly autoTags: AutoTagService,
    @Optional() @Inject(CHAT_ORDERS) private readonly chatOrders?: ChatOrdersPort,
    @Optional() @Inject(FORM_ANSWERS) private readonly formAnswers?: FormAnswersPort,
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
      create: { phoneE164: phone.e164, countryCode: phone.country, name: msg.profileName?.slice(0, 120) ?? null, ...leadSourceFor('ORGANIC') },
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
      // Writing to a drip's number ends that drip for the contact when its reply rule is on (005 FR-028).
      await this.drips.onEvent(contact.id, { kind: 'REPLIED', numberId }, tx);
      // A reply on a store's number stops that store's cart reminders for the contact (feature 006, FR-042).
      await stopContactCarts(tx, contact.id, 'replied', numberId);
      // Automatic tags for campaign replies (feature 010, R4), only when a rule listens.
      if (await this.autoTags.listens('CAMPAIGN_REPLY')) {
        const replied = await tx.$queryRaw<Array<{ one: number }>>`
          SELECT 1 AS one FROM messages m
           WHERE m.contact_id = ${contact.id}::uuid AND m.number_id = ${numberId}::uuid AND m.origin = 'CAMPAIGN'
             AND m.status IN ('DELIVERED', 'READ')
             AND COALESCE(m.delivered_at, m.read_at) BETWEEN ${msg.occurredAt}::timestamptz - make_interval(hours => ${REPLY_WINDOW_HOURS}) AND ${msg.occurredAt}::timestamptz
           LIMIT 1`;
        if (replied.length) await this.autoTags.apply(tx, 'CAMPAIGN_REPLY', contact.id);
      }
      // Outbound webhooks (feature 006, FR-002); text is removed later for endpoints that chose so.
      const buttonPayload = typeof msg.payload.payload === 'string' ? msg.payload.payload : typeof msg.payload.id === 'string' ? msg.payload.id : null;
      await this.platformEvents.messageReceived(tx, {
        chatMessageId: itemId,
        waMessageId: msg.waMessageId,
        conversationId: chat.id,
        numberId,
        contactId: contact.id,
        type: msg.contentType.toLowerCase(),
        text: msg.media ? null : msg.text,
        caption: msg.media ? msg.text : null,
        buttonPayload,
        at: msg.occurredAt,
      });

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
    // COD answers (feature 006 US5): a cod1: button tap is answered here, before flows and the AI agent.
    const tappedPayload = typeof msg.payload.payload === 'string' ? msg.payload.payload : null;
    if (tappedPayload && (await this.cod.handleButton(tappedPayload, { conversationId: outcome.conversationId, contactId: contact.id }))) return;
    // Answers to our WhatsApp Forms (feature 008 US7); a reply without our token stays a plain FORM_REPLY.
    if (msg.contentType === 'FORM_REPLY' && this.formAnswers) {
      if (await this.formAnswers.received({ conversationId: outcome.conversationId, contactId: contact.id, chatItemId: itemId, payload: msg.payload })) return;
    }
    // Carts sent in chat (feature 008 US6) become chat orders; flows and the AI agent do not answer them.
    if (msg.contentType === 'ORDER' && this.chatOrders) {
      await this.chatOrders.received({ conversationId: outcome.conversationId, contactId: contact.id, numberId, chatItemId: itemId, text: msg.text, payload: msg.payload });
      return;
    }
    // Chats from ads (feature 007 US3): the referral names the ad; its campaign tags the contact and its flow
    // answers before chat links, keyword flows and the AI agent, unless a flow runs or a member has the chat.
    if (
      msg.adReferral &&
      (await this.adChats.onAdMessage({
        numberId,
        conversationId: outcome.conversationId,
        contactId: contact.id,
        waMessageId: msg.waMessageId,
        chatState: outcome.state,
        referral: msg.adReferral,
        occurredAt: msg.occurredAt,
      }))
    ) {
      return;
    }
    // Chat links (feature 006 US7): the pre-filled message counts for its link and tags the contact; the link's
    // flow answers it before keyword flows and the AI agent, unless a flow runs or a member has the chat.
    if (
      await this.chatLinks.onCustomerMessage({
        numberId,
        conversationId: outcome.conversationId,
        contactId: contact.id,
        waMessageId: msg.waMessageId,
        chatState: outcome.state,
        text: msg.text,
      })
    ) {
      return;
    }
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
