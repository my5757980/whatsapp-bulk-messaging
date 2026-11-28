import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { failureHelp } from '@wbm/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { DELIVERED, REPLIED } from '../campaigns/replied.sql.js';
import { RateCardService } from '../rate-card/rate-card.controller.js';
import { microsToUsdNumber, rateCategory } from './cost-calculator.js';

/**
 * Campaign report (FR-028, T161): totals per status, delivery and read rates, failure reasons and
 * an estimated USD cost from the rate card (always labelled as an estimate).
 */
@Injectable()
export class ReportsService {
  /** Feature 009 (research R11): replies and repeats per campaign, cached for 60 seconds like the 005 clicks. */
  private readonly additions = new Map<string, { at: number; value: Promise<{ replied: number; replyRate: number | null; multiMessageRecipients: number; heldBack: number }> }>();

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
      // Feature 009 (research R12): what each reason means and what to do.
      .map((r) => ({ code: r.failureCode, reason: r.failureReason ?? 'Unknown reason', count: r._count._all, meaning: failureHelp(r.failureCode, r.failureReason)?.meaning ?? null, action: failureHelp(r.failureCode, r.failureReason)?.action ?? null }))
      .sort((a, b) => b.count - a.count);
    // Feature 009 (research R7, R8): why messages expired.
    const expiredGroups = totals.expired
      ? await this.prisma.message.groupBy({ by: ['expiredReason'], where: { campaignId, status: 'EXPIRED' }, _count: { _all: true } })
      : [];
    const expiredBy = (reason: string) => expiredGroups.find((g) => g.expiredReason === reason)?._count._all ?? 0;

    return {
      campaignId,
      totals,
      deliveryRate: attempted ? delivered / attempted : 0,
      readRate: delivered ? totals.read / delivered : 0,
      failureReasons,
      expired: { expiredBeforeSending: expiredBy('EXPIRED_BEFORE_SENDING'), notDeliveredInTime: expiredBy('NOT_DELIVERED_IN_TIME'), offerEnded: expiredBy('OFFER_ENDED') },
      ...(await this.cachedAdditions(campaignId)),
      estimatedCostUsd: microsToUsdNumber(await this.costMicros(campaignId)),
      costIsEstimate: true as const,
    };
  }

  private cachedAdditions(campaignId: string) {
    const hit = this.additions.get(campaignId);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = this.computeAdditions(campaignId);
    this.additions.set(campaignId, { at: Date.now(), value });
    value.catch(() => this.additions.delete(campaignId));
    if (this.additions.size > 500) this.additions.delete(this.additions.keys().next().value as string);
    return value;
  }

  /** Replied and its rate over delivered (distinct contacts), contacts with more than one message, and 131049 held back. */
  private async computeAdditions(campaignId: string) {
    const [row] = await this.prisma.$queryRaw<Array<{ delivered: number; replied: number; held: number }>>`
      SELECT COUNT(DISTINCT m.contact_id) FILTER (WHERE ${DELIVERED})::int AS delivered,
             COUNT(DISTINCT m.contact_id) FILTER (WHERE ${DELIVERED} AND ${REPLIED})::int AS replied,
             COUNT(*) FILTER (WHERE m.status = 'FAILED' AND m.failure_code = 131049)::int AS held
        FROM messages m WHERE m.campaign_id = ${campaignId}::uuid AND m.contact_id IS NOT NULL`;
    const [multi] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT m.contact_id FROM messages m
         WHERE m.campaign_id = ${campaignId}::uuid AND m.contact_id IS NOT NULL AND m.status NOT IN ('SKIPPED', 'CANCELLED')
         GROUP BY m.contact_id HAVING COUNT(*) > 1) x`);
    const delivered = row?.delivered ?? 0;
    const replied = row?.replied ?? 0;
    return { replied, replyRate: delivered ? replied / delivered : null, multiMessageRecipients: multi?.n ?? 0, heldBack: row?.held ?? 0 };
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
