import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AI_LIMITS } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { parseConfig } from '../agents/agent-views.js';
import { ClaudeFailure } from '../claude/claude.client.js';
import type { KnowledgeItem } from '../claude/prompt.js';
import { AiUsageService } from '../usage/usage.service.js';
import { introFor } from './apply.js';
import { handOverFor, handOverReason } from './decisions.js';
import { TurnService } from './turn.service.js';

export const PreviewSchema = z.strictObject({
  messages: z
    .array(z.strictObject({ from: z.enum(['customer', 'agent']), text: z.string().min(1).max(4096) }))
    .min(1)
    .max(40),
  contact: z
    .strictObject({
      name: z.string().max(120).optional(),
      attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      tags: z.array(z.string().max(100)).max(50).optional(),
    })
    .optional(),
});
export type PreviewInput = z.infer<typeof PreviewSchema>;

export interface WouldDo {
  kind: 'HAND_OVER' | 'REMEMBER' | 'START_FLOW' | 'OPT_OUT' | 'CALL_SKILL' | 'UNANSWERED';
  description: string;
}

const WINDOW_SECONDS = 60;

/**
 * The preview chat (T060, FR-034): the draft answers a sample conversation exactly as a customer turn
 * would, but nothing is sent or changed. What the reply would do (hand over, remember, start a flow,
 * opt out, record a question) is listed instead. Usage is kept as PREVIEW, outside the monthly
 * count; each member may preview 20 times a minute.
 */
@Injectable()
export class PreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly turns: TurnService,
    private readonly usage: AiUsageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async preview(agentId: string, input: PreviewInput, userId: string) {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id: agentId, deletedAt: null }, select: { name: true, draft: true } });
    if (!agent) throw AppError.notFound('Agent not found');
    // The customer's last messages are this turn; what came before is the conversation so far.
    let split = input.messages.length;
    while (split > 0 && input.messages[split - 1]!.from === 'customer') split -= 1;
    const fresh = input.messages.slice(split);
    if (!fresh.length) throw AppError.validation('End the preview with a customer message', [{ field: 'messages', issue: 'the last message must be from the customer' }]);
    await this.limit(userId);

    const history = input.messages.slice(0, split);
    const config = parseConfig(agent.draft, agent.name);
    const firstReply = !history.some((m) => m.from === 'agent');
    const startedAt = Date.now();
    let result: Awaited<ReturnType<TurnService['think']>>;
    try {
      result = await this.turns.think({
        agentId,
        config,
        contact: { name: input.contact?.name ?? null, attributes: input.contact?.attributes ?? {}, tags: input.contact?.tags ?? [] },
        history,
        customerText: fresh.map((m) => m.text).join('\n'),
        firstReply,
        handOverNow: false,
        couldNotAnswerBefore: false,
        // Read-only skills run; skills that change data are only shown (FR-034).
        skills: { mode: 'preview', contact: { name: input.contact?.name ?? null, phoneE164: null, attributes: input.contact?.attributes ?? {} }, pending: null },
      });
    } catch (error) {
      if (error instanceof ClaudeFailure) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'AI_UNAVAILABLE', 'The AI service did not answer. Try again in a moment.');
      throw error;
    }
    const { reply, knownSources, usage, catalog, skillWouldDo } = result;
    const durationMs = Date.now() - startedAt;

    const settings = await this.usage.settings();
    const costMicros = this.usage.cost(usage, settings);
    await this.prisma.$transaction((tx) =>
      this.usage.record(tx, { kind: 'PREVIEW', agentId, numberId: null, test: false, usage, costMicros, at: new Date(), timezone: settings.timezone, countsAgainstMonth: false }),
    );

    const wouldDo: WouldDo[] = skillWouldDo.map((description) => ({ kind: 'CALL_SKILL' as const, description }));
    if (reply.optOut === 'clear') wouldDo.push({ kind: 'OPT_OUT', description: 'Would record that this customer does not want messages, and send nothing' });
    const handOver = handOverFor(reply, { whenUnsure: config.whenUnsure, unansweredBefore: 0, capReached: false });
    if (handOver) wouldDo.push({ kind: 'HAND_OVER', description: `Would hand the chat to your team: ${handOver.summary.trim() || handOverReason(handOver.reason)}` });
    for (const item of reply.remember ?? []) wouldDo.push({ kind: 'REMEMBER', description: `Would save ${item.key} = ${item.value}` });
    if (reply.startFlow) {
      const flow = catalog.flows.find((f) => f.id === reply.startFlow);
      wouldDo.push({ kind: 'START_FLOW', description: `Would start the flow "${flow?.name ?? reply.startFlow}"` });
    }
    if (reply.unanswered) wouldDo.push({ kind: 'UNANSWERED', description: `Would add to Unanswered: ${reply.unanswered}` });

    const message = firstReply && reply.message ? `${introFor(config, reply.language)}\n\n${reply.message}` : reply.message;
    const sources = reply.usedSources
      .map((id) => knownSources.get(id))
      .filter((item): item is KnowledgeItem => item !== undefined)
      .map((item) => ({ id: item.id, kind: item.kind, title: item.title }));
    return {
      reply: { message, language: reply.language, buttons: reply.buttons, list: reply.list, mediaId: reply.mediaId },
      sources,
      wouldDo,
      usage: { costUsd: costMicros / 1_000_000, durationMs },
    };
  }

  /** At most 20 previews per member in a minute that starts with the first one. */
  private async limit(userId: string): Promise<void> {
    const key = `wbm:ai:preview:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, WINDOW_SECONDS);
    if (count > AI_LIMITS.previewsPerMinute) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'PREVIEW_RATE_LIMITED', 'That is 20 previews in a minute. Wait a moment and try again.');
    }
  }
}
