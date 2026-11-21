import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_INTROS, looksSensitive, maskSensitive, type AgentConfig, type AgentReply, type TokenUsage } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { ConsentService } from '../../contacts/consent.service.js';
import { isLive } from '../../inbox/conversations/window.js';
import { writeAttributes } from '../../inbox/journey/attribute-writer.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { ChatRoutingService } from '../../inbox/routing/chat-routing.service.js';
import { requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import type { KnowledgeItem } from '../claude/prompt.js';
import type { PendingConfirmation, SkillCallRecord } from '../claude/skills.js';
import { UnansweredRecorder } from '../knowledge/unanswered-recorder.js';
import { AiUsageService, type UsageSettings } from '../usage/usage.service.js';
import type { SelectedAgent } from './agent-selector.js';
import { aiConversationLock, AiConversationsService } from './ai-conversations.service.js';
import { handOverNote, ineligibility, UNAVAILABLE_NOTE, type HandOver } from './decisions.js';
import { replyItems, type ReplyItem } from './reply-message.js';

type Tx = Prisma.TransactionClient;

/** What every outcome of a turn needs. */
export interface TurnBase {
  conversationId: string;
  numberId: string;
  contactId: string;
  agent: SelectedAgent;
  /** The waiting messages the turn read (research R5); the outcome covers them. */
  handledIds: string[];
  /** The first of them, where a new AI conversation starts (FR-019). */
  firstMessageAt: Date;
  startedAt: Date;
}

export interface ApplyInput extends TurnBase {
  /** Time of the newest customer message the reply covers. */
  handledUntil: Date;
  reply: AgentReply;
  /** The hand-over the reply leads to (decisions.ts), or null. */
  handOver: HandOver | null;
  /** The customer's words, kept (masked) with an AI opt-out (FR-027). */
  customerText: string;
  /** Knowledge the turn saw, to name the sources the reply used. */
  knownSources: ReadonlyMap<string, KnowledgeItem>;
  usage: TokenUsage;
  model: string;
  settings: UsageSettings;
  /** API skill calls of the turn, without values (FR-030). */
  skillCalls: SkillCallRecord[];
  /** The confirmation to keep for the next turn (research R12). */
  pendingConfirmation: PendingConfirmation | null;
}

export interface FailureInput extends TurnBase {
  model: string;
}

/**
 * SENT: queued for WhatsApp (a hand-over reply too). OPTED_OUT: the customer asked not to be
 * messaged; nothing was sent. DROPPED: the chat changed (member, window, block, opt-out, flow).
 * NEWER: another message waits; the follow-up turn answers everything.
 */
export type ApplyOutcome =
  | { result: 'SENT'; itemId: string; aiConversationId: string; handedOver: boolean }
  | { result: 'OPTED_OUT' }
  | { result: 'DROPPED' | 'NEWER' };

/** Work for after the commit: the sends (in order) and the live chat events. */
interface AfterCommit {
  itemIds: readonly string[];
  noteId: string | null;
  requested: boolean;
  contactChanged: boolean;
}

/** Spacing between the items of one reply, so WhatsApp delivers them in order (as flows do). */
const ITEM_SPACING_MS = 1500;

/** The manager's introduction for the reply's language, with the display name (FR-010). */
export function introFor(config: AgentConfig, language: string | null): string {
  const intro = config.intro;
  const text = (language ? intro[language] : undefined) ?? intro[config.replyLanguages[0] ?? 'en'] ?? DEFAULT_INTROS.en!;
  return text.split('{name}').join(config.displayName);
}

/**
 * Applies a turn's outcome (research R5 step 3, T042, T051, T053, T054): under the chat's AI lock and
 * a row lock on the conversation it re-checks that the chat may still be answered (FR-016, FR-026),
 * then writes everything in one transaction: the chat item, the AI reply record, usage, the AI
 * conversation and unanswered questions; for a hand-over also the move to Waiting for agent with the
 * team's note (FR-024); an opt-out records consent and sends nothing (FR-027); a failure sends the
 * fallback message and hands over (FR-022). The send and the 002 alerts follow the commit.
 */
@Injectable()
export class TurnApplier {
  private readonly logger = new Logger(TurnApplier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly publisher: InboxPublisher,
    private readonly routing: ChatRoutingService,
    private readonly consent: ConsentService,
    private readonly conversations: AiConversationsService,
    private readonly usage: AiUsageService,
    private readonly unanswered: UnansweredRecorder,
  ) {}

  async apply(input: ApplyInput): Promise<ApplyOutcome> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const gate = await this.gate(tx, input);
        if (gate !== 'OK') return { result: gate } as const;

        if (input.reply.optOut === 'clear') {
          const note = `Asked the AI agent not to be messaged: "${[...maskSensitive(input.customerText)].slice(0, 300).join('')}"`;
          await this.consent.setStatus(input.contactId, 'OPTED_OUT', 'AI_AGENT', { note }, tx);
          await this.conversations.endForConversation(input.conversationId, 'OPTED_OUT', tx);
          await this.release(tx, input.handledIds);
          return { result: 'OPTED_OUT' } as const;
        }

        const conversation = await this.conversationFor(tx, input);
        if (!conversation) {
          await this.release(tx, input.handledIds);
          return { result: 'DROPPED' } as const;
        }
        const now = new Date();
        const message = conversation.replies === 0 ? `${introFor(input.agent.config, input.reply.language)}\n\n${input.reply.message}`.trim() : input.reply.message;
        const sources = input.reply.usedSources
          .map((id) => input.knownSources.get(id))
          .filter((item): item is KnowledgeItem => item !== undefined)
          .map((item) => ({ id: item.id, kind: item.kind, title: item.title }));
        const handOver = input.handOver;
        const config = input.agent.config;
        const media = input.reply.mediaId
          ? await tx.mediaAsset.findFirst({ where: { id: input.reply.mediaId, purpose: 'LIBRARY', removedAt: null }, select: { id: true, mimeType: true, sizeBytes: true, displayName: true } })
          : null;
        const items = replyItems(message, input.reply, { aiConversationId: conversation.id, media, allowButtons: config.skills.buttons, allowLists: config.skills.lists });
        const itemIds: string[] = [];
        for (const [i, item] of items.entries()) {
          itemIds.push(await this.writeReply(tx, input, conversation.id, item, { sources, skills: input.skillCalls, ...(handOver ? { handOver: handOver.reason } : {}) }, new Date(now.getTime() + i)));
        }
        // The reply record points at the main item (the file, buttons or list after any lead-in text).
        const itemId = itemIds.at(-1)!;

        const cost = this.usage.cost(input.usage, input.settings);
        await tx.aiReply.create({
          data: {
            aiConversationId: conversation.id,
            chatMessageId: itemId,
            agentId: input.agent.agentId,
            versionId: input.agent.versionId,
            numberId: input.numberId,
            kind: handOver ? 'HANDOVER' : 'REPLY',
            test: input.agent.test,
            counted: true,
            language: input.reply.language,
            sources: sources as Prisma.InputJsonValue,
            skills: input.skillCalls as unknown as Prisma.InputJsonValue,
            modelId: input.model,
            inputTokens: input.usage.inputTokens,
            cacheReadTokens: input.usage.cacheReadTokens,
            cacheWriteTokens: input.usage.cacheWriteTokens,
            outputTokens: input.usage.outputTokens,
            costMicros: BigInt(cost),
            durationMs: Math.max(0, now.getTime() - input.startedAt.getTime()),
          },
        });
        await this.usage.record(tx, {
          kind: 'REPLY',
          agentId: input.agent.agentId,
          numberId: input.numberId,
          test: input.agent.test,
          usage: input.usage,
          costMicros: cost,
          at: now,
          timezone: input.settings.timezone,
          countsAgainstMonth: true,
        });
        await tx.aiConversation.update({
          where: { id: conversation.id },
          data: {
            replies: { increment: 1 },
            lastHandledAt: input.handledUntil,
            lastActivityAt: now,
            // The call the customer was just asked to confirm, kept for their answer (research R12).
            pendingConfirmation: input.pendingConfirmation ? (input.pendingConfirmation as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            ...(input.agent.versionId ? { versionId: input.agent.versionId } : {}),
          },
        });
        if (input.reply.unanswered) await this.unanswered.record(tx, input.agent.agentId, conversation.id, input.reply.unanswered);

        // Facts the customer stated, into the attributes the version allows (FR-029); values that look
        // like card, bank or ID numbers are never saved.
        const remembered = Object.fromEntries((input.reply.remember ?? []).filter((r) => !looksSensitive(r.value)).map((r) => [r.key, r.value]));
        const changed = await writeAttributes(tx, input.contactId, remembered, { type: 'AI_AGENT', agentId: input.agent.agentId, agentName: input.agent.agentName });

        let after: AfterCommit = { itemIds, noteId: null, requested: false, contactChanged: changed.length > 0 };
        if (handOver) {
          // The agent stops in this chat until it is closed (FR-024).
          await this.conversations.endForConversation(input.conversationId, 'HANDED_OVER', tx);
          const note = await this.handOverChat(tx, input, handOverNote(input.agent.agentName, handOver), { reason: handOver.reason, aiConversationId: conversation.id }, new Date(now.getTime() + items.length));
          after = { ...after, ...note };
        }
        await this.release(tx, input.handledIds);
        return { result: 'SENT', itemId, aiConversationId: conversation.id, handedOver: handOver !== null, after } as const;
      },
      { timeout: 15_000 },
    );

    if (outcome.result === 'SENT') {
      await this.afterCommit(input, outcome.after);
      return { result: 'SENT', itemId: outcome.itemId, aiConversationId: outcome.aiConversationId, handedOver: outcome.handedOver };
    }
    if (outcome.result === 'OPTED_OUT') {
      await this.publisher.contactUpdated(input.contactId).catch(() => undefined);
      await this.publisher.conversation(input.conversationId).catch(() => undefined);
    }
    return outcome;
  }

  /**
   * The AI service failed (FR-022): the version's fallback message (not counted), a hand-over with
   * the note "AI agent unavailable", and the AI conversation ends FAILED.
   */
  async applyFailure(input: FailureInput): Promise<'FAILED' | 'DROPPED' | 'NEWER'> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const gate = await this.gate(tx, input);
        if (gate !== 'OK') return { result: gate } as const;
        const conversation = await this.conversationFor(tx, input);
        if (!conversation) {
          await this.release(tx, input.handledIds);
          return { result: 'DROPPED' } as const;
        }
        const now = new Date();
        const fallback = input.agent.config.fallbackMessage;
        const message = conversation.replies === 0 ? `${introFor(input.agent.config, null)}\n\n${fallback}` : fallback;
        const itemId = await this.writeReply(tx, input, conversation.id, { contentType: 'TEXT', text: message, mediaAssetId: null, payload: {} }, { sources: [], fallback: true }, now);
        await tx.aiReply.create({
          data: {
            aiConversationId: conversation.id,
            chatMessageId: itemId,
            agentId: input.agent.agentId,
            versionId: input.agent.versionId,
            numberId: input.numberId,
            kind: 'FALLBACK',
            test: input.agent.test,
            counted: false,
            modelId: input.model,
            durationMs: Math.max(0, now.getTime() - input.startedAt.getTime()),
          },
        });
        await this.conversations.endForConversation(input.conversationId, 'FAILED', tx);
        const moved = await this.handOverChat(tx, input, UNAVAILABLE_NOTE, { reason: 'unavailable', aiConversationId: conversation.id }, new Date(now.getTime() + 1));
        await this.release(tx, input.handledIds);
        return { result: 'FAILED', after: { itemIds: [itemId], contactChanged: false, ...moved } } as const;
      },
      { timeout: 15_000 },
    );
    if (outcome.result === 'FAILED') await this.afterCommit(input, outcome.after);
    return outcome.result;
  }

  /** The chat's AI lock, then the re-checks; a dropped turn lets its messages go. */
  private async gate(tx: Tx, input: TurnBase): Promise<'OK' | 'DROPPED' | 'NEWER'> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${aiConversationLock(input.conversationId)}::text))`;
    const still = await this.stillAnswerable(tx, input);
    if (still === 'DROPPED') await this.release(tx, input.handledIds);
    return still;
  }

  /** The chat is still Open, the contact may be answered, the window is open, no flow runs, and no other message waits. */
  private async stillAnswerable(tx: Tx, input: TurnBase): Promise<'OK' | 'DROPPED' | 'NEWER'> {
    const [chat] = await tx.$queryRaw<Array<{ state: string; last_customer_message_at: Date | null }>>`
      SELECT state::text AS state, last_customer_message_at FROM conversations WHERE id = ${input.conversationId}::uuid FOR UPDATE`;
    if (!chat) return 'DROPPED';
    const contact = await tx.contact.findUnique({ where: { id: input.contactId }, select: { blockedAt: true, consentStatus: true } });
    if (!contact) return 'DROPPED';
    const flowRunning = (await tx.flowSession.count({ where: { conversationId: input.conversationId, status: 'RUNNING' } })) > 0;
    const why = ineligibility({
      state: chat.state,
      blocked: contact.blockedAt !== null,
      optedOut: contact.consentStatus === 'OPTED_OUT',
      windowLive: isLive(chat.last_customer_message_at),
      flowRunning,
    });
    if (why) return 'DROPPED';
    // A message flagged after the turn read its messages (research R5).
    const newer = await tx.chatMessage.count({
      where: { conversationId: input.conversationId, kind: 'INBOUND', origin: 'CUSTOMER', aiPending: true, id: { notIn: input.handledIds } },
    });
    return newer > 0 ? 'NEWER' : 'OK';
  }

  /** The active AI conversation the outcome belongs to, started now when there is none; null when it ended meanwhile. */
  private async conversationFor(tx: Tx, input: TurnBase): Promise<{ id: string; replies: number } | null> {
    if (input.agent.aiConversationId) {
      const current = await tx.aiConversation.findUnique({ where: { id: input.agent.aiConversationId }, select: { status: true, replies: true } });
      return current?.status === 'ACTIVE' ? { id: input.agent.aiConversationId, replies: current.replies } : null;
    }
    const started = await this.conversations.start(tx, {
      conversationId: input.conversationId,
      agentId: input.agent.agentId,
      agentName: input.agent.agentName,
      numberId: input.numberId,
      contactId: input.contactId,
      startedBy: 'CUSTOMER',
      test: input.agent.test,
      versionId: input.agent.versionId,
      startedAt: input.firstMessageAt,
    });
    if (started.created) return { id: started.id, replies: 0 };
    const row = await tx.aiConversation.findUnique({ where: { id: started.id }, select: { replies: true } });
    return { id: started.id, replies: row?.replies ?? 0 };
  }

  /** One item of the agent's reply as a 002 chat item (origin AUTOMATIC, payload.ai) and the chat's preview. */
  private async writeReply(tx: Tx, input: TurnBase, aiConversationId: string, item: ReplyItem, extra: Record<string, unknown>, now: Date): Promise<string> {
    const ai = {
      agentId: input.agent.agentId,
      agentName: input.agent.agentName,
      versionId: input.agent.versionId,
      aiConversationId,
      skills: [],
      test: input.agent.test,
      ...extra,
    };
    const itemId = uuidv7();
    await tx.chatMessage.create({
      data: {
        id: itemId,
        conversationId: input.conversationId,
        kind: 'SESSION_OUT',
        origin: 'AUTOMATIC',
        contentType: item.contentType,
        text: item.text,
        mediaAssetId: item.mediaAssetId,
        payload: { ...item.payload, ai } as Prisma.InputJsonValue,
        status: 'QUEUED',
        occurredAt: now,
      },
    });
    const preview = (item.text ?? (item.contentType === 'AUDIO' ? 'Audio' : item.contentType)).replace(/\s+/g, ' ').trim().slice(0, 120);
    await tx.$executeRaw`
      UPDATE conversations
         SET last_activity_at = GREATEST(last_activity_at, ${now}), last_message_preview = ${preview}, updated_at = now()
       WHERE id = ${input.conversationId}::uuid`;
    return itemId;
  }

  /**
   * The 002 hand-over (FR-024), as flows do it: an Open chat moves to Waiting for agent as if the
   * customer asked (the alert follows the commit), and the team gets a note in the chat.
   */
  private async handOverChat(tx: Tx, input: TurnBase, note: string, ai: Record<string, unknown>, now: Date): Promise<{ noteId: string; requested: boolean }> {
    const moved = await tx.conversation.updateMany({ where: { id: input.conversationId, state: 'ACTIVE' }, data: { state: 'REQUESTING', unresolvedRequests: { increment: 1 } } });
    const who = { agentId: input.agent.agentId, agentName: input.agent.agentName, test: input.agent.test, ...ai };
    if (moved.count) {
      await tx.conversationEvent.create({ data: { conversationId: input.conversationId, type: 'REQUESTED', actorType: 'AI_AGENT', data: who as Prisma.InputJsonValue, occurredAt: now } });
    }
    const noteId = uuidv7();
    await tx.chatMessage.create({
      data: {
        id: noteId,
        conversationId: input.conversationId,
        kind: 'NOTE',
        origin: 'AUTOMATIC',
        contentType: 'TEXT',
        text: note,
        payload: { mentions: [], ai: who } as Prisma.InputJsonValue,
        // Callers pass a time just after the closing reply, so the timeline shows them in that order.
        occurredAt: now,
      },
    });
    return { noteId, requested: moved.count > 0 };
  }

  /** The outcome covers these messages, or nobody from the AI will: they stop waiting for the agent. */
  private async release(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length) await tx.chatMessage.updateMany({ where: { id: { in: ids } }, data: { aiPending: false } });
  }

  private async afterCommit(input: TurnBase, after: AfterCommit): Promise<void> {
    try {
      const queue = this.queues.sendQueue(input.numberId);
      for (const [index, itemId] of after.itemIds.entries()) {
        const job = sessionSendJob(itemId);
        await queue.add(job.name, job.data, { ...job.opts, ...(index > 0 ? { delay: index * ITEM_SPACING_MS } : {}) });
      }
      await requestSendWorkerSync(this.queues);
      for (const itemId of after.itemIds) await this.publisher.itemCreated(itemId);
      if (after.noteId) await this.publisher.itemCreated(after.noteId);
      await this.publisher.conversation(input.conversationId, after.requested ? { state: 'ACTIVE', intervenedById: null, blocked: false } : undefined);
      if (after.contactChanged) await this.publisher.contactUpdated(input.contactId);
      if (after.requested) await this.routing.alertRequesting(input.conversationId);
    } catch (error) {
      this.logger.error({ err: (error as Error).message, conversationId: input.conversationId, itemIds: after.itemIds }, 'Could not queue the AI reply after commit');
    }
  }
}
