import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { RateCardService } from '../rate-card/rate-card.controller.js';
import { microsToUsdNumber, rateCategory } from './cost-calculator.js';

/**
 * Campaign report (FR-028, T161): totals per status, delivery and read rates, failure reasons and
 * an estimated USD cost from the rate card (always labelled as an estimate).
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly rateCard: RateCardService,
  ) {}

  async report(campaignId: string) {
    await this.campaigns.getRow(campaignId);
    const totals = await this.campaigns.computeTotals(campaignId);
    const attempted = totals.sent + totals.delivered + totals.read + totals.failed;
    const delivered = totals.delivered + totals.read;

    const reasons = await this.prisma.message.groupBy({
      by: ['failureCode', 'failureReason'],
      where: { campaignId, status: 'FAILED' },
      _count: { _all: true },
    });
    const failureReasons = reasons
      .map((r) => ({ code: r.failureCode, reason: r.failureReason ?? 'Unknown reason', count: r._count._all }))
      .sort((a, b) => b.count - a.count);

    return {
      campaignId,
      totals,
      deliveryRate: attempted ? delivered / attempted : 0,
      readRate: delivered ? totals.read / delivered : 0,
      failureReasons,
      estimatedCostUsd: microsToUsdNumber(await this.costMicros(campaignId)),
      costIsEstimate: true as const,
    };
  }

  /**
   * Billable messages (webhook pricing flag, else delivered) x the rate for their category and
   * country on the delivery day. Aggregated in SQL so large campaigns stay cheap.
   */
  async costMicros(campaignId: string): Promise<bigint> {
    const table = await this.rateCard.table();
    if (table.isEmpty) return 0n;
    const groups = await this.prisma.$queryRaw<Array<{ pricing_category: string | null; template_category: string; country: string; day: Date; n: number }>>`
      SELECT m.pricing_category, t.category::text AS template_category, m.recipient_country AS country,
             date_trunc('day', COALESCE(m.delivered_at, m.read_at, m.sent_at, m.updated_at)) AS day, count(*)::int AS n
        FROM messages m
        JOIN templates t ON t.id = m.template_id
       WHERE m.campaign_id = ${campaignId}::uuid
         AND (m.billable = true OR (m.billable IS NULL AND m.status IN ('DELIVERED'::"MessageStatus", 'READ'::"MessageStatus")))
       GROUP BY 1, 2, 3, 4`;
    let total = 0n;
    for (const g of groups) {
      const rate = table.rate(rateCategory(g.pricing_category, g.template_category), g.country, g.day);
      if (rate !== null) total += rate * BigInt(g.n);
    }
    return total;
  }
}
