import { Injectable, Logger } from '@nestjs/common';
import { AGENT_REPLY_JSON_SCHEMA, AgentReplySchema, AI_LIMITS, isWithinHours, sanitiseReply, type AgentConfig, type AgentReply, type AttributeKind, type TokenUsage } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { ChatContentType } from '../../../generated/prisma/client.js';
import { isLive } from '../../inbox/conversations/window.js';
import { LiveChatSettingsService } from '../../inbox/settings/live-chat-settings.service.js';
import { ClaudeClient, ClaudeFailure } from '../claude/claude.client.js';
import { buildPrompt, contactFacts, renderSource, type KnowledgeItem, type PromptCatalog } from '../claude/prompt.js';
import { AgentSecretsVault } from '../agents/secrets-vault.js';
import { skillSecretIds, skillSession, type PendingConfirmation, type SkillCallRecord, type SkillContact } from '../claude/skills.js';
import { buildTools } from '../claude/tools.js';
import { KnowledgeSearch } from '../knowledge/knowledge-search.js';
import { AiUsageService } from '../usage/usage.service.js';
import { AgentSelector, type SelectedAgent } from './agent-selector.js';
import { TurnApplier } from './apply.js';
import { capReached, handOverFor, ineligibility } from './decisions.js';
import { AiFailureMonitor } from './failure-monitor.js';
import { localStamp, nextOpening } from './hours.js';

/** At most this many unanswered customer messages are read in one turn. */
const MAX_NEW_MESSAGES = 10;

/** What a customer sent that the agent cannot read (FR-017); the platform rules say how to answer. */
const PLACEHOLDERS: Partial<Record<ChatContentType, string>> = {
  IMAGE: '[The customer sent a photo, which you cannot see]',
  VIDEO: '[The customer sent a video, which you cannot see]',
  AUDIO: '[The customer sent a voice message, which you cannot hear]',
  DOCUMENT: '[The customer sent a document, which you cannot read]',
  STICKER: '[The customer sent a sticker]',
  LOCATION: '[The customer shared a location, which you cannot see]',
  CONTACTS: '[The customer shared a contact card, which you cannot see]',
  FORM_REPLY: '[The customer sent a form reply, which you cannot read]',
  UNSUPPORTED: '[The customer sent a message type that cannot be shown]',
};

export type TurnResult = 'SENT' | 'OPTED_OUT' | 'NOTHING' | 'NOT_ELIGIBLE' | 'DROPPED' | 'NEWER' | 'FAILED';

/** What the model needs for one reply, from a chat or from the preview. */
export interface ThinkInput {
  agentId: string;
  config: AgentConfig;
  contact: { name: string | null; attributes: Record<string, unknown>; tags: string[] };
  history: Array<{ from: 'customer' | 'agent'; text: string }>;
  customerText: string;
  firstReply: boolean;
  handOverNow: boolean;
  couldNotAnswerBefore: boolean;
  /** API skills: `live` for customer turns (with the confirmation protocol), `preview` for the preview chat. */
  skills: { mode: 'live' | 'preview'; contact: SkillContact; pending: PendingConfirmation | null };
}

/** What one model run decided, before anything is applied. */
export interface Thought {
  reply: AgentReply;
  knownSources: Map<string, KnowledgeItem>;
  usage: TokenUsage;
  model: string;
  catalog: PromptCatalog;
  /** API skill calls of the turn, without values. */
  skillCalls: SkillCallRecord[];
  /** The confirmation to keep for the next turn. */
  pendingConfirmation: PendingConfirmation | null;
  /** "Would call …" lines (preview only). */
  skillWouldDo: string[];
}

interface ChatRow {
  id: string;
  numberId: string;
  state: string;
  lastCustomerMessageAt: Date | null;
  contact: { id: string; name: string | null; phoneE164: string | null; attributes: unknown; consentStatus: string; blockedAt: Date | null; tags: Array<{ tag: { name: string } }> } | null;
}

/** The customer's text of one stored message, a placeholder for what the agent cannot read, or null. */
export function customerTextOf(message: { contentType: ChatContentType; text: string | null }): string | null {
  if (message.contentType === 'TEXT' || message.contentType === 'BUTTON_REPLY' || message.contentType === 'LIST_REPLY') return message.text?.trim() || null;
  if (message.contentType === 'REACTION' || message.contentType === 'TEMPLATE') return null;
  const placeholder = PLACEHOLDERS[message.contentType] ?? PLACEHOLDERS.UNSUPPORTED!;
  return message.text?.trim() ? `${placeholder} ${message.text.trim()}` : placeholder;
}

/**
 * One customer turn (research R5, T042, T051, T054): check the chat may be answered (FR-016), gather
 * the waiting messages, build the prompt, run the bounded tool loop, validate the reply, decide the
 * hand-over (FR-023) and hand it all to the applier. A failure of the AI service sends the fallback
 * message and hands over (FR-022).
 */
@Injectable()
export class TurnService {
  private readonly logger = new Logger(TurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly selector: AgentSelector,
    private readonly claude: ClaudeClient,
    private readonly search: KnowledgeSearch,
    private readonly liveChat: LiveChatSettingsService,
    private readonly usage: AiUsageService,
    private readonly applier: TurnApplier,
    private readonly failures: AiFailureMonitor,
    private readonly secretsVault: AgentSecretsVault,
  ) {}

  async run(conversationId: string): Promise<TurnResult> {
    const startedAt = new Date();
    const chat = await this.loadChat(conversationId);
    if (!chat?.contact) return 'NOT_ELIGIBLE';
    const flowRunning = (await this.prisma.flowSession.count({ where: { conversationId, status: 'RUNNING' } })) > 0;
    const why = ineligibility({
      state: chat.state,
      blocked: chat.contact.blockedAt !== null,
      optedOut: chat.contact.consentStatus === 'OPTED_OUT',
      windowLive: isLive(chat.lastCustomerMessageAt),
      flowRunning,
    });
    const agent = why ? null : await this.selector.select({ id: chat.id, numberId: chat.numberId }, chat.contact.phoneE164);
    if (!agent) {
      // Nobody from the AI answers now: what waited is left to the team, the flow or the 002 rules.
      await this.prisma.chatMessage.updateMany({ where: { conversationId, aiPending: true }, data: { aiPending: false } });
      return 'NOT_ELIGIBLE';
    }

    // Every message the router flagged since the last reply. WhatsApp times have one-second precision,
    // so the flag, not a time cursor, says what is new; the newest few are answered together.
    const pending = await this.prisma.chatMessage.findMany({
      where: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', aiPending: true },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { id: true, contentType: true, text: true, occurredAt: true },
    });
    const handledIds = pending.map((m) => m.id);
    const fresh = pending.slice(-MAX_NEW_MESSAGES);
    const texts = fresh.map(customerTextOf).filter((t): t is string => t !== null);
    if (!texts.length) {
      if (handledIds.length) await this.prisma.chatMessage.updateMany({ where: { id: { in: handledIds } }, data: { aiPending: false } });
      return 'NOTHING';
    }
    const handledUntil = fresh.at(-1)!.occurredAt;
    const firstMessageAt = pending[0]!.occurredAt;
    const customerText = texts.join('\n');
    // The repeat and reply-cap rules (FR-023) count within the active AI conversation.
    const unansweredBefore = agent.aiConversationId ? await this.prisma.aiUnansweredAsk.count({ where: { aiConversationId: agent.aiConversationId } }) : 0;
    const capNow = agent.aiConversationId !== null && capReached(agent.replies, agent.config.replyCap);
    const base = { conversationId: chat.id, numberId: chat.numberId, contactId: chat.contact.id, agent, handledIds, firstMessageAt, startedAt };

    try {
      const thought = await this.decide(chat, agent, customerText, { handOverNow: capNow, couldNotAnswerBefore: unansweredBefore > 0 });
      const { reply, knownSources, usage, model, skillCalls, pendingConfirmation } = thought;
      const handOver = handOverFor(reply, { whenUnsure: agent.config.whenUnsure, unansweredBefore, capReached: capNow });
      const settings = await this.usage.settings();
      const outcome = await this.applier.apply({ ...base, handledUntil, reply, handOver, customerText, knownSources, usage, model, settings, skillCalls, pendingConfirmation });
      return outcome.result;
    } catch (error) {
      if (!(error instanceof ClaudeFailure)) throw error;
      this.logger.warn({ conversationId, agentId: agent.agentId, reason: error.reason, status: error.status, requestId: error.requestId }, 'AI turn failed');
      const result = await this.applier.applyFailure({ ...base, model: this.claude.model });
      await this.failures.check().catch((err: unknown) => this.logger.error({ err: (err as Error).message }, 'Could not check the AI failure rate'));
      return result;
    }
  }

  /** A customer turn: the chat's contact, history and pending confirmation from the database, then the model. */
  private async decide(chat: ChatRow, agent: SelectedAgent, customerText: string, rules: { handOverNow: boolean; couldNotAnswerBefore: boolean }): Promise<Thought> {
    const contact = chat.contact!;
    const attributes = (contact.attributes ?? {}) as Record<string, unknown>;
    const [history, conversation] = await Promise.all([
      this.history(chat.id, agent),
      agent.aiConversationId ? this.prisma.aiConversation.findUnique({ where: { id: agent.aiConversationId }, select: { pendingConfirmation: true } }) : null,
    ]);
    return this.think({
      agentId: agent.agentId,
      config: agent.config,
      contact: { name: contact.name, attributes, tags: contact.tags.map((t) => t.tag.name) },
      history,
      customerText,
      firstReply: agent.replies === 0,
      ...rules,
      skills: { mode: 'live', contact: { name: contact.name, phoneE164: contact.phoneE164, attributes }, pending: (conversation?.pendingConfirmation ?? null) as PendingConfirmation | null },
    });
  }

  /**
   * Builds the prompt, runs the model and returns the sanitised reply. Customer turns and the
   * preview (T060) share it; it changes nothing, so the caller decides what happens next.
   */
  async think(input: ThinkInput): Promise<Thought> {
    const config = input.config;
    const agentId = input.agentId;
    const customerText = input.customerText;
    const allowedAttributes = config.skills.memory.map((m) => m.key);

    const total = await this.search.totalChars(agentId);
    const mode = total <= AI_LIMITS.wholeKnowledgeChars ? 'WHOLE' : 'SEARCH';
    const items = await this.search.items(agentId, mode === 'SEARCH');
    const retrieved = mode === 'SEARCH' ? await this.search.retrieve(agentId, customerText) : [];
    const knownSources = new Map<string, KnowledgeItem>();
    for (const item of [...items, ...retrieved]) knownSources.set(item.id, item);

    const [catalog, live] = await Promise.all([this.catalog(config), this.liveChat.get()]);
    const now = new Date();
    const prompt = buildPrompt({
      config,
      catalog,
      knowledge: { mode, items },
      retrieved,
      history: input.history,
      customerText,
      turn: {
        contact: contactFacts(input.contact, allowedAttributes),
        localTime: localStamp(live.timezone, now),
        timeZone: live.timezone,
        teamOpen: isWithinHours(live.workingHours, live.timezone, now),
        nextOpening: nextOpening(live.workingHours, live.timezone, now),
        firstReply: input.firstReply,
        pendingConfirmation: input.skills.pending ? { skillName: input.skills.pending.skillName, inputs: input.skills.pending.inputs } : null,
        handOverNow: input.handOverNow,
        couldNotAnswerBefore: input.couldNotAnswerBefore,
      },
    });

    const secrets = await this.secretsVault.values(agentId, [...new Set(config.skills.api.flatMap(skillSecretIds))]);
    const session = skillSession(config.skills.api, { mode: input.skills.mode, contact: input.skills.contact, secrets, pending: input.skills.pending });
    let searches = 0;
    const tools = buildTools({
      searchKnowledge: async (query) => {
        searches += 1;
        if (searches > AI_LIMITS.searchCallsPerTurn) return '<results>\nThe search limit for this turn is reached; answer with what you have.\n</results>';
        const found = await this.search.searchForTool(agentId, query, renderSource);
        for (const item of found.items) knownSources.set(item.id, item);
        return found.text;
      },
      skills: session.tools,
    });

    const result = await this.claude.runTurn({
      system: prompt.system,
      messages: prompt.messages,
      tools,
      effort: 'low',
      schema: AGENT_REPLY_JSON_SCHEMA,
      deadlineMs: AI_LIMITS.turnDeadlineMs,
      maxIterations: AI_LIMITS.toolIterations,
    });

    let parsed: AgentReply;
    try {
      const json = AgentReplySchema.safeParse(JSON.parse(result.text));
      if (!json.success) throw new Error(json.error.message);
      parsed = json.data;
    } catch (error) {
      throw new ClaudeFailure('INVALID_OUTPUT', `The reply did not match the reply format: ${(error as Error).message.slice(0, 200)}`);
    }

    const attributes = new Map<string, AttributeKind>(catalog.memory.map((m) => [m.key, m.type as AttributeKind]));
    const { reply, dropped } = sanitiseReply(parsed, {
      maxReplyChars: config.maxReplyChars,
      allowButtons: config.skills.buttons,
      allowLists: config.skills.lists,
      mediaIds: new Set(catalog.media.map((m) => m.id)),
      flowIds: new Set(catalog.flows.map((f) => f.id)),
      attributes,
      sourceIds: new Set(knownSources.keys()),
    });
    if (dropped.length) this.logger.log({ agentId, dropped }, 'Parts of an AI reply were dropped');
    // Only an opt-out or a flow start may come without words (contracts/claude-messages.md §4).
    if (!reply.message && reply.optOut !== 'clear' && !reply.startFlow) throw new ClaudeFailure('INVALID_OUTPUT', 'The reply had no message');
    return {
      reply,
      knownSources,
      usage: result.usage as TokenUsage,
      model: result.model,
      catalog,
      skillCalls: session.calls,
      pendingConfirmation: session.pending(),
      skillWouldDo: session.wouldDo,
    };
  }

  private loadChat(conversationId: string): Promise<ChatRow | null> {
    return this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        numberId: true,
        state: true,
        lastCustomerMessageAt: true,
        contact: { select: { id: true, name: true, phoneE164: true, attributes: true, consentStatus: true, blockedAt: true, tags: { select: { tag: { select: { name: true } } } } } },
      },
    });
  }

  /** Customer messages after this point have no reply yet: the AI conversation's last handled one, or the last message anyone sent. */
  /**
   * Earlier customer messages and AI replies of the AI conversation (FR-019), from its first customer
   * message on. Messages still waiting are this turn's and come after the history.
   */
  private async history(conversationId: string, agent: SelectedAgent): Promise<Array<{ from: 'customer' | 'agent'; text: string }>> {
    if (!agent.aiConversationId) return [];
    const conversation = await this.prisma.aiConversation.findUnique({ where: { id: agent.aiConversationId }, select: { startedAt: true } });
    if (!conversation) return [];
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId, aiPending: false, occurredAt: { gte: conversation.startedAt } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: AI_LIMITS.historyMessages * 2,
      select: { kind: true, origin: true, contentType: true, text: true, payload: true },
    });
    const history: Array<{ from: 'customer' | 'agent'; text: string }> = [];
    for (const row of rows.reverse()) {
      if (row.kind === 'INBOUND' && row.origin === 'CUSTOMER') {
        const text = customerTextOf(row);
        if (text) history.push({ from: 'customer', text });
      } else if (row.kind === 'SESSION_OUT' && row.origin === 'AUTOMATIC' && (row.payload as { ai?: unknown } | null)?.ai && row.text) {
        history.push({ from: 'agent', text: row.text });
      }
    }
    return history.slice(-AI_LIMITS.historyMessages);
  }

  /** Names for the shared files, flows and fillable attributes the version allows. */
  private async catalog(config: AgentConfig): Promise<PromptCatalog> {
    const skills = config.skills;
    const [media, flows, attributes] = await Promise.all([
      skills.media.length
        ? this.prisma.mediaAsset.findMany({ where: { id: { in: skills.media.map((m) => m.mediaId) }, purpose: 'LIBRARY', removedAt: null }, select: { id: true, displayName: true } })
        : [],
      skills.flows.length ? this.prisma.flow.findMany({ where: { id: { in: skills.flows.map((f) => f.flowId) }, status: 'PUBLISHED', deletedAt: null }, select: { id: true, name: true } }) : [],
      skills.memory.length ? this.prisma.attributeDefinition.findMany({ where: { key: { in: skills.memory.map((m) => m.key) } }, select: { key: true, label: true, type: true } }) : [],
    ]);
    return {
      media: skills.media.flatMap((m) => {
        const row = media.find((x) => x.id === m.mediaId);
        return row ? [{ id: row.id, name: row.displayName ?? 'File', description: m.description }] : [];
      }),
      flows: skills.flows.flatMap((f) => {
        const row = flows.find((x) => x.id === f.flowId);
        return row ? [{ id: row.id, name: row.name, whenToUse: f.whenToUse }] : [];
      }),
      memory: skills.memory.flatMap((m) => {
        const row = attributes.find((x) => x.key === m.key);
        return row ? [{ key: row.key, label: row.label, type: row.type, description: m.description }] : [];
      }),
    };
  }
}
