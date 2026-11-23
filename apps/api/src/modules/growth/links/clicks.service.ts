import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PageQuery } from '../../../common/validation/pagination.js';

// Click results of a campaign (feature 005 US1, FR-008, research R11): counted with SQL when read.
// A clicker is one recipient (one campaign message), so contacts deleted since still count.

export interface ClickSummaryDto {
  clickers: number;
  clicks: number;
  delivered: number;
  clickRate: number;
  links: Array<{ targetId: string; variableKey: string; destination: string; clickers: number; clicks: number }>;
}

export interface ClickerDto {
  contactId: string | null;
  name: string | null;
  /** Masked for roles without phones.full by the global PhoneMaskInterceptor. */
  phone: string | null;
  firstClickAt: string;
  lastClickAt: string;
  clicks: number;
}

interface ClickerRow {
  contactId: string | null;
  name: string | null;
  phone: string | null;
  firstClickAt: Date;
  lastClickAt: Date;
  clicks: number;
}

@Injectable()
export class ClicksService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCampaign(campaignId: string): Promise<{ id: string; name: string }> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    return campaign;
  }

  async summary(campaignId: string): Promise<ClickSummaryDto> {
    await this.assertCampaign(campaignId);
    const [totals] = await this.prisma.$queryRaw<Array<{ clickers: number; clicks: number }>>`
      SELECT COUNT(DISTINCT tl.message_id)::int AS clickers, COUNT(lc.id)::int AS clicks
        FROM link_clicks lc
        JOIN tracked_links tl ON tl.id = lc.tracked_link_id
       WHERE lc.campaign_id = ${campaignId}::uuid`;
    const [{ delivered } = { delivered: 0 }] = await this.prisma.$queryRaw<Array<{ delivered: number }>>`
      SELECT COUNT(*)::int AS delivered FROM messages
       WHERE campaign_id = ${campaignId}::uuid AND status IN ('DELIVERED', 'READ')`;
    const links = await this.prisma.$queryRaw<ClickSummaryDto['links']>`
      SELECT t.id AS "targetId", t.variable_key AS "variableKey", t.destination,
             COUNT(DISTINCT lc.tracked_link_id)::int AS clickers, COUNT(lc.id)::int AS clicks
        FROM tracked_link_targets t
        LEFT JOIN link_clicks lc ON lc.target_id = t.id
       WHERE t.campaign_id = ${campaignId}::uuid
       GROUP BY t.id
       ORDER BY t.variable_key`;
    const clickers = totals?.clickers ?? 0;
    return { clickers, clicks: totals?.clicks ?? 0, delivered, clickRate: delivered ? clickers / delivered : 0, links };
  }

  /** The Clicked view: one row per clicker, most recent click first (FR-008). */
  async clickers(campaignId: string, page: PageQuery): Promise<{ items: ClickerDto[]; total: number }> {
    await this.assertCampaign(campaignId);
    const [{ total } = { total: 0 }] = await this.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(DISTINCT tl.message_id)::int AS total
        FROM link_clicks lc JOIN tracked_links tl ON tl.id = lc.tracked_link_id
       WHERE lc.campaign_id = ${campaignId}::uuid`;
    const rows = await this.rows(campaignId, page.pageSize, (page.page - 1) * page.pageSize);
    return { items: rows.map(toClickerDto), total };
  }

  /** Clickers in batches for the export (flat memory). */
  async *batches(campaignId: string, size = 1000): AsyncGenerator<ClickerDto[]> {
    for (let offset = 0; ; offset += size) {
      const rows = await this.rows(campaignId, size, offset);
      if (!rows.length) return;
      yield rows.map(toClickerDto);
      if (rows.length < size) return;
    }
  }

  private rows(campaignId: string, limit: number, offset: number): Promise<ClickerRow[]> {
    return this.prisma.$queryRaw<ClickerRow[]>`
      SELECT m.contact_id AS "contactId", c.name, COALESCE(c.phone_e164, m.phone_e164) AS phone,
             MIN(lc.clicked_at) AS "firstClickAt", MAX(lc.clicked_at) AS "lastClickAt", COUNT(lc.id)::int AS clicks
        FROM link_clicks lc
        JOIN tracked_links tl ON tl.id = lc.tracked_link_id
        JOIN messages m ON m.id = tl.message_id
        LEFT JOIN contacts c ON c.id = m.contact_id
       WHERE lc.campaign_id = ${campaignId}::uuid
       GROUP BY m.id, m.contact_id, c.name, c.phone_e164, m.phone_e164
       ORDER BY MAX(lc.clicked_at) DESC, m.id
       LIMIT ${limit} OFFSET ${offset}`;
  }
}

function toClickerDto(row: ClickerRow): ClickerDto {
  return {
    contactId: row.contactId,
    name: row.name,
    phone: row.phone,
    firstClickAt: row.firstClickAt.toISOString(),
    lastClickAt: row.lastClickAt.toISOString(),
    clicks: row.clicks,
  };
}
