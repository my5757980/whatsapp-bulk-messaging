import type { AssistantAction, AssistantRequest } from '../../../generated/prisma/client.js';
import type { AssistantDraft } from './assistant-tools.js';

/** The AssistantAction DTO of contracts/ai-api.openapi.yaml; a pending preview past its time shows as EXPIRED. */
export function toActionDto(action: AssistantAction, now: Date = new Date()) {
  const status = action.status === 'PENDING' && action.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : action.status;
  return {
    id: action.id,
    kind: action.kind,
    status,
    preview: (action.preview ?? {}) as Record<string, unknown>,
    expiresAt: action.expiresAt.toISOString(),
    result: (action.result ?? null) as Record<string, unknown> | null,
  };
}

export type AssistantRequestRow = AssistantRequest & { actions: AssistantAction[] };

/** The AssistantRequest DTO: the answer, the drafts made and the actions waiting for the member. */
export function toRequestDto(row: AssistantRequestRow, now: Date = new Date()) {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    reply: row.reply,
    drafts: (Array.isArray(row.drafts) ? row.drafts : []) as unknown as AssistantDraft[],
    actions: [...row.actions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((a) => toActionDto(a, now)),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    errorCode: row.errorCode,
  };
}
