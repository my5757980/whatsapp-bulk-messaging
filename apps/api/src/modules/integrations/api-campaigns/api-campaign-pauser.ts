import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

// Live API campaigns pause themselves when their template stops being approved or their number
// disconnects, and admins and managers are told (feature 006, FR-021, research R6). Called by the
// template status webhook, the number disconnect paths and, as a last check, each trigger.

export type SelfPauseReason = 'TEMPLATE_UNAVAILABLE' | 'NUMBER_DISCONNECTED';

const PAUSE_TEXT: Record<SelfPauseReason, string> = {
  TEMPLATE_UNAVAILABLE: 'its template is no longer approved',
  NUMBER_DISCONNECTED: 'its WhatsApp number is not connected',
};

export function selfPauseText(reason: string | null): string | null {
  return reason && reason in PAUSE_TEXT ? PAUSE_TEXT[reason as SelfPauseReason] : null;
}

@Injectable()
export class ApiCampaignPauser {
  private readonly logger = new Logger(ApiCampaignPauser.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The template is no longer approved (paused, disabled, rejected or deleted by Meta). */
  pauseForTemplate(templateId: string): Promise<number> {
    return this.pauseWhere({ templateId }, 'TEMPLATE_UNAVAILABLE');
  }

  /** The number was disconnected or its credentials stopped working. */
  pauseForNumber(numberId: string): Promise<number> {
    return this.pauseWhere({ numberId }, 'NUMBER_DISCONNECTED');
  }

  /** Pauses one live campaign; false when it was not live any more. */
  async pause(campaign: { id: string; name: string }, reason: SelfPauseReason): Promise<boolean> {
    const { count } = await this.prisma.apiCampaign.updateMany({
      where: { id: campaign.id, status: 'LIVE' },
      data: { status: 'PAUSED', pausedReason: reason, pausedAt: new Date() },
    });
    if (!count) return false;
    this.logger.warn({ apiCampaignId: campaign.id, reason }, 'API campaign paused itself');
    const members = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'MANAGER'] }, status: 'ACTIVE' }, select: { id: true } });
    await this.notifications.notifyUsers(
      members.map((m) => m.id),
      {
        type: 'API_CAMPAIGN_PAUSED',
        title: 'API campaign paused',
        body: `"${campaign.name}" paused itself because ${PAUSE_TEXT[reason]}. Calls are refused until you fix it and set the campaign live again.`,
        link: `/campaigns/api/${campaign.id}`,
      },
    );
    return true;
  }

  private async pauseWhere(where: Prisma.ApiCampaignWhereInput, reason: SelfPauseReason): Promise<number> {
    const live = await this.prisma.apiCampaign.findMany({ where: { ...where, status: 'LIVE' }, select: { id: true, name: true } });
    let paused = 0;
    for (const campaign of live) if (await this.pause(campaign, reason)) paused += 1;
    return paused;
  }
}
