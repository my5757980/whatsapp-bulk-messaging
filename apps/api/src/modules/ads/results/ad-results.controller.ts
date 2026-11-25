import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { AdResultsService, ResultsQuerySchema, type Numbers } from './ad-results.service.js';

const NEWLINE = '\n';
const HEADER = ['date', 'version', 'currency', 'impressions', 'reach', 'clicks', 'spend', 'meta_conversations', 'chats_started', 'new_contacts', 'replied', 'leads', 'visits', 'cost_per_chat'];

/** Ad results and their CSV (feature 007 US4, contracts/ads-api.openapi.yaml). */
@Controller('ads/campaigns')
export class AdResultsController {
  constructor(
    private readonly results: AdResultsService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/results')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ResultsQuerySchema)) query: z.infer<typeof ResultsQuerySchema>) {
    return this.results.results(id, query);
  }

  /** Days and versions as CSV (no contact data); audited like 001 exports. */
  @Get(':id/results/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const r = await this.results.results(id);
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'data.exported', { type: 'ad_campaign', id }, { view: 'ad campaign results', format: 'csv' });
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: r.currency }).resolvedOptions().maximumFractionDigits ?? 2;
    const money = (minor: number | null) => (minor === null ? '' : (minor / 10 ** digits).toFixed(digits));
    const line = (date: string, version: string, n: Numbers) =>
      [date, version, r.currency, n.impressions, n.reach, n.clicks, money(n.spendMinor), n.metaConversations, n.chatsStarted, n.newContacts, n.replied, n.leads, n.visits, money(n.costPerChatMinor)]
        .map(csvField)
        .join(',');
    const rows = [HEADER.join(','), ...r.days.map((d) => line(d.date, 'all versions', d)), ...r.versions.map((v) => line(`${r.from} to ${r.to}`, `version ${v.position}`, v))];
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="ad-results-${id.slice(0, 8)}.csv"`);
    res.end(`${rows.join(NEWLINE)}${NEWLINE}`);
  }
}
