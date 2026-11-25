import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { AdsConnectionService } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { ADS_LEADS_CATCH_UP_EVERY_MS, ADS_LEADS_CATCH_UP_JOB } from '../sync/ads-jobs.js';
import { AdLeadFormsService } from './ad-lead-forms.service.js';

/** Leads are read again from a little before the last one, so a lead landing at the same moment is not missed. */
const OVERLAP_MS = 10 * 60_000;

// The lead catch-up (feature 007 US7, FR-036, research R9): every 15 minutes, each form's leads since
// its last lead are read from Meta, so leads whose webhook never arrived are still recorded (once).
@Injectable()
export class AdLeadsProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AdLeadsProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly forms: AdLeadFormsService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.ADS, ADS_LEADS_CATCH_UP_JOB, async () => {
      await this.catchUp();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.ADS)
      .upsertJobScheduler(ADS_LEADS_CATCH_UP_JOB, { every: ADS_LEADS_CATCH_UP_EVERY_MS }, { name: ADS_LEADS_CATCH_UP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  /** Returns how many new leads were recorded. */
  async catchUp(now = new Date()): Promise<number> {
    const access = await this.connection.access();
    if (!access || access.row.status !== 'CONNECTED') return 0;
    const forms = await this.prisma.adLeadForm.findMany({ where: { metaFormId: { not: null } }, select: { id: true, metaFormId: true, lastLeadAt: true, createdAt: true } });
    let recorded = 0;
    for (const form of forms) {
      const since = (form.lastLeadAt ?? form.createdAt).getTime() - OVERLAP_MS;
      try {
        const leads = await this.ads.formLeads(access.pageToken ?? access.token, form.metaFormId!, Math.floor(since / 1000));
        for (const lead of leads) {
          if ((await this.forms.ingest({ ...lead, formId: lead.formId ?? form.metaFormId }, now)) === 'NEW') recorded += 1;
        }
        this.metrics.adsSyncTotal.inc({ job: 'leads', result: 'ok' });
      } catch (error) {
        this.metrics.adsSyncTotal.inc({ job: 'leads', result: 'failed' });
        if (error instanceof MetaApiError && (error.code === 190 || error.httpStatus === 401)) {
          await this.connection.markError(`Meta stopped accepting the ads token: ${error.message}`);
          break;
        }
        this.logger.warn({ formId: form.id, err: error instanceof Error ? error.message : String(error) }, 'Lead catch-up failed');
      }
    }
    return recorded;
  }
}
