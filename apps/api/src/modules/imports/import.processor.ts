import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { parse } from 'csv-parse';
import { v7 as uuidv7 } from 'uuid';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { isFinalAttempt } from '../../common/queue/attempts.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { csvField } from '../campaigns/csv.js';
import { isBlank, validateAttributeValue, type AttributeType, type AttributeValue } from '../contacts/attribute-validator.js';
import { ConsentService } from '../contacts/consent.service.js';
import { normaliseTag } from '../contacts/tags.controller.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ImportJobData, StoredImportMapping } from './imports.service.js';
import { DripEvents } from '../growth/drips/drip-events.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';

const BATCH_SIZE = 1000;

interface ImportRow {
  phoneE164: string;
  countryCode: string;
  name: string | null;
  attributes: Record<string, AttributeValue>;
  tags: string[];
  optInNote: string | null;
}

interface RowError {
  row: number;
  phone: string;
  reason: string;
}

/**
 * Contacts import (FR-010, T124, research R13): streams the CSV, normalises phones, validates
 * typed attributes and upserts contacts by phone in batches of 1,000 with
 * `INSERT ... ON CONFLICT (phone_e164)`. Tags are added (never removed), attributes are merged,
 * and opt-ins need a source (per-row column or a file-level note). Bad rows go to an error CSV.
 */
@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly consent: ConsentService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler<ImportJobData, void>(QUEUES.IMPORTS, 'contacts', (job: Job<ImportJobData>) =>
      this.process(job.data.importJobId, isFinalAttempt(job)),
    );
  }

  async process(importJobId: string, finalAttempt = true): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!job || job.kind !== 'CONTACTS' || job.status === 'COMPLETED') return;
    const mapping = job.mapping as unknown as StoredImportMapping;
    await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', error: null } });

    try {
      const { defaultCountryCode } = await this.settings.get();
      const attributeKeys = Object.keys(mapping.attributes ?? {});
      const types = new Map<string, AttributeType>(
        (await this.prisma.attributeDefinition.findMany({ where: { key: { in: attributeKeys } }, select: { key: true, type: true } })).map((d) => [d.key, d.type]),
      );
      const counts = { total: 0, created: 0, updated: 0, duplicates: 0 };
      const errors: RowError[] = [];
      const seen = new Set<string>();
      let batch: ImportRow[] = [];

      const flush = async () => {
        if (!batch.length) return;
        const result = await this.upsertBatch(batch, job.createdById);
        counts.created += result.created;
        counts.updated += result.updated;
        batch = [];
      };

      const parser = (await this.storage.getStream(job.fileKey)).pipe(
        parse({ bom: true, delimiter: mapping.delimiter, columns: (header: string[]) => header.map((h, i) => h.trim() || `column_${i + 1}`), skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true }),
      );
      for await (const record of parser as AsyncIterable<Record<string, string>>) {
        counts.total++;
        const rawPhone = (record[mapping.phone] ?? '').trim();
        const phone = normalizePhone(rawPhone, defaultCountryCode);
        if (!phone) {
          errors.push({ row: counts.total, phone: rawPhone, reason: rawPhone ? 'Not a valid phone number' : 'Phone number is empty' });
          continue;
        }
        const attributes: Record<string, AttributeValue> = {};
        let attributeError: string | null = null;
        for (const [key, column] of Object.entries(mapping.attributes ?? {})) {
          const raw = record[column];
          if (isBlank(raw)) continue;
          const checked = validateAttributeValue(types.get(key) ?? 'TEXT', raw);
          if (!checked.ok) {
            attributeError = `${key}: ${checked.issue}`;
            break;
          }
          attributes[key] = checked.value;
        }
        if (attributeError) {
          errors.push({ row: counts.total, phone: rawPhone, reason: attributeError });
          continue;
        }
        if (seen.has(phone.e164)) {
          counts.duplicates++;
          continue;
        }
        seen.add(phone.e164);
        const rowSource = mapping.optInSource ? (record[mapping.optInSource] ?? '').trim().slice(0, 500) : '';
        batch.push({
          phoneE164: phone.e164,
          countryCode: phone.country,
          name: mapping.name ? (record[mapping.name] ?? '').trim().slice(0, 120) || null : null,
          attributes,
          tags: mapping.tags
            ? [...new Set((record[mapping.tags] ?? '').split(/[;,|]/).map(normaliseTag).filter((t) => t && t.length <= 50))]
            : [],
          optInNote: rowSource || job.optInSourceNote || null,
        });
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();

      let errorFileKey: string | null = null;
      if (errors.length) {
        errorFileKey = job.fileKey.replace(/\.csv$/, '-errors.csv');
        const lines = ['row,phone,reason', ...errors.map((e) => [e.row, e.phone, e.reason].map(csvField).join(','))];
        await this.storage.put(errorFileKey, `${lines.join('\n')}\n`, 'text/csv');
      }
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          totalRows: counts.total,
          createdCount: counts.created,
          updatedCount: counts.updated,
          skippedCount: counts.duplicates,
          errorCount: errors.length,
          errorFileKey,
          finishedAt: new Date(),
        },
      });
      this.logger.log({ importJobId, rows: counts.total, created: counts.created, updated: counts.updated, errors: errors.length }, 'Contacts import processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // BullMQ retries the job; only its last attempt marks the import failed.
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: finalAttempt
          ? { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() }
          : { status: 'QUEUED', error: `Attempt failed, retrying: ${message}`.slice(0, 1000) },
      });
      throw error;
    }
  }

  private async upsertBatch(rows: ImportRow[], actorUserId: string): Promise<{ created: number; updated: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const values = rows.map((r) => {
          const optIn = r.optInNote !== null;
          return Prisma.sql`(${uuidv7()}::uuid, ${r.phoneE164}, ${r.countryCode}, ${r.name}, ${JSON.stringify(r.attributes)}::jsonb,
            ${optIn ? 'OPTED_IN' : 'UNKNOWN'}::"ConsentStatus", ${optIn ? 'IMPORT' : null}::"ConsentSource", ${r.optInNote}, ${optIn ? now : null}::timestamptz, 'Import', ${now}, ${now})`;
        });
        const upserted = await tx.$queryRaw<Array<{ id: string; phone_e164: string; inserted: boolean }>>`
          INSERT INTO contacts (id, phone_e164, country_code, name, attributes, consent_status, consent_source, consent_source_note, consent_at, lead_source, created_at, updated_at)
          VALUES ${Prisma.join(values)}
          ON CONFLICT (phone_e164) DO UPDATE
             SET name = COALESCE(EXCLUDED.name, contacts.name),
                 attributes = contacts.attributes || EXCLUDED.attributes,
                 updated_at = EXCLUDED.updated_at
          RETURNING id, phone_e164, (xmax = 0) AS inserted`;
        const byPhone = new Map(upserted.map((u) => [u.phone_e164, u]));

        const createdOptIns: Array<{ contactId: string; note: string }> = [];
        const existingOptIns: Array<{ contactId: string; note: string }> = [];
        for (const row of rows) {
          const saved = byPhone.get(row.phoneE164);
          if (!saved || row.optInNote === null) continue;
          (saved.inserted ? createdOptIns : existingOptIns).push({ contactId: saved.id, note: row.optInNote });
        }
        await this.consent.recordImportOptIns(tx, createdOptIns, existingOptIns, actorUserId, now);
        // Contacts new from this import can start drips (feature 005, FR-024).
        await this.dripEvents.recordCreated(tx, 'IMPORTED', upserted.filter((u) => u.inserted).map((u) => u.id));
        // Outbound webhooks (feature 006, FR-002).
        await this.platformEvents.contactsCreated(tx, upserted.filter((u) => u.inserted).map((u) => u.id), 'import');

        const tagNames = [...new Set(rows.flatMap((r) => r.tags))];
        if (tagNames.length) {
          await tx.tag.createMany({ data: tagNames.map((name) => ({ name })), skipDuplicates: true });
          const tagIds = new Map((await tx.tag.findMany({ where: { name: { in: tagNames } }, select: { id: true, name: true } })).map((t) => [t.name, t.id]));
          const links = rows.flatMap((r) => {
            const contactId = byPhone.get(r.phoneE164)?.id;
            return contactId ? r.tags.map((name) => ({ contactId, tagId: tagIds.get(name) as string })) : [];
          });
          if (links.length) {
            const added = await tx.contactTag.createManyAndReturn({ data: links, skipDuplicates: true, select: { contactId: true, tagId: true } });
            await this.dripEvents.recordTagAddedToMany(tx, added);
            await this.platformEvents.tagLinksChanged(tx, added);
          }
        }

        const created = upserted.filter((u) => u.inserted).length;
        return { created, updated: upserted.length - created };
      },
      // A busy pool must not fail a 50k-row import halfway, so wait up to 30 s for a connection.
      { maxWait: 30_000, timeout: 120_000 },
    );
  }
}
