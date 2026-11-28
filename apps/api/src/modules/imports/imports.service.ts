import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { MB, type UploadedFileData } from '../../common/validation/uploaded-file.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { readCsvHeader, type Delimiter } from '../campaigns/csv.js';
import { toImportJobDto } from '../campaigns/imports.js';

// POST /imports (FR-010, T124): validates the column mapping against the header and the
// attribute definitions, stores the file and queues processing.

export const MAX_IMPORT_BYTES = 50 * MB;

/** data-model.md: `{ phone, name?, tags?, attributes?: {key: column}, optInSource? }`. */
export const ImportMappingSchema = z
  .object({
    phone: z.string().trim().min(1, 'is required'),
    name: z.string().trim().min(1).optional(),
    tags: z.string().trim().min(1).optional(),
    attributes: z.record(z.string(), z.string().trim().min(1)).optional(),
    optInSource: z.string().trim().min(1).optional(),
  })
  .strict();
export type ImportMapping = z.infer<typeof ImportMappingSchema>;
export type StoredImportMapping = ImportMapping & { delimiter: Delimiter };

export const ImportFormSchema = z.object({
  mapping: z.string().min(1, 'is required'),
  optInSourceNote: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || undefined),
  /** Feature 010 (FR-011): the lead source label for contacts this import creates. */
  leadSourceLabel: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || undefined),
});
export type ImportForm = z.infer<typeof ImportFormSchema>;

export interface ImportJobData {
  importJobId: string;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queues: QueueRegistry,
  ) {}

  private parseMapping(raw: string): ImportMapping {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw AppError.validation('The column mapping is not valid', [{ field: 'mapping', issue: 'must be valid JSON' }]);
    }
    const parsed = ImportMappingSchema.safeParse(json);
    if (!parsed.success) {
      throw AppError.validation(
        'The column mapping is not valid',
        parsed.error.issues.map((i) => ({ field: ['mapping', ...i.path].join('.'), issue: i.message })),
      );
    }
    return parsed.data;
  }

  async start(file: UploadedFileData | undefined, form: ImportForm, userId: string) {
    if (!file?.size) throw AppError.validation('Choose a CSV file to import', [{ field: 'file', issue: 'is required' }]);
    if (file.size > MAX_IMPORT_BYTES) throw AppError.validation('File too large', [{ field: 'file', issue: 'must be at most 50 MB' }]);
    if (form.optInSourceNote !== undefined && form.optInSourceNote.length < 3) {
      throw AppError.validation('Describe where the contacts opted in', [{ field: 'optInSourceNote', issue: 'must be at least 3 characters' }]);
    }
    const mapping = this.parseMapping(form.mapping);
    const { delimiter, columns } = readCsvHeader(file.buffer);

    const errors: ErrorDetail[] = [];
    const mapped: Array<[string, string]> = [
      ['mapping.phone', mapping.phone],
      ...(mapping.name ? [['mapping.name', mapping.name] as [string, string]] : []),
      ...(mapping.tags ? [['mapping.tags', mapping.tags] as [string, string]] : []),
      ...(mapping.optInSource ? [['mapping.optInSource', mapping.optInSource] as [string, string]] : []),
      ...Object.entries(mapping.attributes ?? {}).map(([key, column]) => [`mapping.attributes.${key}`, column] as [string, string]),
    ];
    for (const [field, column] of mapped) {
      if (!columns.includes(column)) errors.push({ field, issue: `"${column}" is not a column in the file (found: ${columns.join(', ')})` });
    }
    const keys = Object.keys(mapping.attributes ?? {});
    if (keys.length) {
      const defined = new Set((await this.prisma.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((d) => d.key));
      for (const key of keys) if (!defined.has(key)) errors.push({ field: `mapping.attributes.${key}`, issue: 'is not a defined attribute' });
    }
    if (errors.length) throw AppError.validation('The column mapping does not match the file', errors);

    const fileKey = `uploads/imports/${randomUUID()}.csv`;
    await this.storage.put(fileKey, file.buffer, 'text/csv');
    const stored: StoredImportMapping = { ...mapping, delimiter };
    const job = await this.prisma.importJob.create({
      data: {
        kind: 'CONTACTS',
        fileKey,
        mapping: stored as unknown as Prisma.InputJsonValue,
        optInSourceNote: form.optInSourceNote ?? null,
        leadSourceLabel: form.leadSourceLabel ?? null,
        columns,
        createdById: userId,
      },
    });
    await this.queues
      .get(QUEUES.IMPORTS)
      .add('contacts', { importJobId: job.id } satisfies ImportJobData, { jobId: `import-${job.id}`, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } });
    return toImportJobDto(job);
  }

  async getJob(id: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job) throw AppError.notFound('Import not found');
    return toImportJobDto(job);
  }

  /** Storage key of the row-level error report, or 404 when the import has none. */
  async errorReportKey(id: string): Promise<string> {
    const job = await this.prisma.importJob.findUnique({ where: { id }, select: { errorFileKey: true } });
    if (!job) throw AppError.notFound('Import not found');
    if (!job.errorFileKey) throw AppError.notFound('This import has no error report');
    return job.errorFileKey;
  }
}
