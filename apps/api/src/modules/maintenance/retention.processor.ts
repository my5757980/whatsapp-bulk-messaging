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
// - live chat (002 FR-042): chat items, journey events and openings 12 months; old list previews are
//   cleared, and customer media no chat item uses any more is deleted with its file
// - chatbot flow sessions (003): ended sessions and their step records after 12 months.
// Audit logs are never purged here (the spec keeps them at least 12 months).

const DAY_MS = 24 * 3600 * 1000;
const CAMPAIGN_MONTHS = 12;
const SHORT_LIVED_DAYS = 30;
const UPLOADS_PREFIX = 'uploads/';
const BATCH = 5_000;

type PurgeTable = 'messages' | 'campaign_upload_rows' | 'webhook_events' | 'chat_messages' | 'conversation_events' | 'conversation_openings' | 'flow_sessions';

export interface LiveChatRetentionResult {
  chatItems: number;
  chatEvents: number;
  chatOpenings: number;
  chatMedia: number;
}

export interface RetentionResult extends LiveChatRetentionResult {
  campaigns: number;
  messages: number;
  webhookEvents: number;
  files: number;
  /** Chatbot flow sessions (and their step records) that ended over 12 months ago (003). */
  flowSessions: number;
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
    const result: RetentionResult = { campaigns: 0, messages: 0, webhookEvents: 0, files: 0, chatItems: 0, chatEvents: 0, chatOpenings: 0, chatMedia: 0, flowSessions: 0 };
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
    await step('live chat', async () => {
      Object.assign(result, await this.purgeLiveChat(now));
    });
    await step('flow sessions', async () => {
      result.flowSessions = await this.purgeFlowSessions(now);
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

  /** Chatbot flow sessions that ended over 12 months ago; their step records go with them (003 T083). */
  async purgeFlowSessions(now: Date): Promise<number> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    return this.deleteInBatches('flow_sessions', Prisma.sql`status = 'ENDED' AND ended_at < ${cutoff}`);
  }

  /** Live chat content older than 12 months (002 FR-042, data-model §6). Chats themselves stay. */
  async purgeLiveChat(now: Date): Promise<LiveChatRetentionResult> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    const chatItems = await this.deleteInBatches('chat_messages', Prisma.sql`occurred_at < ${cutoff}`);
    const chatEvents = await this.deleteInBatches('conversation_events', Prisma.sql`occurred_at < ${cutoff}`);
    const chatOpenings = await this.deleteInBatches('conversation_openings', Prisma.sql`opened_at < ${cutoff}`);
    // A quiet chat's preview is the text of a message that is now gone.
    await this.prisma.$executeRaw`
      UPDATE conversations SET last_message_preview = NULL
       WHERE last_activity_at < ${cutoff} AND last_message_preview IS NOT NULL`;
    const chatMedia = await this.purgeUnusedCustomerMedia(now);
    return { chatItems, chatEvents, chatOpenings, chatMedia };
  }

  /**
   * Customer media (INBOUND) that no chat item references any more, after retention or contact
   * erasure. The file goes first; a row stays when its file could not be deleted, for the next run.
   */
  async purgeUnusedCustomerMedia(now: Date): Promise<number> {
    const settled = new Date(now.getTime() - DAY_MS);
    let total = 0;
    for (;;) {
      const unused = await this.prisma.$queryRaw<Array<{ id: string; storage_key: string }>>`
        SELECT m.id, m.storage_key FROM media_assets m
         WHERE m.purpose = 'INBOUND' AND m.created_at < ${settled}
           AND NOT EXISTS (SELECT 1 FROM chat_messages c WHERE c.media_asset_id = m.id)
         LIMIT ${BATCH}`;
      const removed: string[] = [];
      for (const media of unused) {
        try {
          await this.storage.delete(media.storage_key);
          removed.push(media.id);
        } catch (error) {
          this.logger.warn({ err: (error as Error).message, mediaAssetId: media.id }, 'Could not delete a customer media file');
        }
      }
      if (removed.length) await this.prisma.mediaAsset.deleteMany({ where: { id: { in: removed } } });
      total += removed.length;
      if (removed.length < unused.length) throw new Error(`${unused.length - removed.length} customer media files could not be deleted`);
      if (unused.length < BATCH) return total;
    }
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
