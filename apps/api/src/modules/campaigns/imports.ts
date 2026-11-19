import type { ImportJob } from '../../generated/prisma/client.js';

/** Response shape of an import job (contract `ImportJob`). */
export function toImportJobDto(job: ImportJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    totalRows: job.totalRows,
    createdCount: job.createdCount,
    updatedCount: job.updatedCount,
    skippedCount: job.skippedCount,
    errorCount: job.errorCount,
    columns: job.columns,
    hasErrorReport: Boolean(job.errorFileKey),
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export interface CampaignAudienceMapping {
  phoneColumn: string;
  nameColumn?: string;
  delimiter: ',' | ';' | '\t';
}
