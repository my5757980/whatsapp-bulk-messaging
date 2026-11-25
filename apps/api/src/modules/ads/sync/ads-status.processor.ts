import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { campaignStateFrom, SYNCED_CAMPAIGN_STATES, versionStateFrom, type AdVersionState } from '@wbm/shared';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { AdCampaign, AdCampaignStatus, AdVersion } from '../../../generated/prisma/client.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import {
  ADS_FIRST_INSIGHTS_DELAY_MS,
  ADS_FOLLOW_UP_DELAYS_MS,
  ADS_INSIGHTS_ONE_JOB,
  ADS_STATUS_EVERY_MS,
  ADS_STATUS_JOB,
  ADS_STATUS_ONE_JOB,
  type AdsInsightsOneData,
  type AdsStatusOneData,
} from './ads-jobs.js';

// Meta's review and delivery states (feature 007 US2, FR-013, FR-017, research R6): every 5 minutes
// for campaigns in review, active, paused, rejected or in error, and right after a submit until the
// review ends. Meta's states win and are never undone; rejections and delivery problems alert.

type Row = AdCampaign & { versions: AdVersion[] };

@Injectable()
export class AdsStatusProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AdsStatusProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly ads: MetaAdsClient,
    private readonly connection: AdsConnectionService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.ADS, ADS_STATUS_JOB, async () => {
      await this.syncAll();
    });
    this.registry.registerHandler(QUEUES.ADS, ADS_STATUS_ONE_JOB, async (job: Job) => {
      await this.followUp(job.data as AdsStatusOneData);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.ADS)
      .upsertJobScheduler(ADS_STATUS_JOB, { every: ADS_STATUS_EVERY_MS }, { name: ADS_STATUS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  /** Every synced campaign; returns how many were read. */
  async syncAll(now = new Date()): Promise<number> {
    const access = await this.connection.access();
    if (!access || access.row.status !== 'CONNECTED' || this.ads.busy()) return 0;
    const rows = await this.prisma.adCampaign.findMany({
      where: { deletedAt: null, metaCampaignId: { not: null }, status: { in: [...SYNCED_CAMPAIGN_STATES] } },
      include: { versions: { orderBy: { position: 'asc' } } },
      orderBy: { syncedAt: { sort: 'asc', nulls: 'first' } },
    });
    let read = 0;
    for (const row of rows) {
      try {
        await this.syncCampaign(row, access, now);
        read += 1;
      } catch (error) {
        if (await this.tokenFailed(error)) break;
        this.logger.warn({ campaignId: row.id, err: error instanceof Error ? error.message : String(error) }, 'Ad campaign status sync failed');
      }
    }
    return read;
  }

  /** One campaign right after a submit, again with growing delays while it is in review. */
  async followUp(data: AdsStatusOneData, now = new Date()): Promise<AdCampaignStatus | null> {
    const access = await this.connection.access();
    const row = await this.prisma.adCampaign.findFirst({ where: { id: data.campaignId, deletedAt: null }, include: { versions: { orderBy: { position: 'asc' } } } });
    if (!access || !row?.metaCampaignId) return null;
    let state: AdCampaignStatus | null = null;
    try {
      state = await this.syncCampaign(row, access, now);
    } catch (error) {
      if (await this.tokenFailed(error)) return null;
      this.logger.warn({ campaignId: row.id, err: error instanceof Error ? error.message : String(error) }, 'Ad campaign follow-up read failed');
    }
    const next = data.attempt + 1;
    const inReview = state === 'IN_REVIEW' || (await this.prisma.adVersion.count({ where: { adCampaignId: row.id, status: 'IN_REVIEW' } })) > 0;
    if ((state === null || inReview) && next < ADS_FOLLOW_UP_DELAYS_MS.length) {
      const nextData: AdsStatusOneData = { campaignId: row.id, attempt: next };
      await this.queues
        .get(QUEUES.ADS)
        .add(ADS_STATUS_ONE_JOB, nextData, { delay: ADS_FOLLOW_UP_DELAYS_MS[next], jobId: `ads-status-${row.id}-${Date.now()}`, attempts: 1, removeOnComplete: true, removeOnFail: 20 });
    }
    return state;
  }

  /** Reads the campaign, its ad set and its ads at Meta and saves the states (R6). */
  async syncCampaign(row: Row, access: AdsAccess, now = new Date()): Promise<AdCampaignStatus> {
    const [campaign, adset, adStates] = await Promise.all([
      this.ads.objectStatus(access.token, row.metaCampaignId!),
      row.metaAdsetId ? this.ads.objectStatus(access.token, row.metaAdsetId) : Promise.resolve(null),
      row.metaAdsetId ? this.ads.adsOf(access.token, row.metaAdsetId) : Promise.resolve([]),
    ]);
    const byAd = new Map(adStates.map((a) => [a.id, a]));
    const states: AdVersionState[] = [];
    const rejected: AdVersion[] = [];
    for (const v of row.versions) {
      const meta = v.metaAdId ? byAd.get(v.metaAdId) : undefined;
      let state = v.status as AdVersionState;
      // An edited rejected version keeps its state until it is submitted again.
      const waiting = v.status === 'REJECTED' && !v.metaCreativeId;
      if (meta && !waiting) {
        state = versionStateFrom(meta.effectiveStatus) ?? state;
        const feedback = state === 'REJECTED' ? (meta.feedback ?? 'Meta did not give a reason.').slice(0, 1000) : null;
        if (state !== v.status || feedback !== v.reviewFeedback) {
          await this.prisma.adVersion.update({ where: { id: v.id }, data: { status: state, reviewFeedback: feedback } });
          if (state === 'REJECTED' && v.status !== 'REJECTED') rejected.push(v);
        }
      }
      states.push(state);
    }
    const status = campaignStateFrom({ campaignStatus: campaign.effectiveStatus, adsetStatus: adset?.effectiveStatus ?? null, versions: states, endAt: row.endAt, now });
    const problem = status === 'ERROR' ? `Meta reports ${[campaign.effectiveStatus, adset?.effectiveStatus].filter((s) => s && s !== 'ACTIVE').join(' and ') || 'a delivery problem'}` : null;
    await this.prisma.adCampaign.update({
      where: { id: row.id },
      data: {
        status,
        metaStatus: campaign.effectiveStatus.slice(0, 40),
        syncedAt: now,
        ...(problem ? { lastError: problem } : row.status === 'ERROR' ? { lastError: null } : {}),
        ...(status === 'ENDED' && !row.endedAt ? { endedAt: now } : {}),
      },
    });
    if (status === 'ENDED') await this.prisma.adVersion.updateMany({ where: { adCampaignId: row.id, status: { not: 'ENDED' } }, data: { status: 'ENDED' } });
    if (status === 'ACTIVE' && row.status !== 'ACTIVE') {
      // The first numbers soon after delivery starts, not at the next hourly read.
      const data: AdsInsightsOneData = { campaignId: row.id };
      await this.queues
        .get(QUEUES.ADS)
        .add(ADS_INSIGHTS_ONE_JOB, data, { delay: ADS_FIRST_INSIGHTS_DELAY_MS, jobId: `ads-insights-${row.id}-${Date.now()}`, attempts: 2, removeOnComplete: true, removeOnFail: 20 });
    }

    const link = `/ads/${row.id}`;
    const alertProblem = status === 'ERROR' && row.status !== 'ERROR';
    if (rejected.length || alertProblem) {
      // Admins and the campaign's maker, once each.
      const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
      const userIds = [...new Set([...admins.map((a) => a.id), ...(row.createdById ? [row.createdById] : [])])];
      for (const v of rejected) {
        await this.notifications.notifyUsers(userIds, { type: 'AD_REJECTED', title: `Ad rejected: ${row.name}`, body: `Version ${v.position} was rejected by Meta. Edit it and submit again.`, link });
      }
      if (alertProblem) {
        await this.notifications.notifyUsers(userIds, { type: 'AD_NOT_DELIVERING', title: `Ad not delivering: ${row.name}`, body: `${problem}. Check the campaign and the ad account's payment method in Meta.`, link });
      }
    }
    return status;
  }

  private async tokenFailed(error: unknown): Promise<boolean> {
    if (!(error instanceof MetaApiError) || (error.code !== 190 && error.httpStatus !== 401)) return false;
    await this.connection.markError(`Meta stopped accepting the ads token: ${error.message}`);
    return true;
  }
}
