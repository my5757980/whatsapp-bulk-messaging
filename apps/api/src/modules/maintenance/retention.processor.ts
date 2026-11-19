import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { Prisma } from '../../generated/prisma/client.js';

// Data retention (data-model.md §Retention, T195):
// - finished campaigns and their messages: 12 months after they ended; API messages: 12 months
// - webhook events and uploaded CSV files (sources and error reports): 30 days
// Audit logs are never purged here (the spec keeps them at least 12 months).

const DAY_MS = 24 * 3600 * 1000;
const CAMPAIGN_MONTHS = 12;
const SHORT_LIVED_DAYS = 30;
const UPLOADS_PREFIX = 'uploads/';
const BATCH = 5_000;

type PurgeTable = 'messages' | 'campaign_upload_rows' | 'webhook_events';

export interface RetentionResult {
  campaigns: number;
  messages: number;
  webhookEvents: number;
  files: number;
}

export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Runs every purge; one failing step does not stop the others, but fails the job. */
  async run(now = new Date()): Promise<RetentionResult> {
    const result: RetentionResult = { campaigns: 0, messages: 0, webhookEvents: 0, files: 0 };
    const failures: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    };
    await step('campaigns', async () => {
      Object.assign(result, await this.purgeCampaigns(now));
    });
    await step('webhook events', async () => {
      result.webhookEvents = await this.purgeWebhookEvents(now);
    });
    await step('files', async () => {
      result.files = await this.purgeUploadFiles(now);
    });
    this.logger.log({ ...result }, 'Retention run finished');
    if (failures.length) throw new Error(`Retention partly failed: ${failures.join('; ')}`);
    return result;
  }

  /** Completed or cancelled campaigns that ended over 12 months ago, plus old API messages. */
  async purgeCampaigns(now: Date): Promise<{ campaigns: number; messages: number }> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    const campaigns = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM campaigns
       WHERE state IN ('COMPLETED', 'CANCELLED')
         AND COALESCE(completed_at, cancelled_at, updated_at) < ${cutoff}`;
    let messages = 0;
    for (const { id } of campaigns) {
      // Large children first, in batches; the campaign delete then cascades import jobs and
      // sets retargets' source to null.
      messages += await this.deleteInBatches('messages', Prisma.sql`campaign_id = ${id}::uuid`);
      await this.deleteInBatches('campaign_upload_rows', Prisma.sql`campaign_id = ${id}::uuid`);
      await this.prisma.campaign.delete({ where: { id } });
    }
    messages += await this.deleteInBatches('messages', Prisma.sql`campaign_id IS NULL AND created_at < ${cutoff}`);
    return { campaigns: campaigns.length, messages };
  }

  async purgeWebhookEvents(now: Date): Promise<number> {
    return this.deleteInBatches('webhook_events', Prisma.sql`received_at < ${new Date(now.getTime() - SHORT_LIVED_DAYS * DAY_MS)}`);
  }

  /** Uploaded CSVs and error reports; the bucket listing is the source of truth for what is left. */
  async purgeUploadFiles(now: Date, prefix = UPLOADS_PREFIX): Promise<number> {
    const keys = await this.storage.listKeysOlderThan(prefix, new Date(now.getTime() - SHORT_LIVED_DAYS * DAY_MS));
    for (const key of keys) await this.storage.delete(key);
    for (let i = 0; i < keys.length; i += 1_000) {
      const chunk = keys.slice(i, i + 1_000);
      await this.prisma.importJob.updateMany({ where: { errorFileKey: { in: chunk } }, data: { errorFileKey: null } });
    }
    return keys.length;
  }

  /** Deletes matching rows in batches so no single statement holds locks for long. */
  private async deleteInBatches(table: PurgeTable, where: Prisma.Sql): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM ${Prisma.raw(table)} WHERE id IN (SELECT id FROM ${Prisma.raw(table)} WHERE ${where} LIMIT ${BATCH})`;
      total += deleted;
      if (deleted < BATCH) return total;
    }
  }
}

/** Daily retention job (03:15 UTC) on the maintenance queue. */
@Injectable()
export class RetentionProcessor implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly retention: RetentionService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, 'retention', () => this.retention.run());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler('retention', { pattern: '15 3 * * *', tz: 'UTC' }, { name: 'retention', opts: { removeOnComplete: 30, removeOnFail: 30 } });
  }
}
