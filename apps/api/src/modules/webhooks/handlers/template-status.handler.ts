import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { CampaignsService } from '../../campaigns/campaigns.service.js';
import { ApiCampaignPauser } from '../../integrations/api-campaigns/api-campaign-pauser.js';
import { TemplatesSyncService, mapTemplateStatus } from '../../templates/templates-sync.service.js';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../webhook-router.js';

const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/**
 * `message_template_status_update` (T141, contracts/meta-webhooks.md §5): idempotent status and
 * rejection-reason updates. PAUSED or DISABLED auto-pauses every RUNNING campaign that uses the
 * template and notifies admins (FR-027). Unknown templates trigger a sync of their account.
 */
@Injectable()
export class TemplateStatusHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'message_template_status_update';
  private readonly logger = new Logger(TemplateStatusHandler.name);

  constructor(
    private readonly router: WebhookRouter,
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly sync: TemplatesSyncService,
    private readonly apiCampaigns: ApiCampaignPauser,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    const value = change.value;
    const event = (str(value.event) ?? '').toUpperCase();
    const metaId = str(value.message_template_id);
    const name = str(value.message_template_name);
    const language = str(value.message_template_language);

    let template = metaId ? await this.prisma.template.findFirst({ where: { metaTemplateId: metaId } }) : null;
    if (!template && change.wabaId && name && language) {
      template = await this.prisma.template.findUnique({ where: { wabaId_name_language: { wabaId: change.wabaId, name, language } } });
    }
    if (!template) {
      if (change.wabaId) {
        await this.sync.syncWaba(change.wabaId).catch((error: unknown) =>
          this.logger.warn({ wabaId: change.wabaId, err: (error as Error).message }, 'Template sync after status webhook failed'),
        );
      }
      return;
    }
    if (!event || event === 'FLAGGED') return; // quality flag only; the status does not change

    const status = mapTemplateStatus(event);
    const reason = str(value.reason);
    const rejectionReason = status === 'REJECTED' && reason && reason !== 'NONE' ? reason : null;
    if (template.status !== status || template.rejectionReason !== rejectionReason) {
      await this.prisma.template.update({ where: { id: template.id }, data: { status, rejectionReason, lastSyncedAt: new Date() } });
    }
    if (status === 'PAUSED' || status === 'DISABLED') {
      const running = await this.prisma.campaign.findMany({ where: { templateId: template.id, state: 'RUNNING' }, select: { id: true } });
      for (const campaign of running) await this.campaigns.autoPause(campaign.id, `template_${status.toLowerCase()}`);
    }
    // Live API campaigns pause on any status other than approved (feature 006, FR-021).
    if (status !== 'APPROVED') await this.apiCampaigns.pauseForTemplate(template.id);
  }
}
