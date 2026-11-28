import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { parse } from 'csv-parse';
import type { Job } from 'bullmq';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { isFinalAttempt } from '../../common/queue/attempts.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { StorageService } from '../../common/storage/storage.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ConsentService, type UploadContact } from '../contacts/consent.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AudienceJobData } from './audience-upload.service.js';
import { csvField } from './csv.js';
import type { CampaignAudienceMapping } from './imports.js';

const BATCH_SIZE = 1000;

interface PendingRow extends UploadContact {
  rowNumber: number;
  data: Record<string, string>;
}

/**
 * Processes a campaign audience upload (T093, research R13): streams the CSV from storage,
 * normalises phones, replaces `campaign_upload_rows`, and upserts contacts with the confirmed
 * opt-in (opted-out contacts stay opted out). Counts and an error report go on `import_jobs`.
 */
@Injectable()
export class AudienceUploadProcessor implements OnModuleInit {
  private readonly logger = new Logger(AudienceUploadProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly consent: ConsentService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler<AudienceJobData, void>(QUEUES.IMPORTS, 'campaign-audience', (job: Job<AudienceJobData>) =>
      this.process(job.data.importJobId, isFinalAttempt(job)),
    );
  }

  async process(importJobId: string, finalAttempt = true): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!job || job.kind !== 'CAMPAIGN_AUDIENCE' || !job.campaignId || job.status === 'COMPLETED') return;
    const campaignId = job.campaignId;
    const mapping = job.mapping as unknown as CampaignAudienceMapping;
    await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', error: null } });

    try {
      const { defaultCountryCode } = await this.settings.get();
      // Feature 009 (research R10): "send to every row" keeps repeated numbers, each row with its own values.
      const everyRow = Boolean((await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { allowDuplicateRows: true } }))?.allowDuplicateRows);
      const seen = new Set<string>();
      let repeats: PendingRow[] = [];
      const errors: Array<{ row: number; value: string; reason: string }> = [];
      const counts = { total: 0, created: 0, updated: 0, duplicates: 0, optedOut: 0 };
      let batch: PendingRow[] = [];

      const flush = async () => {
        if (!batch.length && !repeats.length) return;
        if (batch.length) {
          const result = await this.consent.bulkConfirmOptIn(batch, job.optInSourceNote ?? '', job.createdById);
          counts.created += result.created;
          counts.updated += result.updated;
          counts.optedOut += result.optedOut;
        }
        // Repeated rows are stored with the rest, in file order; their consent came with the first row.
        const rows = [...batch, ...repeats].sort((a, b) => a.rowNumber - b.rowNumber);
        await this.prisma.campaignUploadRow.createMany({
          data: rows.map((r) => ({ campaignId, rowNumber: r.rowNumber, phoneE164: r.phoneE164, data: r.data as Prisma.InputJsonValue })),
          skipDuplicates: true,
        });
        batch = [];
        repeats = [];
      };

      await this.prisma.campaignUploadRow.deleteMany({ where: { campaignId } });
      const parser = (await this.storage.getStream(job.fileKey)).pipe(
        parse({ bom: true, delimiter: mapping.delimiter, columns: (header: string[]) => header.map((h, i) => h.trim() || `column_${i + 1}`), skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true }),
      );
      for await (const record of parser as AsyncIterable<Record<string, string>>) {
        counts.total++;
        const raw = (record[mapping.phoneColumn] ?? '').trim();
        const phone = normalizePhone(raw, defaultCountryCode);
        if (!phone) {
          errors.push({ row: counts.total, value: raw, reason: raw ? 'Not a valid phone number' : 'Phone number is empty' });
          continue;
        }
        if (seen.has(phone.e164)) {
          counts.duplicates++;
          if (everyRow) repeats.push({ rowNumber: counts.total, phoneE164: phone.e164, countryCode: phone.country, name: null, data: record });
          continue;
        }
        seen.add(phone.e164);
        const name = mapping.nameColumn ? (record[mapping.nameColumn] ?? '').trim().slice(0, 120) || null : null;
        batch.push({ rowNumber: counts.total, phoneE164: phone.e164, countryCode: phone.country, name, data: record });
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();

      let errorFileKey: string | null = null;
      if (errors.length) {
        errorFileKey = `${job.fileKey.replace(/\.csv$/, '')}-errors.csv`;
        const lines = ['row,value,reason', ...errors.map((e) => [e.row, e.value, e.reason].map(csvField).join(','))];
        await this.storage.put(errorFileKey, `${lines.join('\n')}\n`, 'text/csv');
      }
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          totalRows: counts.total,
          createdCount: counts.created,
          updatedCount: counts.updated,
          skippedCount: counts.duplicates + counts.optedOut,
          errorCount: errors.length,
          errorFileKey,
          finishedAt: new Date(),
        },
      });
      this.logger.log({ importJobId, campaignId, rows: counts.total, errors: errors.length }, 'Campaign audience processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // BullMQ retries the job; only its last attempt marks the upload failed.
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: finalAttempt
          ? { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() }
          : { status: 'QUEUED', error: `Attempt failed, retrying: ${message}`.slice(0, 1000) },
      });
      throw error;
    }
  }
}
