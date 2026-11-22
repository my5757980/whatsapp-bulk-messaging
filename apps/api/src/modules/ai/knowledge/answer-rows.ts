import { answerChunk } from '@wbm/shared';
import type { Prisma } from '../../../generated/prisma/client.js';

/**
 * A written answer and its single chunk, inside the caller's transaction (T034, T094). Answers are
 * ready at once; `replaceMe` marks a starter's example answer, which blocks publishing (FR-005).
 */
export async function insertAnswer(
  tx: Prisma.TransactionClient,
  agentId: string,
  input: { question: string; answer: string },
  options: { replaceMe: boolean; createdById: string | null; createdAt?: Date },
) {
  const chunk = answerChunk(input.question, input.answer);
  const source = await tx.aiKnowledgeSource.create({
    data: {
      agentId,
      kind: 'ANSWER',
      title: input.question,
      question: input.question,
      answer: input.answer,
      status: 'READY',
      replaceMe: options.replaceMe,
      charCount: [...chunk.text].length,
      chunkCount: 1,
      lastRefreshedAt: new Date(),
      createdById: options.createdById,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
  await tx.aiKnowledgeChunk.create({ data: { sourceId: source.id, agentId, position: 0, title: input.question, text: chunk.text } });
  return source;
}
