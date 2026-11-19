import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { CampaignsService } from './campaigns.service.js';
import { DispatchScheduler } from './dispatch-scheduler.js';
import { ScheduleService } from './schedule.service.js';

// Pause / resume / cancel (FR-023, T105). Pausing returns buffered (QUEUED) messages to PENDING,
// so at most the messages already being sent go out after a pause.

@Injectable()
export class CampaignControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly dispatch: DispatchScheduler,
    private readonly audit: AuditService,
    private readonly schedules: ScheduleService,
  ) {}

  async pause(id: string, actor: AuditActor) {
    const { count } = await this.prisma.campaign.updateMany({ where: { id, state: 'RUNNING' }, data: { state: 'PAUSED', pausedReason: 'manual' } });
    if (!count) {
      await this.campaigns.getRow(id);
      throw AppError.conflict('Only running campaigns can be paused');
    }
    const { count: returned } = await this.prisma.message.updateMany({ where: { campaignId: id, status: 'QUEUED' }, data: { status: 'PENDING' } });
    await this.audit.record(actor, 'campaign.paused', { type: 'campaign', id }, { returnedToPending: returned });
    return this.campaigns.get(id);
  }

  async resume(id: string, actor: AuditActor) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, include: { number: true, template: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (campaign.state !== 'PAUSED') throw AppError.conflict('Only paused campaigns can be resumed');
    if (!campaign.number || campaign.number.connectionStatus !== 'CONNECTED') throw AppError.conflict('The WhatsApp number is not connected');
    if (!campaign.number.sendingEnabled) throw AppError.conflict('Sending is turned off for this number; turn it on before resuming');
    if (!campaign.template || campaign.template.status !== 'APPROVED') throw AppError.conflict('The template is not approved by Meta');

    const { count } = await this.prisma.campaign.updateMany({ where: { id, state: 'PAUSED' }, data: { state: 'RUNNING', pausedReason: null } });
    if (!count) throw AppError.conflict('Only paused campaigns can be resumed');
    await this.dispatch.schedule(id);
    await this.audit.record(actor, 'campaign.resumed', { type: 'campaign', id }, { previousReason: campaign.pausedReason });
    return this.campaigns.get(id);
  }

  async cancel(id: string, actor: AuditActor) {
    const before = await this.campaigns.getRow(id);
    const now = new Date();
    const { count } = await this.prisma.campaign.updateMany({
      where: { id, state: { in: ['RUNNING', 'PAUSED', 'SCHEDULED'] } },
      data: { state: 'CANCELLED', cancelledAt: now },
    });
    if (!count) {
      await this.campaigns.getRow(id);
      throw AppError.conflict('Only scheduled, running or paused campaigns can be cancelled');
    }
    const { count: cancelled } = await this.prisma.message.updateMany({
      where: { campaignId: id, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'CANCELLED' },
    });
    if (before.state === 'SCHEDULED') await this.schedules.removeStartJob(id, before.scheduledAt);
    await this.audit.record(actor, 'campaign.cancelled', { type: 'campaign', id }, { messagesCancelled: cancelled });
    return this.campaigns.get(id);
  }
}
