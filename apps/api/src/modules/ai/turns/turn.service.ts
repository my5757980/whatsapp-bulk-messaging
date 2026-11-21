import { Injectable, Logger } from '@nestjs/common';
import { AGENT_REPLY_JSON_SCHEMA, AgentReplySchema, AI_LIMITS, isWithinHours, sanitiseReply, type AgentReply, type AttributeKind, type TokenUsage } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { ChatContentType } from '../../../generated/prisma/client.js';
import { isLive } from '../../inbox/conversations/window.js';
import { LiveChatSettingsService } from '../../inbox/settings/live-chat-settings.service.js';
import { ClaudeClient, ClaudeFailure } from '../claude/claude.client.js';
import { buildPrompt, contactFacts, renderSource, type KnowledgeItem, type PromptCatalog } from '../claude/prompt.js';
import { buildTools } from '../claude/tools.js';
import { KnowledgeSearch } from '../knowledge/knowledge-search.js';
import { AiUsageService } from '../usage/usage.service.js';
import { AgentSelector, type SelectedAgent } from './agent-selector.js';
import { TurnApplier } from './apply.js';
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

export type TurnResult = 'SENT' | 'NOTHING' | 'NOT_ELIGIBLE' | 'DROPPED' | 'NEWER' | 'FAILED';

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
 * One customer turn (research R5, T042): gather the messages no reply covered yet, build the prompt,
 * run the bounded tool loop, validate the reply and hand it to the applier. Failures are logged
 * here; the fallback message and hand-over arrive with US2.
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
  ) {}

  async run(conversationId: string): Promise<TurnResult> {
    const startedAt = new Date();
    const chat = await this.loadChat(conversationId);
    if (!chat?.contact || !this.answerable(chat)) return 'NOT_ELIGIBLE';
    const agent = await this.selector.select({ id: chat.id, numberId: chat.numberId }, chat.contact.phoneE164);
    if (!agent) return 'NOT_ELIGIBLE';

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

    try {
      const { reply, knownSources, usage, model } = await this.decide(chat, agent, texts.join('\n'));
      const settings = await this.usage.settings();
      const outcome = await this.applier.apply({
        conversationId: chat.id,
        numberId: chat.numberId,
        contactId: chat.contact.id,
        agent,
        handledUntil,
        handledIds,
        firstMessageAt,
        reply,
        knownSources,
        usage,
        model,
        startedAt,
        settings,
      });
      return outcome.result;
    } catch (error) {
      if (error instanceof ClaudeFailure) {
        this.logger.warn({ conversationId, agentId: agent.agentId, reason: error.reason, status: error.status, requestId: error.requestId }, 'AI turn failed');
        return 'FAILED';
      }
      throw error;
    }
  }

  /** Builds the prompt, runs the model and returns the sanitised reply. */
  private async decide(chat: ChatRow, agent: SelectedAgent, customerText: string) {
    const config = agent.config;
    const contact = chat.contact!;
    const allowedAttributes = config.skills.memory.map((m) => m.key);

    const total = await this.search.totalChars(agent.agentId);
    const mode = total <= AI_LIMITS.wholeKnowledgeChars ? 'WHOLE' : 'SEARCH';
    const items = await this.search.items(agent.agentId, mode === 'SEARCH');
    const retrieved = mode === 'SEARCH' ? await this.search.retrieve(agent.agentId, customerText) : [];
    const knownSources = new Map<string, KnowledgeItem>();
    for (const item of [...items, ...retrieved]) knownSources.set(item.id, item);

    const [catalog, history, live] = await Promise.all([this.catalog(agent), this.history(chat.id, agent), this.liveChat.get()]);
    const now = new Date();
    const prompt = buildPrompt({
      config,
      catalog,
      knowledge: { mode, items },
      retrieved,
      history,
      customerText,
      turn: {
        contact: contactFacts({ name: contact.name, attributes: (contact.attributes ?? {}) as Record<string, unknown>, tags: contact.tags.map((t) => t.tag.name) }, allowedAttributes),
        localTime: localStamp(live.timezone, now),
        timeZone: live.timezone,
        teamOpen: isWithinHours(live.workingHours, live.timezone, now),
        nextOpening: nextOpening(live.workingHours, live.timezone, now),
        firstReply: agent.replies === 0,
        pendingConfirmation: null,
      },
    });

    let searches = 0;
    const tools = buildTools({
      searchKnowledge: async (query) => {
        searches += 1;
        if (searches > AI_LIMITS.searchCallsPerTurn) return '<results>\nThe search limit for this turn is reached; answer with what you have.\n</results>';
        const found = await this.search.searchForTool(agent.agentId, query, renderSource);
        for (const item of found.items) knownSources.set(item.id, item);
        return found.text;
      },
      skills: [],
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
    if (dropped.length) this.logger.log({ agentId: agent.agentId, dropped }, 'Parts of an AI reply were dropped');
    return { reply, knownSources, usage: result.usage as TokenUsage, model: result.model };
  }

  private answerable(chat: ChatRow): boolean {
    const contact = chat.contact!;
    return chat.state === 'ACTIVE' && !contact.blockedAt && contact.consentStatus !== 'OPTED_OUT' && isLive(chat.lastCustomerMessageAt);
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
  private async catalog(agent: SelectedAgent): Promise<PromptCatalog> {
    const skills = agent.config.skills;
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
