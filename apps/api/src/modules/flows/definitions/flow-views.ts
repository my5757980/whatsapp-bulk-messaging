import { FlowGraphSchema, type FlowGraph, type FlowTrigger, type Problem } from '@wbm/shared';
import type { Prisma } from '../../../generated/prisma/client.js';

// Flow DTOs of contracts/flows-api.openapi.yaml (FlowSummary, FlowDetail).

export const FLOW_INCLUDE = {
  numbers: { select: { numberId: true } },
  publishedVersion: { select: { id: true, number: true, createdAt: true, graph: true, createdBy: { select: { id: true, name: true } } } },
  secrets: { select: { id: true, name: true, updatedAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.FlowInclude;

export type FlowRow = Prisma.FlowGetPayload<{ include: typeof FLOW_INCLUDE }>;

export function parseGraph(value: unknown): FlowGraph {
  return FlowGraphSchema.parse(value ?? {});
}

/** True when the draft differs from what customers meet. */
export function hasUnpublishedChanges(row: FlowRow): boolean {
  if (!row.publishedVersion) return false;
  return JSON.stringify(parseGraph(row.draft)) !== JSON.stringify(parseGraph(row.publishedVersion.graph));
}

/** One line per trigger for the flow list. */
export function describeTrigger(trigger: FlowTrigger): string {
  const quoted = (phrases: string[]) => phrases.filter((p) => p.trim()).map((p) => `"${p.trim()}"`).join(', ');
  switch (trigger.kind) {
    case 'KEYWORD':
      return `Keyword (${trigger.match === 'EXACT' ? 'exact' : 'contains'}): ${quoted(trigger.phrases)}`;
    case 'PATTERN':
      return `Pattern: ${trigger.pattern}`;
    case 'TEMPLATE_BUTTON':
      return `Template button "${trigger.buttonText}"`;
    case 'FIRST_MESSAGE':
      return `First message: ${quoted(trigger.phrases)}`;
  }
}

function base(row: FlowRow) {
  const published = row.publishedVersion;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    allNumbers: row.allNumbers,
    numberIds: row.numbers.map((n) => n.numberId),
    testNumbers: row.testNumbers,
    publishedVersion: published ? { id: published.id, number: published.number ?? 0, publishedAt: published.createdAt.toISOString(), publishedBy: published.createdBy } : null,
    draftUpdatedAt: row.draftUpdatedAt?.toISOString() ?? null,
    hasUnpublishedChanges: hasUnpublishedChanges(row),
  };
}

export function toFlowSummary(row: FlowRow, last7Days: { started: number; completed: number }) {
  const shown = row.publishedVersion ? parseGraph(row.publishedVersion.graph) : parseGraph(row.draft);
  return { ...base(row), triggers: shown.triggers.map(describeTrigger), last7Days };
}

export function toFlowDetail(row: FlowRow, problems?: Problem[]) {
  return {
    ...base(row),
    graph: parseGraph(row.draft),
    draftRevision: row.draftRevision,
    ...(problems ? { problems } : {}),
    secrets: row.secrets.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt.toISOString() })),
  };
}
