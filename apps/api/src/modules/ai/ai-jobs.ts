import type { JobsOptions } from 'bullmq';
import { AI_LIMITS } from '@wbm/shared';

// Job names and options on the `ai` and `ai-knowledge` queues (feature 004, research R5, R11).

export const AI_TURN_JOB = 'ai-turn';
export const AI_EXPIRY_JOB = 'ai-expiry';
export const ASSISTANT_REQUEST_JOB = 'assistant-request';
export const KNOWLEDGE_PROCESS_JOB = 'knowledge-process';
export const KNOWLEDGE_REFRESH_DUE_JOB = 'knowledge-refresh-due';

export interface AiTurnJobData {
  conversationId: string;
}

/**
 * A debounced customer turn (FR-018): messages within the debounce window replace the delayed job,
 * so a burst becomes one turn; a message that arrives while the turn runs is kept and starts one
 * more turn when this one finishes (BullMQ `keepLastIfActive`), so no message is left unanswered.
 */
export function aiTurnJob(conversationId: string): { name: string; data: AiTurnJobData; opts: JobsOptions } {
  return {
    name: AI_TURN_JOB,
    data: { conversationId },
    opts: {
      delay: AI_LIMITS.debounceMs,
      deduplication: { id: `ai-turn-${conversationId}`, replace: true, keepLastIfActive: true },
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  };
}

export interface AssistantRequestJobData {
  requestId: string;
}

/** A team assistant request (US9, research R14): runs once; a failure is shown on the request. */
export function assistantRequestJob(requestId: string): { name: string; data: AssistantRequestJobData; opts: JobsOptions } {
  return {
    name: ASSISTANT_REQUEST_JOB,
    data: { requestId },
    opts: { jobId: `assistant-${requestId}`, attempts: 1, removeOnComplete: true, removeOnFail: 100 },
  };
}

export interface KnowledgeProcessJobData {
  sourceId: string;
}

/** Reading one file or website; one job per source at a time. */
export function knowledgeProcessJob(sourceId: string): { name: string; data: KnowledgeProcessJobData; opts: JobsOptions } {
  return {
    name: KNOWLEDGE_PROCESS_JOB,
    data: { sourceId },
    opts: {
      deduplication: { id: `knowledge-${sourceId}`, keepLastIfActive: true },
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  };
}
