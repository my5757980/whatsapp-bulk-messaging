import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { AiConversationResult, AiStartedBy, Prisma } from '../../../generated/prisma/client.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';

type Tx = Prisma.TransactionClient;

/** Serialises everything an AI turn changes in one chat (research R5). */
export function aiConversationLock(conversationId: string): string {
  return `ai-conversation:${conversationId}`;
}

export interface StartAiConversation {
  conversationId: string;
  agentId: string;
  agentName: string;
  numberId: string;
  contactId: string | null;
  startedBy: AiStartedBy;
  test: boolean;
  versionId: string | null;
  /** The first customer message it answers; history reaches back to it (FR-019). Defaults to now. */
  startedAt?: Date;
}

/**
 * AI conversations (data-model.md §3, T019): one stretch of a chat answered by one agent. At most one
 * is ACTIVE per chat (partial unique index); starting and ending write AI_STARTED / AI_ENDED journey
 * entries with actor AI_AGENT.
 */
@Injectable()
export class AiConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
  ) {}

  /** The chat's active AI conversation with its agent, or null. */
  active(conversationId: string) {
    return this.prisma.aiConversation.findFirst({
      where: { conversationId, status: 'ACTIVE' },
      include: { agent: { select: { id: true, name: true, status: true, deletedAt: true } } },
    });
  }

  /** Opens an AI conversation, or returns the one already active in the chat. */
  async start(tx: Tx, input: StartAiConversation): Promise<{ id: string; created: boolean }> {
    const existing = await tx.aiConversation.findFirst({ where: { conversationId: input.conversationId, status: 'ACTIVE' }, select: { id: true } });
    if (existing) return { id: existing.id, created: false };
    const created = await tx.aiConversation.create({
      data: {
        conversationId: input.conversationId,
        agentId: input.agentId,
        numberId: input.numberId,
        contactId: input.contactId,
        startedBy: input.startedBy,
        test: input.test,
        versionId: input.versionId,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
      select: { id: true },
    });
    await tx.conversationEvent.create({
      data: {
        conversationId: input.conversationId,
        type: 'AI_STARTED',
        actorType: 'AI_AGENT',
        data: { agentId: input.agentId, agentName: input.agentName, startedBy: input.startedBy, test: input.test },
      },
    });
    return { id: created.id, created: true };
  }

  /** Ends the chat's active AI conversation with a result; true when one ended (FR-024, FR-026). */
  async endForConversation(conversationId: string, result: AiConversationResult, tx?: Tx): Promise<boolean> {
    const work = async (db: Tx): Promise<boolean> => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${aiConversationLock(conversationId)}::text))`;
      // Messages still waiting for the agent are left to the team, also before a first reply.
      await db.chatMessage.updateMany({ where: { conversationId, aiPending: true }, data: { aiPending: false } });
      const row = await db.aiConversation.findFirst({
        where: { conversationId, status: 'ACTIVE' },
        select: { id: true, agentId: true, test: true, agent: { select: { name: true } } },
      });
      if (!row) return false;
      await db.aiConversation.update({ where: { id: row.id }, data: { status: 'ENDED', result, endedAt: new Date(), pendingConfirmation: undefined } });
      await db.conversationEvent.create({
        data: { conversationId, type: 'AI_ENDED', actorType: 'AI_AGENT', data: { agentId: row.agentId, agentName: row.agent.name, result, test: row.test } },
      });
      return true;
    };
    const ended = tx ? await work(tx) : await this.prisma.$transaction((db) => work(db), { timeout: 15_000 });
    if (ended && !tx) await this.publisher.conversation(conversationId);
    return ended;
  }
}
