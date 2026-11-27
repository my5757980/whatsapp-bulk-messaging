import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CLICKED, DELIVERED, REPLIED } from '../campaigns/replied.sql.js';
import { COUNTS, toCounts, type Counts, type CountsRow, type ReportRange } from './report-range.js';

// Feature 009 (research R14, FR-034): every campaign message created in the range (the launch day), by
// day in the company time zone, by template category and by number, in one pass over indexed rows.

type GroupedRow = CountsRow & { g_day: number; g_category: number; g_number: number; day: string | null; category: string | null; number_id: string | null };

export interface OverviewReport {
  from: string;
  to: string;
  totals: Counts;
  days: Array<Counts & { day: string }>;
  byCategory: Array<Counts & { category: string }>;
  byNumber: Array<Counts & { numberId: string; label: string }>;
  failedByReason: Array<{ code: number | null; reason: string; count: number }>;
}

@Injectable()
export class OverviewReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** The campaign messages of the range with the replied and clicked flags (alias `m`). */
  private base(range: ReportRange): Prisma.Sql {
    return Prisma.sql`
      SELECT m.status, m.contact_id, m.number_id, m.cost_usd_micros, t.category::text AS category,
             to_char((m.created_at AT TIME ZONE ${range.timeZone})::date, 'YYYY-MM-DD') AS day,
             (${DELIVERED} AND ${REPLIED}) AS replied, ${CLICKED} AS clicked
        FROM messages m JOIN templates t ON t.id = m.template_id
       WHERE m.origin = 'CAMPAIGN' AND m.created_at >= ${range.start} AND m.created_at < ${range.end}`;
  }

  async report(range: ReportRange): Promise<OverviewReport> {
    const rows = await this.prisma.$queryRaw<GroupedRow[]>`
      WITH base AS (${this.base(range)})
      SELECT GROUPING(day)::int AS g_day, GROUPING(category)::int AS g_category, GROUPING(number_id)::int AS g_number,
             day, category, number_id::text AS number_id, ${COUNTS}
        FROM base m
       GROUP BY GROUPING SETS ((), (day), (category), (number_id))`;
    const failed = await this.prisma.$queryRaw<Array<{ code: number | null; reason: string; count: number }>>`
      SELECT m.failure_code AS code, COALESCE(m.failure_reason, 'Unknown reason') AS reason, COUNT(*)::int AS count
        FROM messages m
       WHERE m.origin = 'CAMPAIGN' AND m.status = 'FAILED' AND m.created_at >= ${range.start} AND m.created_at < ${range.end}
       GROUP BY 1, 2
       ORDER BY 3 DESC
       LIMIT 50`;
    const totals = rows.find((r) => r.g_day && r.g_category && r.g_number);
    const days = rows.filter((r) => !r.g_day && r.day).map((r) => ({ day: r.day!, ...toCounts(r) })).sort((a, b) => a.day.localeCompare(b.day));
    const byCategory = rows.filter((r) => !r.g_category && r.category).map((r) => ({ category: r.category!, ...toCounts(r) })).sort((a, b) => a.category.localeCompare(b.category));
    const numberRows = rows.filter((r) => !r.g_number && r.number_id);
    const labels = new Map((await this.prisma.whatsAppNumber.findMany({ where: { id: { in: numberRows.map((r) => r.number_id!) } }, select: { id: true, label: true } })).map((n) => [n.id, n.label]));
    const byNumber = numberRows.map((r) => ({ numberId: r.number_id!, label: labels.get(r.number_id!) ?? 'Removed number', ...toCounts(r) })).sort((a, b) => a.label.localeCompare(b.label));
    return { from: range.from, to: range.to, totals: toCounts(totals), days, byCategory, byNumber, failedByReason: failed };
  }

  /** One row per day, category and number, for the CSV download. */
  async rows(range: ReportRange): Promise<Array<Counts & { day: string; category: string; numberId: string; label: string }>> {
    const rows = await this.prisma.$queryRaw<Array<CountsRow & { day: string; category: string; number_id: string }>>`
      WITH base AS (${this.base(range)})
      SELECT day, category, number_id::text AS number_id, ${COUNTS}
        FROM base m
       GROUP BY day, category, number_id
       ORDER BY day, category, number_id`;
    const labels = new Map((await this.prisma.whatsAppNumber.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.number_id))] } }, select: { id: true, label: true } })).map((n) => [n.id, n.label]));
    return rows.map((r) => ({ day: r.day, category: r.category, numberId: r.number_id, label: labels.get(r.number_id) ?? 'Removed number', ...toCounts(r) }));
  }
}
