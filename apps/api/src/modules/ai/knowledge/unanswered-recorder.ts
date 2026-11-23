import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** Lower case, letters and digits only, single spaces: two wordings of one gap count together. */
export function normaliseQuestion(text: string): string {
  return [...text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()].slice(0, 300).join('');
}

/**
 * Counts a question an agent could not answer (FR-015), inside the turn's transaction. Open questions
 * are unique per agent and normalised text; each ask links to its AI conversation, so contact
 * deletion can remove it (FR-051).
 */
@Injectable()
export class UnansweredRecorder {
  async record(tx: Tx, agentId: string, aiConversationId: string, text: string): Promise<void> {
    const clean = [...text.replace(/\s+/g, ' ').trim()].slice(0, 300).join('');
    const normalised = normaliseQuestion(clean);
    if (!normalised) return;
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO ai_unanswered_questions (id, agent_id, text, normalized, ask_count, first_asked_at, last_asked_at)
      VALUES (gen_random_uuid(), ${agentId}::uuid, ${clean}, ${normalised}, 1, now(), now())
      ON CONFLICT (agent_id, normalized) WHERE resolved_at IS NULL
      DO UPDATE SET ask_count = ai_unanswered_questions.ask_count + 1, last_asked_at = now()
      RETURNING id`;
    if (row) await tx.aiUnansweredAsk.create({ data: { questionId: row.id, aiConversationId } });
  }
}
