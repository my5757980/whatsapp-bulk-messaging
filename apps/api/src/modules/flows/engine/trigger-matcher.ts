import { Injectable, Logger } from '@nestjs/common';
import { normalizePhrase, pickKeywordTrigger } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { matchPattern } from './pattern-match.js';

export interface TriggerMatch {
  flowId: string;
  versionId: string;
  triggerKey: string;
  canInterrupt: boolean;
  /** A pattern trigger's matched text, under the trigger's answer name. */
  answers?: Record<string, string>;
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

/** Trigger rows of published flows serving a number, written for the current published version. */
const servingFlow = (numberId: string): Prisma.FlowWhereInput => ({ status: 'PUBLISHED', deletedAt: null, OR: [{ allNumbers: true }, { numbers: { some: { numberId } } }] });
const FLOW_ORDER = { priority: true, createdAt: true, publishedVersionId: true } as const;
type Ordered = { flowVersionId: string; flow: { priority: number; createdAt: Date; publishedVersionId: string | null } };
const current = <T extends Ordered>(rows: T[]): T[] =>
  rows.filter((r) => r.flowVersionId === r.flow.publishedVersionId).sort((a, b) => a.flow.priority - b.flow.priority || a.flow.createdAt.getTime() - b.flow.createdAt.getTime());

/**
 * Finds the published flow a customer message starts (003 T024, T064, T065, research R2, FR-020):
 * exact keyword, then contains keyword (longest phrase first), then pattern, then template button;
 * ties go to the flow with the higher priority, then the older flow. First-message rules are checked
 * separately, only for a contact's first inbound message. Trigger rows are read on every message,
 * without a worker cache, so newly published flows apply at once.
 */
@Injectable()
export class TriggerMatcher {
  private readonly logger = new Logger(TriggerMatcher.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The flow this message starts, in the FR-020 order; `interruptingOnly` limits to "can interrupt" triggers. */
  async match(numberId: string, message: MessageFacts, options: { interruptingOnly?: boolean } = {}): Promise<TriggerMatch | null> {
    return (await this.keyword(numberId, message.text, options)) ?? (await this.pattern(numberId, message.text, options)) ?? (await this.templateButton(numberId, message, options));
  }

  async keyword(numberId: string, text: string | null, options: { interruptingOnly?: boolean } = {}): Promise<TriggerMatch | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'KEYWORD', ...(options.interruptingOnly ? { canInterrupt: true } : {}), flow: servingFlow(numberId) },
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
  async pattern(numberId: string, text: string | null, options: { interruptingOnly?: boolean } = {}): Promise<TriggerMatch | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'PATTERN', ...(options.interruptingOnly ? { canInterrupt: true } : {}), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, pattern: true, answerName: true, canInterrupt: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    for (const row of current(rows)) {
      if (!row.pattern) continue;
      const result = matchPattern(row.pattern, text);
      if (result.matched) {
        return { flowId: row.flowId, versionId: row.flowVersionId, triggerKey: row.triggerKey, canInterrupt: row.canInterrupt, ...(row.answerName ? { answers: { [row.answerName]: result.value } } : {}) };
      }
      if (result.timedOut) this.logger.warn({ flowId: row.flowId, triggerKey: row.triggerKey }, 'A pattern trigger took too long and was treated as no match');
    }
    return null;
  }

  /** A quick-reply tap on a template message (context.id → 001 message → template) with the button's text. */
  async templateButton(numberId: string, message: MessageFacts, options: { interruptingOnly?: boolean } = {}): Promise<TriggerMatch | null> {
    if (!message.replyToWaId || !message.text?.trim()) return null;
    const sent = await this.prisma.message.findUnique({ where: { waMessageId: message.replyToWaId }, select: { templateId: true } });
    if (!sent) return null;
    const tapped = normalizePhrase(message.text);
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'TEMPLATE_BUTTON', templateId: sent.templateId, ...(options.interruptingOnly ? { canInterrupt: true } : {}), flow: servingFlow(numberId) },
      select: { flowId: true, triggerKey: true, buttonText: true, canInterrupt: true, flowVersionId: true, flow: { select: FLOW_ORDER } },
    });
    const row = current(rows).find((r) => normalizePhrase(r.buttonText ?? '') === tapped);
    return row ? { flowId: row.flowId, versionId: row.flowVersionId, triggerKey: row.triggerKey, canInterrupt: row.canInterrupt } : null;
  }

  /** True when this is the contact's first inbound message on any number (it is already stored). */
  async isFirstInbound(contactId: string): Promise<boolean> {
    const inbound = await this.prisma.chatMessage.findMany({ where: { kind: 'INBOUND', conversation: { contactId } }, select: { id: true }, take: 2 });
    return inbound.length === 1;
  }

  /** The first-message rule this message matches (keyword-style phrases), if any. */
  async firstMessageRule(numberId: string, text: string | null): Promise<FirstMessageRule | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: { kind: 'FIRST_MESSAGE', flow: servingFlow(numberId) },
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
}
