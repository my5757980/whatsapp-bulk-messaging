import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_INTROS, type AgentReply, type TokenUsage } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { isLive } from '../../inbox/conversations/window.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import type { KnowledgeItem } from '../claude/prompt.js';
import { UnansweredRecorder } from '../knowledge/unanswered-recorder.js';
import { AiUsageService, type UsageSettings } from '../usage/usage.service.js';
import type { SelectedAgent } from './agent-selector.js';
import { aiConversationLock, AiConversationsService } from './ai-conversations.service.js';

type Tx = Prisma.TransactionClient;

export interface ApplyInput {
  conversationId: string;
  numberId: string;
  contactId: string;
  agent: SelectedAgent;
  /** Time of the newest customer message the reply covers. */
  handledUntil: Date;
  reply: AgentReply;
  /** Knowledge the turn saw, to name the sources the reply used. */
  knownSources: ReadonlyMap<string, KnowledgeItem>;
  usage: TokenUsage;
  model: string;
  startedAt: Date;
  settings: UsageSettings;
}

/** SENT: queued for WhatsApp. DROPPED: the chat changed (member, window, block, opt-out). NEWER: a later message arrived; the follow-up turn answers everything. */
export type ApplyOutcome = { result: 'SENT'; itemId: string; aiConversationId: string } | { result: 'DROPPED' | 'NEWER' };

/** The manager's introduction for the reply's language, with the display name (FR-010). */
export function introFor(agent: SelectedAgent, language: string | null): string {
  const intro = agent.config.intro;
  const text = (language ? intro[language] : undefined) ?? intro[agent.config.replyLanguages[0] ?? 'en'] ?? DEFAULT_INTROS.en!;
  return text.split('{name}').join(agent.config.displayName);
}

/**
 * Applies a validated reply (research R5 step 3, T042): under the chat's AI lock and a row lock on
 * the conversation it re-checks that the chat may still be answered (FR-016, FR-026), then writes
 * the chat item, the AI reply record, usage, the AI conversation and unanswered questions in one
 * transaction, and queues the send on the 002 chat path after commit.
 */
@Injectable()
export class TurnApplier {
  private readonly logger = new Logger(TurnApplier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly publisher: InboxPublisher,
    private readonly conversations: AiConversationsService,
    private readonly usage: AiUsageService,
    private readonly unanswered: UnansweredRecorder,
  ) {}

  async apply(input: ApplyInput): Promise<ApplyOutcome> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${aiConversationLock(input.conversationId)}::text))`;
        const still = await this.stillAnswerable(tx, input);
        if (still !== 'OK') return { result: still } as const;

        let aiConversationId = input.agent.aiConversationId;
        let replies = input.agent.replies;
        if (aiConversationId) {
          const current = await tx.aiConversation.findUnique({ where: { id: aiConversationId }, select: { status: true, replies: true } });
          if (current?.status !== 'ACTIVE') return { result: 'DROPPED' } as const;
          replies = current.replies;
        } else {
          const started = await this.conversations.start(tx, {
            conversationId: input.conversationId,
            agentId: input.agent.agentId,
            agentName: input.agent.agentName,
            numberId: input.numberId,
            contactId: input.contactId,
            startedBy: 'CUSTOMER',
            test: input.agent.test,
            versionId: input.agent.versionId,
          });
          aiConversationId = started.id;
          if (!started.created) replies = (await tx.aiConversation.findUnique({ where: { id: started.id }, select: { replies: true } }))?.replies ?? 0;
        }

        const now = new Date();
        const message = replies === 0 ? `${introFor(input.agent, input.reply.language)}\n\n${input.reply.message}`.trim() : input.reply.message;
        const sources = input.reply.usedSources
          .map((id) => input.knownSources.get(id))
          .filter((item): item is KnowledgeItem => item !== undefined)
          .map((item) => ({ id: item.id, kind: item.kind, title: item.title }));
        const ai = {
          agentId: input.agent.agentId,
          agentName: input.agent.agentName,
          versionId: input.agent.versionId,
          aiConversationId,
          sources,
          skills: [],
          test: input.agent.test,
        };
        const itemId = uuidv7();
        await tx.chatMessage.create({
          data: { id: itemId, conversationId: input.conversationId, kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType: 'TEXT', text: message, payload: { ai } as Prisma.InputJsonValue, status: 'QUEUED', occurredAt: now },
        });
        const preview = message.replace(/\s+/g, ' ').trim().slice(0, 120);
        await tx.$executeRaw`
          UPDATE conversations
             SET last_activity_at = GREATEST(last_activity_at, ${now}), last_message_preview = ${preview}, updated_at = now()
           WHERE id = ${input.conversationId}::uuid`;

        const cost = this.usage.cost(input.usage, input.settings);
        await tx.aiReply.create({
          data: {
            aiConversationId,
            chatMessageId: itemId,
            agentId: input.agent.agentId,
            versionId: input.agent.versionId,
            numberId: input.numberId,
            kind: 'REPLY',
            test: input.agent.test,
            counted: true,
            language: input.reply.language,
            sources: sources as Prisma.InputJsonValue,
            skills: [],
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
          where: { id: aiConversationId },
          data: { replies: { increment: 1 }, lastHandledAt: input.handledUntil, lastActivityAt: now, ...(input.agent.versionId ? { versionId: input.agent.versionId } : {}) },
        });
        if (input.reply.unanswered) await this.unanswered.record(tx, input.agent.agentId, aiConversationId, input.reply.unanswered);
        return { result: 'SENT', itemId, aiConversationId } as const;
      },
      { timeout: 15_000 },
    );

    if (outcome.result === 'SENT') await this.afterCommit(input, outcome.itemId);
    return outcome;
  }

  /** The chat is still Open, the contact may be answered, the window is open, and no newer message waits. */
  private async stillAnswerable(tx: Tx, input: ApplyInput): Promise<'OK' | 'DROPPED' | 'NEWER'> {
    const [chat] = await tx.$queryRaw<Array<{ state: string; last_customer_message_at: Date | null }>>`
      SELECT state::text AS state, last_customer_message_at FROM conversations WHERE id = ${input.conversationId}::uuid FOR UPDATE`;
    if (!chat || chat.state !== 'ACTIVE' || !isLive(chat.last_customer_message_at)) return 'DROPPED';
    const contact = await tx.contact.findUnique({ where: { id: input.contactId }, select: { blockedAt: true, consentStatus: true } });
    if (!contact || contact.blockedAt || contact.consentStatus === 'OPTED_OUT') return 'DROPPED';
    const newer = await tx.chatMessage.count({ where: { conversationId: input.conversationId, kind: 'INBOUND', origin: 'CUSTOMER', occurredAt: { gt: input.handledUntil } } });
    return newer > 0 ? 'NEWER' : 'OK';
  }

  private async afterCommit(input: ApplyInput, itemId: string): Promise<void> {
    try {
      const job = sessionSendJob(itemId);
      await this.queues.sendQueue(input.numberId).add(job.name, job.data, job.opts);
      await requestSendWorkerSync(this.queues);
      await this.publisher.itemCreated(itemId);
      await this.publisher.conversation(input.conversationId);
    } catch (error) {
      this.logger.error({ err: (error as Error).message, conversationId: input.conversationId, itemId }, 'Could not queue the AI reply after commit');
    }
  }
}
