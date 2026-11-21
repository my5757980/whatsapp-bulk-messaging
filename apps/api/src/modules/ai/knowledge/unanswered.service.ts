import { Injectable } from '@nestjs/common';
import { AI_LIMITS } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { AiUnansweredQuestion } from '../../../generated/prisma/client.js';
import type { AuditActor } from '../../audit/audit.service.js';
import { KnowledgeService } from './knowledge.service.js';

export const UnansweredQuerySchema = z.strictObject({ status: z.enum(['open', 'resolved']).default('open') });
export type UnansweredQuery = z.infer<typeof UnansweredQuerySchema>;
export const AnswerQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(AI_LIMITS.questionLength).optional(),
  answer: z.string().trim().min(1).max(AI_LIMITS.answerLength),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionSchema>;

function toDto(row: AiUnansweredQuestion) {
  return {
    id: row.id,
    text: row.text,
    askCount: row.askCount,
    firstAskedAt: row.firstAskedAt.toISOString(),
    lastAskedAt: row.lastAskedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Questions agents could not answer (T043, FR-015): counted per agent and normalised text while
 * open (UnansweredRecorder counts them during turns); answering one adds a written answer and
 * resolves it, dismissing resolves it as is.
 */
@Injectable()
export class UnansweredService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async list(agentId: string, query: UnansweredQuery) {
    await this.agentOrThrow(agentId);
    const rows = await this.prisma.aiUnansweredQuestion.findMany({
      where: { agentId, resolvedAt: query.status === 'open' ? null : { not: null } },
      orderBy: query.status === 'open' ? [{ askCount: 'desc' }, { lastAskedAt: 'desc' }] : [{ resolvedAt: 'desc' }],
      take: 200,
    });
    return rows.map(toDto);
  }

  async answer(agentId: string, questionId: string, input: AnswerQuestionInput, actor: AuditActor) {
    const question = await this.openQuestion(agentId, questionId);
    const source = await this.knowledge.addAnswer(agentId, { question: input.question ?? question.text, answer: input.answer }, actor);
    await this.prisma.aiUnansweredQuestion.update({ where: { id: questionId }, data: { resolvedAt: new Date(), resolvedById: actor.userId ?? null } });
    return source;
  }

  async dismiss(agentId: string, questionId: string, actor: AuditActor): Promise<void> {
    await this.openQuestion(agentId, questionId);
    await this.prisma.aiUnansweredQuestion.update({ where: { id: questionId }, data: { resolvedAt: new Date(), resolvedById: actor.userId ?? null } });
  }

  private async openQuestion(agentId: string, questionId: string): Promise<AiUnansweredQuestion> {
    await this.agentOrThrow(agentId);
    const row = await this.prisma.aiUnansweredQuestion.findFirst({ where: { id: questionId, agentId, resolvedAt: null } });
    if (!row) throw AppError.notFound('Question not found');
    return row;
  }

  private async agentOrThrow(agentId: string): Promise<void> {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
    if (!agent) throw AppError.notFound('Agent not found');
  }
}
