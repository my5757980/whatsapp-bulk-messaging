import type { QuietHours } from '@wbm/shared';
import type { Prisma } from '../../../generated/prisma/client.js';
import { toTargetDto, type TrackedLinkTargetDto } from '../links/tracked-links.service.js';

// Drip response shapes (contracts/growth-api.openapi.yaml: DripSummary, DripDetail, Enrolment).

export interface DripProblem {
  code: 'NO_STEPS' | 'TEMPLATE_NOT_APPROVED' | 'VARIABLES_NOT_MAPPED' | 'NUMBER_NOT_CONNECTED' | 'WRONG_ACCOUNT' | 'HEADER_MEDIA_MISSING';
  message: string;
  stepPosition: number | null;
}

export interface DripSummaryDto {
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  pausedReason: string | null;
  number: { id: string; label: string };
  steps: number;
  active: number;
  finished: number;
  left: number;
  updatedAt: string;
}

export interface DripStepDto {
  id: string;
  position: number;
  template: { id: string; name: string; language: string; status: string };
  variableMapping: Record<string, unknown>;
  headerMediaAssetId: string | null;
  waitMinutes: number;
  trackedLinks: TrackedLinkTargetDto[];
}

export interface DripDetailDto extends DripSummaryDto {
  quietHours: QuietHours | null;
  leaveOnReply: boolean;
  leaveOnClick: boolean;
  stopTagIds: string[];
  allowRejoin: boolean;
  triggers: Array<{ kind: string; tagId: string | null; campaignId: string | null }>;
  stepList: DripStepDto[];
  problems: DripProblem[];
}

export const DRIP_INCLUDE = {
  number: { select: { id: true, label: true, wabaId: true, connectionStatus: true, sendingEnabled: true } },
  triggers: true,
  steps: {
    where: { deletedAt: null },
    orderBy: { position: 'asc' },
    include: { template: { select: { id: true, name: true, language: true, status: true, wabaId: true, components: true, variables: true } }, trackedLinkTargets: true },
  },
} satisfies Prisma.DripInclude;

export type DripRow = Prisma.DripGetPayload<{ include: typeof DRIP_INCLUDE }>;

export interface EnrolmentCounts {
  active: number;
  finished: number;
  left: number;
}

export function quietHoursOf(drip: Pick<DripRow, 'quietFrom' | 'quietTo' | 'quietDays'>): QuietHours | null {
  return drip.quietFrom && drip.quietTo ? { from: drip.quietFrom, to: drip.quietTo, days: drip.quietDays ?? [] } : null;
}

export function toSummaryDto(
  drip: Pick<DripRow, 'id' | 'name' | 'status' | 'pausedReason' | 'updatedAt'> & { number: { id: string; label: string } },
  steps: number,
  counts: EnrolmentCounts,
): DripSummaryDto {
  return {
    id: drip.id,
    name: drip.name,
    status: drip.status,
    pausedReason: drip.pausedReason,
    number: { id: drip.number.id, label: drip.number.label },
    steps,
    active: counts.active,
    finished: counts.finished,
    left: counts.left,
    updatedAt: drip.updatedAt.toISOString(),
  };
}

export function toDetailDto(drip: DripRow, counts: EnrolmentCounts, problems: DripProblem[]): DripDetailDto {
  return {
    ...toSummaryDto(drip, drip.steps.length, counts),
    quietHours: quietHoursOf(drip),
    leaveOnReply: drip.leaveOnReply,
    leaveOnClick: drip.leaveOnClick,
    stopTagIds: drip.stopTagIds ?? [],
    allowRejoin: drip.allowRejoin,
    triggers: drip.triggers.map((t) => ({ kind: t.kind, tagId: t.tagId, campaignId: t.campaignId })),
    stepList: drip.steps.map((s) => ({
      id: s.id,
      position: s.position,
      template: { id: s.template.id, name: s.template.name, language: s.template.language, status: s.template.status },
      variableMapping: (s.variableMapping ?? {}) as Record<string, unknown>,
      headerMediaAssetId: s.headerMediaAssetId,
      waitMinutes: s.waitMinutes,
      trackedLinks: s.trackedLinkTargets.map(toTargetDto).sort((a, b) => a.variableKey.localeCompare(b.variableKey)),
    })),
    problems,
  };
}
