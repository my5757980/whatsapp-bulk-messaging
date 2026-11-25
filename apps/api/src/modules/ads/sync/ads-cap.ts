import { Injectable, Logger } from '@nestjs/common';
import { capCheck, capReached, formatMinor, monthLeft } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { AdCampaignStatus } from '../../../generated/prisma/client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';

/** Campaigns whose daily budgets count towards the cap's projection, and that the cap pauses (R7). */
export const SPENDING_STATES: readonly AdCampaignStatus[] = ['IN_REVIEW', 'ACTIVE'];

// The monthly spending cap (feature 007 US5, FR-018, FR-019, research R7): launches, resumes and budget
// increases are refused when they could pass it, and the hourly insights job pauses every platform
// campaign once a month when the month's spend reaches it.
@Injectable()
export class AdsCap {
  private readonly logger = new Logger(AdsCap.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly notifications: NotificationsService,
  ) {}

  /** Refuses (409 SPEND_CAP, with the amount left) a change that could let this month's spend pass the cap. */
  async check(newDailyBudgetMinor: number, access: AdsAccess, exceptCampaignId: string | null, now = new Date()): Promise<void> {
    if (access.row.monthlyCapMinor === null) return;
    const cap = Number(access.row.monthlyCapMinor);
    const others = await this.prisma.adCampaign.findMany({
      where: { deletedAt: null, status: { in: [...SPENDING_STATES] }, ...(exceptCampaignId ? { id: { not: exceptCampaignId } } : {}) },
      select: { dailyBudgetMinor: true },
    });
    const result = capCheck({
      capMinor: cap,
      spentThisMonthMinor: await this.connection.monthSpendMinor(access.row, now),
      activeDailyBudgetsMinor: others.map((o) => Number(o.dailyBudgetMinor)),
      newDailyBudgetMinor,
      now,
      timeZone: access.row.timezone,
    });
    if (!result.ok) {
      throw AppError.conflict(
        `This could pass the monthly spending cap of ${formatMinor(cap, access.row.currency)}: ${formatMinor(result.remainingMinor, access.row.currency)} is left this month.`,
        'SPEND_CAP',
      );
    }
  }

  /** After the hourly insights: pauses the platform's running campaigns once this month when the cap is reached. */
  async enforce(now = new Date()): Promise<number> {
    const access = await this.connection.access();
    if (!access || access.row.monthlyCapMinor === null || access.row.status !== 'CONNECTED') return 0;
    const { month } = monthLeft(now, access.row.timezone);
    if (access.row.cappedMonth === month) return 0;
    const cap = Number(access.row.monthlyCapMinor);
    const spent = await this.connection.monthSpendMinor(access.row, now);
    if (!capReached(cap, spent)) return 0;

    const running = await this.prisma.adCampaign.findMany({
      where: { deletedAt: null, metaCampaignId: { not: null }, status: { in: [...SPENDING_STATES] } },
      select: { id: true, name: true, metaCampaignId: true },
    });
    let paused = 0;
    for (const c of running) {
      try {
        await this.ads.update(access.token, c.metaCampaignId!, { status: 'PAUSED' });
        await this.prisma.adCampaign.update({ where: { id: c.id }, data: { status: 'PAUSED', lastError: 'Paused because the monthly spending cap was reached.' } });
        paused += 1;
      } catch (error) {
        this.logger.error({ campaignId: c.id, err: error instanceof Error ? error.message : String(error) }, 'Could not pause a campaign at the spending cap');
      }
    }
    await this.prisma.adsConnection.update({ where: { id: access.row.id }, data: { cappedMonth: month } });
    const users = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'MANAGER'] }, status: 'ACTIVE' }, select: { id: true } });
    await this.notifications.notifyUsers(
      users.map((u) => u.id),
      {
        type: 'ADS_SPEND_CAP_REACHED',
        title: 'Monthly ad spending cap reached',
        body: `This month's spend is ${formatMinor(spent, access.row.currency)} of the ${formatMinor(cap, access.row.currency)} cap; ${paused} campaign${paused === 1 ? ' was' : 's were'} paused.`,
        link: '/ads',
      },
    );
    return paused;
  }
}
