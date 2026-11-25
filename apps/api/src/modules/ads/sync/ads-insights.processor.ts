import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { localParts } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient, type InsightRow } from '../meta-ads.client.js';
import { AdsCap } from './ads-cap.js';
import {
  ADS_INSIGHTS_DAILY_EVERY_MS,
  ADS_INSIGHTS_DAILY_JOB,
  ADS_INSIGHTS_EVERY_MS,
  ADS_INSIGHTS_JOB,
  ADS_INSIGHTS_ONE_JOB,
  ADS_REFRESH_DAYS,
  type AdsInsightsOneData,
} from './ads-jobs.js';

// Meta's numbers (feature 007 US4, FR-026, FR-027, research R7): every hour for campaigns that run or
// ran today, and once a day for the last 28 days of campaigns that ran (Meta updates attribution).
// Rows per version per day, plus the campaign's own row (reach cannot be added up), in the account's
// time zone and currency. The hourly run then checks the spending cap.

const DAY_MS = 86_400_000;

interface CampaignRef {
  id: string;
  metaCampaignId: string | null;
  currency: string;
  submittedAt: Date | null;
  versions: Array<{ id: string; metaAdId: string | null }>;
}

/** The account's local date `offsetDays` from now, as YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string, offsetDays = 0): string {
  const { year, month, day } = localParts(new Date(at.getTime() + offsetDays * DAY_MS), timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

@Injectable()
export class AdsInsightsProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AdsInsightsProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly ads: MetaAdsClient,
    private readonly connection: AdsConnectionService,
    private readonly cap: AdsCap,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.ADS, ADS_INSIGHTS_JOB, async () => {
      await this.hourly();
    });
    this.registry.registerHandler(QUEUES.ADS, ADS_INSIGHTS_DAILY_JOB, async () => {
      await this.daily();
    });
    this.registry.registerHandler(QUEUES.ADS, ADS_INSIGHTS_ONE_JOB, async (job) => {
      await this.one((job.data as AdsInsightsOneData).campaignId);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const queue = this.queues.get(QUEUES.ADS);
    await queue.upsertJobScheduler(ADS_INSIGHTS_JOB, { every: ADS_INSIGHTS_EVERY_MS }, { name: ADS_INSIGHTS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
    await queue.upsertJobScheduler(ADS_INSIGHTS_DAILY_JOB, { every: ADS_INSIGHTS_DAILY_EVERY_MS }, { name: ADS_INSIGHTS_DAILY_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  /** Yesterday and today for campaigns that run, or stopped within the last day; then the cap. */
  async hourly(now = new Date()): Promise<number> {
    const access = await this.usable();
    if (!access) return 0;
    const rows = await this.prisma.adCampaign.findMany({
      where: {
        deletedAt: null,
        metaCampaignId: { not: null },
        OR: [{ status: { in: ['ACTIVE', 'PAUSED', 'ERROR'] } }, { endedAt: { gte: new Date(now.getTime() - DAY_MS) } }],
      },
      select: { id: true, metaCampaignId: true, currency: true, submittedAt: true, versions: { select: { id: true, metaAdId: true } } },
    });
    const range = { since: localDate(now, access.row.timezone, -1), until: localDate(now, access.row.timezone) };
    const read = await this.syncAll(rows, access, () => range, now);
    await this.cap.enforce(now);
    return read;
  }

  /** The last 28 days of every campaign submitted within them, as Meta updates its attribution. */
  async daily(now = new Date()): Promise<number> {
    const access = await this.usable();
    if (!access) return 0;
    const oldest = new Date(now.getTime() - ADS_REFRESH_DAYS * DAY_MS);
    const rows = await this.prisma.adCampaign.findMany({
      where: { deletedAt: null, metaCampaignId: { not: null }, OR: [{ submittedAt: { gte: oldest } }, { endedAt: { gte: oldest } }, { status: { in: ['ACTIVE', 'PAUSED', 'ERROR'] } }] },
      select: { id: true, metaCampaignId: true, currency: true, submittedAt: true, versions: { select: { id: true, metaAdId: true } } },
    });
    const tz = access.row.timezone;
    const earliest = localDate(now, tz, -(ADS_REFRESH_DAYS - 1));
    return this.syncAll(
      rows,
      access,
      (c) => {
        const submitted = c.submittedAt ? localDate(c.submittedAt, tz) : earliest;
        return { since: submitted > earliest ? submitted : earliest, until: localDate(now, tz) };
      },
      now,
    );
  }

  /** Yesterday and today for one campaign (its first numbers after it became active). */
  async one(campaignId: string, now = new Date()): Promise<void> {
    const access = await this.usable();
    if (!access) return;
    const c = await this.prisma.adCampaign.findFirst({
      where: { id: campaignId, deletedAt: null, metaCampaignId: { not: null } },
      select: { id: true, metaCampaignId: true, currency: true, submittedAt: true, versions: { select: { id: true, metaAdId: true } } },
    });
    if (!c) return;
    await this.syncAll([c], access, () => ({ since: localDate(now, access.row.timezone, -1), until: localDate(now, access.row.timezone) }), now);
  }

  /** One campaign's rows for a date range (inclusive). */
  async syncCampaign(c: CampaignRef, access: AdsAccess, range: { since: string; until: string }, now = new Date()): Promise<void> {
    const versionOf = new Map(c.versions.filter((v) => v.metaAdId).map((v) => [v.metaAdId!, v.id]));
    const [byAd, byCampaign] = await Promise.all([
      this.ads.insights(access.token, c.metaCampaignId!, range, c.currency, 'ad'),
      this.ads.insights(access.token, c.metaCampaignId!, range, c.currency, 'campaign'),
    ]);
    for (const row of byAd) {
      const versionId = row.adId ? versionOf.get(row.adId) : undefined;
      if (versionId && row.date) await this.save(c.id, versionId, row, now);
    }
    for (const row of byCampaign) if (row.date) await this.save(c.id, null, row, now);
  }

  private async syncAll(rows: CampaignRef[], access: AdsAccess, rangeOf: (c: CampaignRef) => { since: string; until: string }, now: Date): Promise<number> {
    let read = 0;
    for (const c of rows) {
      try {
        await this.syncCampaign(c, access, rangeOf(c), now);
        read += 1;
        this.metrics.adsSyncTotal.inc({ job: 'insights', result: 'ok' });
      } catch (error) {
        this.metrics.adsSyncTotal.inc({ job: 'insights', result: 'failed' });
        if (error instanceof MetaApiError && (error.code === 190 || error.httpStatus === 401)) {
          await this.connection.markError(`Meta stopped accepting the ads token: ${error.message}`);
          break;
        }
        this.logger.warn({ campaignId: c.id, err: error instanceof Error ? error.message : String(error) }, 'Ad insights sync failed');
      }
    }
    return read;
  }

  private async save(campaignId: string, versionId: string | null, row: InsightRow, now: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO ad_result_days (id, ad_campaign_id, ad_version_id, day, impressions, reach, clicks, spend_minor, meta_conversations, meta_leads, read_at)
      VALUES (${uuidv7()}::uuid, ${campaignId}::uuid, ${versionId}::uuid, ${row.date}::date, ${row.impressions}, ${row.reach}, ${row.clicks}, ${row.spendMinor},
              ${row.conversations}, ${row.leads}, ${now})
      ON CONFLICT (ad_campaign_id, ad_version_id, day) DO UPDATE
        SET impressions = EXCLUDED.impressions, reach = EXCLUDED.reach, clicks = EXCLUDED.clicks, spend_minor = EXCLUDED.spend_minor,
            meta_conversations = EXCLUDED.meta_conversations, meta_leads = EXCLUDED.meta_leads, read_at = EXCLUDED.read_at`;
  }

  private async usable(): Promise<AdsAccess | null> {
    const access = await this.connection.access();
    if (!access || access.row.status !== 'CONNECTED' || this.ads.busy()) return null;
    return access;
  }
}
