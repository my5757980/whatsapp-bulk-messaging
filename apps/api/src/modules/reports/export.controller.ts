import { Controller, Get, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { csvField } from '../campaigns/csv.js';
import { REPLIED_AT } from '../campaigns/replied.sql.js';
import { ReportsService } from './reports.service.js';

// Feature 009 (research R11): replied, replied_at and clicks per recipient (FR-037).
const COLUMNS = ['phone', 'name', 'status', 'skip_reason', 'failure_code', 'failure_reason', 'attempts', 'sent_at', 'delivered_at', 'read_at', 'failed_at', 'cost_usd', 'replied', 'replied_at', 'clicks'];
const BATCH = 1000;

const iso = (d: Date | null) => d?.toISOString() ?? '';
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';

/** Campaign report (T161) and recipient export (FR-030, T162). */
@Controller('campaigns')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly campaigns: CampaignsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/report')
  @Require('campaigns.view')
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.report(id);
  }

  /** Streams one CSV row per recipient in batches (flat memory for large campaigns); audited. */
  @Get(':id/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const campaign = await this.campaigns.getRow(id);
    const rows = await this.prisma.message.count({ where: { campaignId: id } });
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'data.exported', { type: 'campaign', id }, { rows, format: 'csv' });

    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="campaign-${slug(campaign.name)}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(`${COLUMNS.join(',')}\n`);

    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.message.findMany({
        where: { campaignId: id },
        include: { contact: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1]!.id;
      const extra = await this.prisma.$queryRaw<Array<{ id: string; replied_at: Date | null; clicks: number }>>`
        SELECT m.id, ${REPLIED_AT} AS replied_at,
               (SELECT COUNT(*)::int FROM tracked_links tl JOIN link_clicks lc ON lc.tracked_link_id = tl.id WHERE tl.message_id = m.id) AS clicks
          FROM messages m WHERE m.id = ANY(${batch.map((m) => m.id)}::uuid[])`;
      const byId = new Map(extra.map((e) => [e.id, e]));
      const chunk = batch
        .map((m) =>
          [
            m.phoneE164 ?? '',
            m.contact?.name ?? '',
            m.status,
            m.skipReason ?? '',
            m.failureCode ?? '',
            m.failureReason ?? '',
            m.attempts,
            iso(m.sentAt),
            iso(m.deliveredAt),
            iso(m.readAt),
            iso(m.failedAt),
            m.costUsdMicros === null ? '' : (Number(m.costUsdMicros) / 1_000_000).toString(),
            byId.get(m.id)?.replied_at ? 'yes' : 'no',
            iso(byId.get(m.id)?.replied_at ?? null),
            byId.get(m.id)?.clicks ?? 0,
          ]
            .map(csvField)
            .join(','),
        )
        .join('\n');
      if (!res.write(`${chunk}\n`)) await new Promise((resolve) => res.once('drain', resolve));
      if (batch.length < BATCH) break;
    }
    res.end();
  }
}
