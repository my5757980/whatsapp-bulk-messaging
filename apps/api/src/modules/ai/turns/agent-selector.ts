import { Injectable } from '@nestjs/common';
import type { AgentConfig } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { parseConfig } from '../agents/agent-views.js';
import { AiConversationsService } from './ai-conversations.service.js';

/** The agent that answers a chat now, and the configuration it answers with. */
export interface SelectedAgent {
  agentId: string;
  agentName: string;
  /** A test number talking to the draft (FR-035). */
  test: boolean;
  /** The published version for live answers; null for the draft. */
  versionId: string | null;
  config: AgentConfig;
  /** The chat's active AI conversation, if one is open. */
  aiConversationId: string | null;
  /** Replies already sent in that conversation (0 for a new one). */
  replies: number;
}

/**
 * Chooses the agent for a chat (research R5 step 4, FR-004, FR-033, FR-035): the agent of the chat's
 * active AI conversation (also after a flow handed the chat over), else the agent whose test numbers
 * include the sender (its draft), else the number's published agent. An active conversation whose
 * agent is no longer published ends as UNPUBLISHED and nobody answers.
 */
@Injectable()
export class AgentSelector {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: AiConversationsService,
  ) {}

  async select(chat: { id: string; numberId: string }, senderPhone: string | null): Promise<SelectedAgent | null> {
    const active = await this.prisma.aiConversation.findFirst({
      where: { conversationId: chat.id, status: 'ACTIVE' },
      include: { agent: { include: { publishedVersion: { select: { id: true, config: true } } } } },
    });
    if (active) {
      const agent = active.agent;
      if (agent.deletedAt) {
        await this.conversations.endForConversation(chat.id, 'UNPUBLISHED');
        return null;
      }
      if (active.test) {
        return { agentId: agent.id, agentName: agent.name, test: true, versionId: null, config: parseConfig(agent.draft, agent.name), aiConversationId: active.id, replies: active.replies };
      }
      if (agent.status !== 'PUBLISHED' || !agent.publishedVersion) {
        await this.conversations.endForConversation(chat.id, 'UNPUBLISHED');
        return null;
      }
      return {
        agentId: agent.id,
        agentName: agent.name,
        test: false,
        versionId: agent.publishedVersion.id,
        config: parseConfig(agent.publishedVersion.config, agent.name),
        aiConversationId: active.id,
        replies: active.replies,
      };
    }

    if (senderPhone) {
      const tester = await this.prisma.aiAgent.findFirst({ where: { deletedAt: null, testNumbers: { has: senderPhone } }, orderBy: { name: 'asc' } });
      if (tester) return { agentId: tester.id, agentName: tester.name, test: true, versionId: null, config: parseConfig(tester.draft, tester.name), aiConversationId: null, replies: 0 };
    }

    const assigned = await this.prisma.aiAgentNumber.findUnique({
      where: { numberId: chat.numberId },
      include: { agent: { include: { publishedVersion: { select: { id: true, config: true } } } } },
    });
    const agent = assigned?.agent;
    if (!agent || agent.deletedAt || agent.status !== 'PUBLISHED' || !agent.publishedVersion) return null;
    return {
      agentId: agent.id,
      agentName: agent.name,
      test: false,
      versionId: agent.publishedVersion.id,
      config: parseConfig(agent.publishedVersion.config, agent.name),
      aiConversationId: null,
      replies: 0,
    };
  }
}
