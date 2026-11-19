import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CampaignsService } from './campaigns.service.js';
import { LaunchService } from './launch.service.js';

// Scheduled campaigns (FR-026, T147). Scheduling validates the campaign and adds a delayed
// `campaign-start` job; the audience snapshot is taken at start time. A reconciler (T148)
// starts any due campaign whose job was lost, so the start is never later than ~30 s.

const MAX_AHEAD_MS = 365 * 24 * 3600 * 1000;

export interface StartJobData {
  campaignId: string;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly launches: LaunchService,
    private readonly campaigns: CampaignsService,
    private readonly queues: QueueRegistry,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** BullMQ forbids ":" in job ids, so the documented `start:{campaignId}` is `start-{id}-{time}`. */
  private jobId(campaignId: string, at: Date): string {
    return `start-${campaignId}-${at.getTime()}`;
  }

  async schedule(campaignId: string, input: { scheduledAt: string; timezone?: string | undefined }, actor: AuditActor) {
    const at = new Date(input.scheduledAt);
    const now = Date.now();
    if (!(at.getTime() > now)) throw AppError.validation('Choose a time in the future', [{ field: 'scheduledAt', issue: 'must be in the future' }]);
    if (at.getTime() > now + MAX_AHEAD_MS) throw AppError.validation('Choose a time within one year', [{ field: 'scheduledAt', issue: 'must be within one year' }]);
    const timezone = input.timezone ?? (await this.settings.get()).defaultTimezone;
    if (!isValidTimezone(timezone)) throw AppError.validation('Unknown timezone', [{ field: 'timezone', issue: 'is not a valid IANA timezone' }]);

    const campaign = await this.launches.load(campaignId);
    if (campaign.state !== 'DRAFT') throw AppError.conflict('Only draft campaigns can be scheduled');
    await this.launches.validate(campaign);

    const { count } = await this.prisma.campaign.updateMany({
      where: { id: campaignId, state: 'DRAFT' },
      data: { state: 'SCHEDULED', scheduledAt: at, timezone },
    });
    if (!count) throw AppError.conflict('Only draft campaigns can be scheduled');
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .add('campaign-start', { campaignId } satisfies StartJobData, {
        jobId: this.jobId(campaignId, at),
        delay: Math.max(0, at.getTime() - Date.now()),
        removeOnComplete: true,
        removeOnFail: 100,
      });
    await this.audit.record(actor, 'campaign.scheduled', { type: 'campaign', id: campaignId }, { scheduledAt: at.toISOString(), timezone });
    return this.campaigns.get(campaignId);
  }

  /** POST /campaigns/{id}/unschedule: SCHEDULED -> DRAFT. */
  async unschedule(campaignId: string) {
    const campaign = await this.campaigns.getRow(campaignId);
    if (campaign.state !== 'SCHEDULED') throw AppError.conflict('Only scheduled campaigns can be moved back to draft');
    const { count } = await this.prisma.campaign.updateMany({ where: { id: campaignId, state: 'SCHEDULED' }, data: { state: 'DRAFT', scheduledAt: null } });
    if (!count) throw AppError.conflict('Only scheduled campaigns can be moved back to draft');
    await this.removeStartJob(campaignId, campaign.scheduledAt);
    return this.campaigns.get(campaignId);
  }

  async removeStartJob(campaignId: string, at: Date | null): Promise<void> {
    if (!at) return;
    const job = await this.queues.get(QUEUES.MAINTENANCE).getJob(this.jobId(campaignId, at));
    await job?.remove().catch(() => undefined); // a job that is already running simply finds the campaign unscheduled
  }

  /** Starts a due scheduled campaign; false when it is not (or no longer) due and SCHEDULED. */
  async startScheduled(campaignId: string): Promise<boolean> {
    const campaign = await this.launches.load(campaignId).catch(() => null);
    if (!campaign || campaign.state !== 'SCHEDULED') return false;
    if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 1_000) return false; // early; the reconciler retries
    try {
      await this.launches.snapshotAndRun(campaign, 'SCHEDULED', {});
    } catch (error) {
      if (error instanceof AppError && error.status === 409) return false; // started by another worker
      throw error;
    }
    // The number is re-checked by the dispatcher on its first tick; the template is checked here.
    if (campaign.template && campaign.template.status !== 'APPROVED') {
      await this.campaigns.autoPause(campaignId, `template_${campaign.template.status.toLowerCase()}`);
    }
    this.logger.log({ campaignId }, 'Scheduled campaign started');
    return true;
  }

  /** Starts every due scheduled campaign (the reconciler, every 30 s). */
  async startDue(): Promise<number> {
    const due = await this.prisma.campaign.findMany({
      where: { state: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });
    let started = 0;
    for (const { id } of due) if (await this.startScheduled(id)) started++;
    return started;
  }
}
