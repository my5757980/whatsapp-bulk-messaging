import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { MB, type UploadedFileData } from '../../common/validation/uploaded-file.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { readCsvHeader } from './csv.js';
import { toImportJobDto, type CampaignAudienceMapping } from './imports.js';

// POST /campaigns/{id}/audience-upload (T093): validates the request and header, stores the
// file and queues processing. Opt-in confirmation with a source note is mandatory (FR-019).

export const MAX_UPLOAD_BYTES = 50 * MB;

export const AudienceUploadSchema = z.object({
  phoneColumn: z.string().trim().min(1, 'is required'),
  nameColumn: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  optInConfirmed: z.literal('true', { error: 'must be true: confirm that every contact in the file opted in' }),
  optInSourceNote: z.string().trim().min(3, 'describe where and how the contacts opted in').max(500),
});
export type AudienceUploadInput = z.infer<typeof AudienceUploadSchema>;

export interface AudienceJobData {
  importJobId: string;
}

@Injectable()
export class AudienceUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queues: QueueRegistry,
  ) {}

  async start(campaignId: string, file: UploadedFileData | undefined, input: AudienceUploadInput, userId: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { state: true, audienceType: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (campaign.state !== 'DRAFT') throw AppError.conflict('Recipients can only be uploaded to a draft campaign');
    if (campaign.audienceType !== 'UPLOAD') throw AppError.conflict('This campaign does not use an uploaded audience');
    if (!file?.size) throw AppError.validation('Choose a CSV file to upload', [{ field: 'file', issue: 'is required' }]);
    if (file.size > MAX_UPLOAD_BYTES) throw AppError.validation('File too large', [{ field: 'file', issue: 'must be at most 50 MB' }]);

    const { delimiter, columns } = readCsvHeader(file.buffer);
    const details = [];
    for (const [field, column] of [['phoneColumn', input.phoneColumn], ['nameColumn', input.nameColumn]] as const) {
      if (column && !columns.includes(column)) {
        details.push({ field, issue: `"${column}" is not a column in the file (found: ${columns.join(', ')})` });
      }
    }
    if (details.length) throw AppError.validation('Unknown column', details);

    const fileKey = `uploads/campaigns/${campaignId}/${randomUUID()}.csv`;
    await this.storage.put(fileKey, file.buffer, 'text/csv');
    const mapping: CampaignAudienceMapping = { phoneColumn: input.phoneColumn, delimiter, ...(input.nameColumn ? { nameColumn: input.nameColumn } : {}) };
    const job = await this.prisma.importJob.create({
      data: {
        kind: 'CAMPAIGN_AUDIENCE',
        campaignId,
        fileKey,
        mapping: mapping as unknown as Prisma.InputJsonValue,
        optInSourceNote: input.optInSourceNote,
        columns,
        createdById: userId,
      },
    });
    await this.queues
      .get(QUEUES.IMPORTS)
      .add('campaign-audience', { importJobId: job.id } satisfies AudienceJobData, {
        jobId: `import-${job.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      });
    return toImportJobDto(job);
  }
}
