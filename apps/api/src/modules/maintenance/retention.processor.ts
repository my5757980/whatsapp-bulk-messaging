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
// - AI agent (004 FR-051): AI conversations that ended over 12 months ago with their replies and
//   unanswered asks, older asks and replies, questions nobody asked for 12 months, and assistant
//   requests with their actions. Usage rows are anonymous and kept.
// - campaign growth (005 R12): link clicks after 12 months, drip enrolments 12 months after they
//   finished or left (their step records go with them), and starting events not consumed within a
//   day. Tracked links go with their messages through a foreign key cascade, so their codes stop
//   working when the messages are purged.
// - ads (007 R13): Meta's daily numbers after 25 months; leads, chats from ads and website ad visits
//   after 12 months.
// Audit logs are never purged here (the spec keeps them at least 12 months).

const DAY_MS = 24 * 3600 * 1000;
const CAMPAIGN_MONTHS = 12;
/** Meta's numbers stay longer so results can be compared year over year (007 R13). */
const AD_RESULT_MONTHS = 25;
const SHORT_LIVED_DAYS = 30;
const UPLOADS_PREFIX = 'uploads/';
const BATCH = 5_000;

type PurgeTable =
  | 'messages'
  | 'campaign_upload_rows'
  | 'webhook_events'
  | 'chat_messages'
  | 'conversation_events'
  | 'conversation_openings'
  | 'flow_sessions'
  | 'ai_conversations'
  | 'ai_replies'
  | 'ai_unanswered_asks'
  | 'assistant_requests'
  | 'link_clicks'
  | 'drip_enrolments'
  | 'drip_events'
  | 'outbound_events'
  | 'store_events'
  | 'api_campaign_triggers'
  | 'store_orders'
  | 'store_carts'
  | 'chat_link_opens'
  | 'chat_link_starts'
  | 'number_connection_checks'
  | 'ad_result_days'
  | 'ad_leads'
  | 'ad_chat_starts'
  | 'ad_link_opens';

/** Ads records removed by one run (007 R13). */
export interface AdsRetentionResult {
  adResultDays: number;
  adLeads: number;
  adChatStarts: number;
  adLinkOpens: number;
}

/** Integration records removed by one run (006 FR-059). */
export interface IntegrationsRetentionResult {
  outboundEvents: number;
  storeEvents: number;
  apiCampaignTriggers: number;
  storeOrders: number;
  storeCarts: number;
  chatLinkOpens: number;
  chatLinkStarts: number;
  connectionChecks: number;
}

/** Campaign growth records removed by one run (005). */
export interface GrowthRetentionResult {
  linkClicks: number;
  dripEnrolments: number;
  dripEvents: number;
}

/** AI records removed by one run (004). */
export interface AiRetentionResult {
  aiConversations: number;
  aiReplies: number;
  aiAsks: number;
  assistantRequests: number;
}

export interface LiveChatRetentionResult {
  chatItems: number;
  chatEvents: number;
  chatOpenings: number;
  chatMedia: number;
}

export interface RetentionResult extends LiveChatRetentionResult, AiRetentionResult, GrowthRetentionResult, IntegrationsRetentionResult, AdsRetentionResult {
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
    const result: RetentionResult = {
      campaigns: 0,
      messages: 0,
      webhookEvents: 0,
      files: 0,
      chatItems: 0,
      chatEvents: 0,
      chatOpenings: 0,
      chatMedia: 0,
      flowSessions: 0,
      aiConversations: 0,
      aiReplies: 0,
      aiAsks: 0,
      assistantRequests: 0,
      linkClicks: 0,
      dripEnrolments: 0,
      dripEvents: 0,
      outboundEvents: 0,
      storeEvents: 0,
      apiCampaignTriggers: 0,
      storeOrders: 0,
      storeCarts: 0,
      chatLinkOpens: 0,
      chatLinkStarts: 0,
      connectionChecks: 0,
      adResultDays: 0,
      adLeads: 0,
      adChatStarts: 0,
      adLinkOpens: 0,
    };
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
    await step('ai', async () => {
      Object.assign(result, await this.purgeAi(now));
    });
    await step('campaign growth', async () => {
      Object.assign(result, await this.purgeGrowth(now));
    });
    await step('integrations', async () => {
      Object.assign(result, await this.purgeIntegrations(now));
    });
    await step('ads', async () => {
      Object.assign(result, await this.purgeAds(now));
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

  /**
   * AI records (004 FR-051): AI conversations that ended over 12 months ago (their replies and
   * unanswered asks go with them), replies and asks older than that, questions nobody asked for 12
   * months, and assistant requests with their actions. Question counts follow the asks left.
   */
  async purgeAi(now: Date): Promise<AiRetentionResult> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    const aiConversations = await this.deleteInBatches('ai_conversations', Prisma.sql`status = 'ENDED' AND ended_at < ${cutoff}`);
    const aiReplies = await this.deleteInBatches('ai_replies', Prisma.sql`created_at < ${cutoff}`);
    const aiAsks = await this.deleteInBatches('ai_unanswered_asks', Prisma.sql`asked_at < ${cutoff}`);
    await this.prisma.$executeRaw`
      UPDATE ai_unanswered_questions q SET ask_count = c.n
        FROM (SELECT q2.id, count(a.id)::int AS n
                FROM ai_unanswered_questions q2 LEFT JOIN ai_unanswered_asks a ON a.question_id = q2.id
               GROUP BY q2.id) c
       WHERE c.id = q.id AND q.ask_count <> c.n`;
    await this.prisma.$executeRaw`DELETE FROM ai_unanswered_questions WHERE last_asked_at < ${cutoff}`;
    const assistantRequests = await this.deleteInBatches('assistant_requests', Prisma.sql`created_at < ${cutoff}`);
    return { aiConversations, aiReplies, aiAsks, assistantRequests };
  }

  /** Campaign growth records (005 R12, T061); tracked links go with their messages (cascade). */
  async purgeGrowth(now: Date): Promise<GrowthRetentionResult> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    const linkClicks = await this.deleteInBatches('link_clicks', Prisma.sql`clicked_at < ${cutoff}`);
    const dripEnrolments = await this.deleteInBatches('drip_enrolments', Prisma.sql`status <> 'ACTIVE' AND ended_at < ${cutoff}`);
    // The drip tick consumes events every 30 seconds; any left a day later are stale.
    const dripEvents = await this.deleteInBatches('drip_events', Prisma.sql`occurred_at < ${new Date(now.getTime() - DAY_MS)}`);
    return { linkClicks, dripEnrolments, dripEvents };
  }

  /**
   * Integration records (006 FR-059, data-model §5): outbound events (their deliveries go with them)
   * and raw store events after 30 days; API campaign triggers, store orders (with their messages),
   * carts (with their reminders), chat link openings and starts, and number checks after 12 months.
   */
  async purgeIntegrations(now: Date): Promise<IntegrationsRetentionResult> {
    const short = new Date(now.getTime() - SHORT_LIVED_DAYS * DAY_MS);
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    return {
      outboundEvents: await this.deleteInBatches('outbound_events', Prisma.sql`created_at < ${short}`),
      storeEvents: await this.deleteInBatches('store_events', Prisma.sql`received_at < ${short}`),
      apiCampaignTriggers: await this.deleteInBatches('api_campaign_triggers', Prisma.sql`created_at < ${cutoff}`),
      storeOrders: await this.deleteInBatches('store_orders', Prisma.sql`created_at < ${cutoff}`),
      storeCarts: await this.deleteInBatches('store_carts', Prisma.sql`created_at < ${cutoff}`),
      chatLinkOpens: await this.deleteInBatches('chat_link_opens', Prisma.sql`opened_at < ${cutoff}`),
      chatLinkStarts: await this.deleteInBatches('chat_link_starts', Prisma.sql`started_at < ${cutoff}`),
      connectionChecks: await this.deleteInBatches('number_connection_checks', Prisma.sql`created_at < ${cutoff}`),
    };
  }

  /** Ads records (007 R13): Meta's daily numbers after 25 months; leads, ad chats and visits after 12. */
  async purgeAds(now: Date): Promise<AdsRetentionResult> {
    const cutoff = monthsBefore(now, CAMPAIGN_MONTHS);
    const day = monthsBefore(now, AD_RESULT_MONTHS).toISOString().slice(0, 10);
    return {
      adResultDays: await this.deleteInBatches('ad_result_days', Prisma.sql`day < ${day}::date`),
      adLeads: await this.deleteInBatches('ad_leads', Prisma.sql`received_at < ${cutoff}`),
      adChatStarts: await this.deleteInBatches('ad_chat_starts', Prisma.sql`started_at < ${cutoff}`),
      adLinkOpens: await this.deleteInBatches('ad_link_opens', Prisma.sql`opened_at < ${cutoff}`),
    };
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
