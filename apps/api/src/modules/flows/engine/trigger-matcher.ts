import { Injectable, Logger } from '@nestjs/common';
import { FlowGraphSchema, normalizePhrase, pickKeywordTrigger, unsafePatternReason, type FlowGraph } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { matchPattern } from './pattern-match.js';

export interface TriggerMatch {
  flowId: string;
  /** The published version; null runs the draft (a test number, FR-034). */
  versionId: string | null;
  triggerKey: string;
  canInterrupt: boolean;
  /** A pattern trigger's matched text, under the trigger's answer name. */
  answers?: Record<string, string>;
  /** A test run of the draft. */
  test?: boolean;
}

export interface FirstMessageRule {
  flowId: string;
  versionId: string;
  triggerKey: string;
  tagId: string | null;
  startFlow: boolean;
}

interface MessageFacts {
  text: string | null;
  /** wamid the customer replied to (a template quick-reply carries the template message). */
  replyToWaId: string | null;
}

interface MatchOptions {
  /** Only "can interrupt" triggers. */
  interruptingOnly?: boolean;
  /** Flows not to match (the flows a test number tests run their draft instead). */
  exclude?: string[];
}

/** Trigger rows of published flows serving a number, written for the current published version. */
const servingFlow = (numberId: string): Prisma.FlowWhereInput => ({ status: 'PUBLISHED', deletedAt: null, OR: [{ allNumbers: true }, { numbers: { some: { numberId } } }] });
const rowFilter = (options: MatchOptions) => ({
  ...(options.interruptingOnly ? { canInterrupt: true } : {}),
  ...(options.exclude?.length ? { flowId: { notIn: options.exclude } } : {}),
});
const FLOW_ORDER = { priority: true, createdAt: true, publishedVersionId: true } as const;
type Ordered = { flowVersionId: string; flow: { priority: number; createdAt: Date; publishedVersionId: string | null } };
const current = <T extends Ordered>(rows: T[]): T[] =>
  rows.filter((r) => r.flowVersionId === r.flow.publishedVersionId).sort((a, b) => a.flow.priority - b.flow.priority || a.flow.createdAt.getTime() - b.flow.createdAt.getTime());

/**
 * Finds the flow a customer message starts (003 T024, T064, T065, T070, research R2, FR-020):
 * exact keyword, then contains keyword (longest phrase first), then pattern, then template button;
 * ties go to the flow with the higher priority, then the older flow. First-message rules are checked
 * separately, only for a contact's first inbound message. Published trigger rows are read on every
 * message, without a worker cache; a test number's flows are matched from their drafts in memory.
 */
@Injectable()
export class TriggerMatcher {
  private readonly logger = new Logger(TriggerMatcher.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The published flow this message starts, in the FR-020 order. */
  async match(numberId: string, message: MessageFacts, options: MatchOptions = {}): Promise<TriggerMatch | null> {
    return (await this.keyword(numberId, message.text, options)) ?? (await this.pattern(numberId, message.text, options)) ?? (await this.templateButton(numberId, message, options));
  }

  async keyword(numberId: string, text: string | null, options: MatchOptions = {}): Promise<TriggerMatch | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'KEYWORD', ...rowFilter(options), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, match: true, phrase: true, canInterrupt: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    const candidates = current(rows)
      .filter((r) => r.phrase && r.match)
      .map((r) => ({
        flowId: r.flowId,
        versionId: r.flowVersionId,
        triggerKey: r.triggerKey,
        match: r.match!,
        phrase: r.phrase!,
        priority: r.flow.priority,
        flowCreatedAt: r.flow.createdAt,
        canInterrupt: r.canInterrupt,
      }));
    const winner = pickKeywordTrigger(text, candidates);
    return winner ? { flowId: winner.flowId, versionId: winner.versionId, triggerKey: winner.triggerKey, canInterrupt: winner.canInterrupt } : null;
  }

  /** Pattern triggers in flow order; each runs with a time limit (research R3). */
  async pattern(numberId: string, text: string | null, options: MatchOptions = {}): Promise<TriggerMatch | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'PATTERN', ...rowFilter(options), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, pattern: true, answerName: true, canInterrupt: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    for (const row of current(rows)) {
      const answers = row.pattern ? this.runPattern(row.flowId, row.triggerKey, row.pattern, row.answerName, text) : null;
      if (answers) return { flowId: row.flowId, versionId: row.flowVersionId, triggerKey: row.triggerKey, canInterrupt: row.canInterrupt, ...answers };
    }
    return null;
  }

  /** A quick-reply tap on a template message (context.id → 001 message → template) with the button's text. */
  async templateButton(numberId: string, message: MessageFacts, options: MatchOptions = {}): Promise<TriggerMatch | null> {
    const templateId = await this.templateOf(message);
    if (!templateId) return null;
    const tapped = normalizePhrase(message.text ?? '');
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'TEMPLATE_BUTTON', templateId, ...rowFilter(options), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, buttonText: true, canInterrupt: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    const row = current(rows).find((r) => normalizePhrase(r.buttonText ?? '') === tapped);
    return row ? { flowId: row.flowId, versionId: row.flowVersionId, triggerKey: row.triggerKey, canInterrupt: row.canInterrupt } : null;
  }

  /**
   * Test numbers (FR-034, research R2): the drafts of flows that list this sender as a test number,
   * matched in memory in the same order. `flowIds` are those flows, which published matching skips,
   * so a tester never meets the published version of a flow they are testing.
   */
  async forTester(senderPhone: string, message: MessageFacts, options: { interruptingOnly?: boolean } = {}): Promise<{ match: TriggerMatch | null; flowIds: string[] }> {
    const flows = await this.prisma.flow.findMany({ where: { deletedAt: null, testNumbers: { has: senderPhone } }, select: { id: true, priority: true, createdAt: true, draft: true } });
    const flowIds = flows.map((f) => f.id);
    const tested = flows
      .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime())
      .flatMap((flow) => {
        const parsed = FlowGraphSchema.safeParse(flow.draft);
        return parsed.success ? [{ flow, graph: parsed.data }] : [];
      });
    if (!tested.length) return { match: null, flowIds };
    const allowed = (trigger: FlowGraph['triggers'][number]) => !options.interruptingOnly || ('canInterrupt' in trigger && trigger.canInterrupt);
    const draft = (flowId: string, triggerKey: string, canInterrupt: boolean, extra: Partial<TriggerMatch> = {}): TriggerMatch => ({ flowId, versionId: null, triggerKey, canInterrupt, test: true, ...extra });

    if (message.text?.trim()) {
      const candidates = tested.flatMap(({ flow, graph }) =>
        graph.triggers.flatMap((t) =>
          t.kind === 'KEYWORD' && allowed(t)
            ? t.phrases
                .map(normalizePhrase)
                .filter(Boolean)
                .map((phrase) => ({ flowId: flow.id, versionId: null, triggerKey: t.id, match: t.match, phrase, priority: flow.priority, flowCreatedAt: flow.createdAt, canInterrupt: t.canInterrupt }))
            : [],
        ),
      );
      const keyword = pickKeywordTrigger(message.text, candidates);
      if (keyword) return { match: draft(keyword.flowId, keyword.triggerKey, keyword.canInterrupt), flowIds };
      for (const { flow, graph } of tested) {
        for (const t of graph.triggers) {
          if (t.kind !== 'PATTERN' || !allowed(t) || unsafePatternReason(t.pattern)) continue;
          const answers = this.runPattern(flow.id, t.id, t.pattern, t.answerName ?? null, message.text);
          if (answers) return { match: draft(flow.id, t.id, t.canInterrupt, answers), flowIds };
        }
      }
    }
    const templateId = await this.templateOf(message);
    if (templateId) {
      const tapped = normalizePhrase(message.text ?? '');
      for (const { flow, graph } of tested) {
        const t = graph.triggers.find((tr) => tr.kind === 'TEMPLATE_BUTTON' && allowed(tr) && tr.templateId === templateId && normalizePhrase(tr.buttonText) === tapped);
        if (t && t.kind === 'TEMPLATE_BUTTON') return { match: draft(flow.id, t.id, t.canInterrupt), flowIds };
      }
    }
    return { match: null, flowIds };
  }

  /** True when this is the contact's first inbound message on any number (it is already stored). */
  async isFirstInbound(contactId: string): Promise<boolean> {
    const inbound = await this.prisma.chatMessage.findMany({ where: { kind: 'INBOUND', conversation: { contactId } }, select: { id: true }, take: 2 });
    return inbound.length === 1;
  }

  /** The first-message rule this message matches (keyword-style phrases), if any. */
  async firstMessageRule(numberId: string, text: string | null, options: Pick<MatchOptions, 'exclude'> = {}): Promise<FirstMessageRule | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'FIRST_MESSAGE', ...rowFilter(options), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, match: true, phrase: true, firstMessageTagId: true, startFlow: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    const candidates = current(rows)
      .filter((r) => r.phrase && r.match)
      .map((r) => ({
        flowId: r.flowId,
        versionId: r.flowVersionId,
        triggerKey: r.triggerKey,
        match: r.match!,
        phrase: r.phrase!,
        priority: r.flow.priority,
        flowCreatedAt: r.flow.createdAt,
        canInterrupt: false,
        tagId: r.firstMessageTagId,
        startFlow: r.startFlow,
      }));
    const winner = pickKeywordTrigger(text, candidates);
    return winner ? { flowId: winner.flowId, versionId: winner.versionId, triggerKey: winner.triggerKey, tagId: winner.tagId, startFlow: winner.startFlow } : null;
  }

  /** The 001 template a quick-reply tap answers, if the message replies to one. */
  private async templateOf(message: MessageFacts): Promise<string | null> {
    if (!message.replyToWaId || !message.text?.trim()) return null;
    const sent = await this.prisma.message.findUnique({ where: { waMessageId: message.replyToWaId }, select: { templateId: true } });
    return sent?.templateId ?? null;
  }

  /** Runs one pattern; the answers to store when it matches, else null (timeouts are logged). */
  private runPattern(flowId: string, triggerKey: string, pattern: string, answerName: string | null, text: string): { answers?: Record<string, string> } | null {
    const result = matchPattern(pattern, text);
    if (result.matched) return answerName ? { answers: { [answerName]: result.value } } : {};
    if (result.timedOut) this.logger.warn({ flowId, triggerKey }, 'A pattern trigger took too long and was treated as no match');
    return null;
  }
}
