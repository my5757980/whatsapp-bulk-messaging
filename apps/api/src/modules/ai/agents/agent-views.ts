import { AgentConfigSchema, defaultAgentConfig, type AgentConfig, type AgentProblem } from '@wbm/shared';
import type { Prisma } from '../../../generated/prisma/client.js';

// Agent DTOs of contracts/ai-api.openapi.yaml (AgentSummary, AgentDetail).

export const AGENT_INCLUDE = {
  numbers: { select: { numberId: true, number: { select: { id: true, displayPhoneNumber: true } } }, orderBy: { assignedAt: 'asc' } },
  publishedVersion: { select: { id: true, number: true, createdAt: true, config: true, createdBy: { select: { id: true, name: true } } } },
  secrets: { select: { id: true, name: true, updatedAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.AiAgentInclude;

export type AgentRow = Prisma.AiAgentGetPayload<{ include: typeof AGENT_INCLUDE }>;

/** A stored configuration; an unreadable one (never expected) falls back to the defaults. */
export function parseConfig(value: unknown, displayName = 'Assistant'): AgentConfig {
  const parsed = AgentConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultAgentConfig(displayName);
}

/** True when the draft differs from what customers meet. */
export function hasUnpublishedChanges(row: AgentRow): boolean {
  if (!row.publishedVersion) return false;
  return JSON.stringify(parseConfig(row.draft)) !== JSON.stringify(parseConfig(row.publishedVersion.config));
}

export function toAgentSummary(row: AgentRow, last7Days: { replies: number; handedOver: number }) {
  const published = row.publishedVersion;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    numbers: row.numbers.map((n) => ({ id: n.number.id, displayPhone: n.number.displayPhoneNumber })),
    testNumbers: row.testNumbers,
    publishedVersion: published ? { id: published.id, number: published.number, publishedAt: published.createdAt.toISOString(), publishedBy: published.createdBy } : null,
    hasUnpublishedChanges: hasUnpublishedChanges(row),
    last7Days,
  };
}

export function toAgentDetail(row: AgentRow, problems: AgentProblem[], last7Days = { replies: 0, handedOver: 0 }) {
  return {
    ...toAgentSummary(row, last7Days),
    config: parseConfig(row.draft, row.name),
    draftRevision: row.draftRevision,
    draftUpdatedAt: row.draftUpdatedAt?.toISOString() ?? null,
    problems,
    starterKey: row.starterKey,
    secrets: row.secrets.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt.toISOString() })),
  };
}
