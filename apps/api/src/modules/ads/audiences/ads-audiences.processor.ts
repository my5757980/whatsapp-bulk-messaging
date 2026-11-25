import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { AdsConnectionService } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { ADS_AUDIENCE_SYNC_JOB, ADS_AUDIENCES_EVERY_MS, ADS_AUDIENCES_JOB, type AdsAudienceSyncData } from '../sync/ads-jobs.js';
import { AdAudiencesService } from './ad-audiences.service.js';

// Keeps saved audiences up to date at Meta (feature 007 US6, FR-032, research R8): one audience right
// after it is made or when asked, and every CUSTOM audience once a day; each run sends only the difference.
@Injectable()
export class AdsAudiencesProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AdsAudiencesProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly audiences: AdAudiencesService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.ADS, ADS_AUDIENCES_JOB, async () => {
      await this.daily();
    });
    this.registry.registerHandler(QUEUES.ADS, ADS_AUDIENCE_SYNC_JOB, async (job: Job) => {
      await this.syncOne((job.data as AdsAudienceSyncData).audienceId);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.ADS)
      .upsertJobScheduler(ADS_AUDIENCES_JOB, { every: ADS_AUDIENCES_EVERY_MS }, { name: ADS_AUDIENCES_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  async syncOne(audienceId: string, now = new Date()): Promise<void> {
    const access = await this.connection.access();
    if (!access || access.row.status !== 'CONNECTED') return;
    await this.audiences.sync(audienceId, access, now);
  }

  /** Every saved audience; returns how many were updated. */
  async daily(now = new Date()): Promise<number> {
    const access = await this.connection.access();
    if (!access || access.row.status !== 'CONNECTED' || this.ads.busy()) return 0;
    const rows = await this.prisma.adAudience.findMany({ where: { deletedAt: null, kind: 'CUSTOM', metaAudienceId: { not: null } }, select: { id: true }, orderBy: { syncedAt: { sort: 'asc', nulls: 'first' } } });
    let done = 0;
    for (const { id } of rows) {
      try {
        await this.audiences.sync(id, access, now);
        done += 1;
      } catch (error) {
        this.logger.warn({ audienceId: id, err: error instanceof Error ? error.message : String(error) }, 'Audience sync failed');
        if ((await this.connection.access())?.row.status !== 'CONNECTED') break;
      }
    }
    return done;
  }
}
