import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { maskPhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema } from '../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import { csvField } from '../campaigns/csv.js';
import { ConsentReportService } from './consent-report.service.js';
import { OverviewReportService } from './overview-report.service.js';
import { COUNT_COLUMNS, RangeQuerySchema, countCells, resolveRange, type RangeQuery, type ReportRange } from './report-range.js';
import { TeamReportService } from './team-report.service.js';

// Feature 009 (research R14, FR-034 - FR-036, contracts/templates-growth-api.openapi.yaml): the
// overview, team member and opt-in reports as JSON (reports.view) and as streamed CSV downloads
// (data.export), never stored and each audited as data.exported with the report type.

const ConsentQuerySchema = RangeQuerySchema.merge(PageQuerySchema).extend({ status: z.enum(['OPTED_IN', 'OPTED_OUT']).optional() });
type ConsentQuery = z.infer<typeof ConsentQuerySchema>;

type Cell = string | number | null | undefined;
const line = (cells: Cell[]) => `${cells.map((c) => csvField(c ?? '')).join(',')}\n`;

@Controller('reports')
export class ReportsV2Controller {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly overview: OverviewReportService,
    private readonly team: TeamReportService,
    private readonly consent: ConsentReportService,
  ) {}

  @Get('overview')
  @Require('reports.view')
  async overviewJson(@Query(new ZodValidationPipe(RangeQuerySchema)) query: RangeQuery) {
    return this.overview.report(await resolveRange(this.prisma, query));
  }

  @Get('team')
  @Require('reports.view')
  async teamJson(@Query(new ZodValidationPipe(RangeQuerySchema)) query: RangeQuery) {
    return this.team.report(await resolveRange(this.prisma, query));
  }

  @Get('consent')
  @Require('reports.view')
  async consentJson(@Query(new ZodValidationPipe(ConsentQuerySchema)) query: ConsentQuery) {
    return this.consent.report(await resolveRange(this.prisma, query), query.page, query.pageSize, query.status);
  }

  @Get('overview.csv')
  @Require('data.export')
  async overviewCsv(@Query(new ZodValidationPipe(RangeQuerySchema)) query: RangeQuery, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const range = await resolveRange(this.prisma, query);
    const rows = await this.overview.rows(range);
    await this.start(res, user, req, 'overview', range, rows.length);
    res.write(line(['day', 'category', 'number', ...COUNT_COLUMNS]));
    for (const r of rows) await this.write(res, line([r.day, r.category, r.label, ...countCells(r)]));
    res.end();
  }

  @Get('team.csv')
  @Require('data.export')
  async teamCsv(@Query(new ZodValidationPipe(RangeQuerySchema)) query: RangeQuery, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const range = await resolveRange(this.prisma, query);
    const { members } = await this.team.report(range);
    await this.start(res, user, req, 'team', range, members.length);
    res.write(line(['name', 'active', 'campaigns_launched', ...COUNT_COLUMNS, 'chats_taken', 'chats_closed', 'replies_sent', 'median_first_response_seconds']));
    for (const m of members) {
      await this.write(res, line([m.name, m.active ? 'yes' : 'no', m.campaignsLaunched, ...countCells(m.campaignTotals), m.chatsTaken, m.chatsClosed, m.repliesSent, m.medianFirstResponseSeconds === null ? '' : Math.round(m.medianFirstResponseSeconds)]));
    }
    res.end();
  }

  @Get('consent.csv')
  @Require('data.export')
  async consentCsv(@Query(new ZodValidationPipe(RangeQuerySchema)) query: RangeQuery, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const range = await resolveRange(this.prisma, query);
    const rows = await this.prisma.consentEvent.count({ where: { createdAt: { gte: range.start, lt: range.end } } });
    await this.start(res, user, req, 'consent', range, rows);
    // Roles that see masked phones get masked phones in the file too (001).
    const fullPhones = can(user.role, 'phones.full');
    res.write(line(['at', 'name', 'phone', 'status', 'source', 'note', 'actor']));
    for await (const batch of this.consent.stream(range)) {
      await this.write(res, batch.map((e) => line([e.at, e.name, fullPhones ? e.phone : maskPhone(e.phone), e.status, e.source, e.note, e.actor])).join(''));
    }
    res.end();
  }

  /** Audits the download and starts the CSV answer. */
  private async start(res: Response, user: RequestUser, req: AuthedRequest, report: 'overview' | 'team' | 'consent', range: ReportRange, rows: number): Promise<void> {
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'data.exported', { type: 'report', id: null }, { report, from: range.from, to: range.to, rows, format: 'csv' });
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${report}-report-${range.from}-to-${range.to}.csv"`);
  }

  private async write(res: Response, text: string): Promise<void> {
    if (!res.write(text)) await new Promise((resolve) => res.once('drain', resolve));
  }
}
