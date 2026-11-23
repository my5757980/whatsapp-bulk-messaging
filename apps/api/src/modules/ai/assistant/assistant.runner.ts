import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { ASSISTANT_REQUEST_JOB, type AssistantRequestJobData } from '../ai-jobs.js';
import { ClaudeClient, ClaudeFailure } from '../claude/claude.client.js';
import { AiQueueProcessor } from '../turns/ai-queue.processor.js';
import { AiUsageService } from '../usage/usage.service.js';
import { ASSISTANT_SYSTEM, AssistantContext } from './assistant-prompt.js';
import { AssistantTools, newOutcome } from './assistant-tools.js';

/** Contracts/claude-messages.md section 6: drafts can be long, so the turn streams with room to write. */
export const ASSISTANT_LIMITS = { maxTokens: 32_000, maxIterations: 8, deadlineMs: 240_000 } as const;

/**
 * Answers one team assistant request in the worker (004 T100, research R14): Claude Opus 5.5 at
 * effort medium with the assistant tools acting as the member. The answer, the drafts and the token
 * use are stored on the request; a request is counted against the monthly limit once it is answered.
 */
@Injectable()
export class AssistantRunner {
  private readonly logger = new Logger(AssistantRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeClient,
    private readonly tools: AssistantTools,
    private readonly context: AssistantContext,
    private readonly usage: AiUsageService,
    private readonly metrics: MetricsService,
  ) {}

  async run(requestId: string): Promise<void> {
    const claimed = await this.prisma.assistantRequest.updateMany({ where: { id: requestId, status: 'QUEUED' }, data: { status: 'RUNNING' } });
    if (!claimed.count) return;
    const request = await this.prisma.assistantRequest.findUniqueOrThrow({ where: { id: requestId }, include: { user: { select: { id: true, role: true, status: true } } } });
    const outcome = newOutcome();
    const finish = (data: Prisma.AssistantRequestUpdateInput) =>
      this.prisma.assistantRequest.update({ where: { id: requestId }, data: { drafts: outcome.drafts as unknown as Prisma.InputJsonValue, finishedAt: new Date(), ...data } });

    if (request.user.status !== 'ACTIVE') {
      await finish({ status: 'FAILED', errorCode: 'REFUSED', reply: 'This member can no longer use the assistant.' });
      this.metrics.aiAssistantRequestsTotal.inc({ outcome: 'refused' });
      return;
    }
    if (!this.claude.configured) {
      await finish({ status: 'FAILED', errorCode: 'AI_UNAVAILABLE' });
      this.metrics.aiAssistantRequestsTotal.inc({ outcome: 'failed' });
      return;
    }

    const member = { userId: request.user.id, role: request.user.role, requestId };
    const settings = await this.usage.settings();
    try {
      const result = await this.claude.runTurn({
        system: [{ type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: await this.context.describe(member.role) },
              { type: 'text', text: request.prompt },
            ],
          },
        ],
        tools: this.tools.build(member, outcome),
        effort: 'medium',
        stream: true,
        ...ASSISTANT_LIMITS,
      });
      const cost = this.usage.cost(result.usage, settings);
      const now = new Date();
      // Refused for permissions with nothing made: the reply explains it, and the request says so.
      const refusedOnly = outcome.refused.length > 0 && !outcome.drafts.length && !outcome.actionIds.length;
      await this.prisma.$transaction(async (tx) => {
        await tx.assistantRequest.update({
          where: { id: requestId },
          data: {
            status: 'DONE',
            reply: result.text,
            drafts: outcome.drafts as unknown as Prisma.InputJsonValue,
            errorCode: refusedOnly ? 'REFUSED' : null,
            inputTokens: result.usage.inputTokens,
            cacheReadTokens: result.usage.cacheReadTokens,
            cacheWriteTokens: result.usage.cacheWriteTokens,
            outputTokens: result.usage.outputTokens,
            costMicros: BigInt(Math.round(cost)),
            finishedAt: now,
          },
        });
        await this.usage.record(tx, {
          kind: 'ASSISTANT',
          agentId: null,
          numberId: null,
          test: false,
          usage: result.usage,
          costMicros: cost,
          at: now,
          timezone: settings.timezone,
          countsAgainstMonth: true,
        });
      });
      this.metrics.aiAssistantRequestsTotal.inc({ outcome: refusedOnly ? 'refused' : 'done' });
    } catch (error) {
      // Drafts and previews made before the failure stay, listed on the request.
      const reason = error instanceof ClaudeFailure ? error.reason : 'UNAVAILABLE';
      this.logger.warn({ requestId, reason, err: (error as Error).message }, 'Assistant request failed');
      await finish({ status: 'FAILED', errorCode: 'AI_UNAVAILABLE' });
      this.metrics.aiAssistantRequestsTotal.inc({ outcome: 'failed' });
    }
  }
}

/** Routes `assistant-request` jobs on the ai queue to the runner (worker only). */
@Injectable()
export class AssistantProcessor implements OnModuleInit {
  constructor(
    private readonly aiQueue: AiQueueProcessor,
    private readonly runner: AssistantRunner,
  ) {}

  onModuleInit(): void {
    this.aiQueue.handle(ASSISTANT_REQUEST_JOB, (job) => this.runner.run((job.data as AssistantRequestJobData).requestId));
  }
}
