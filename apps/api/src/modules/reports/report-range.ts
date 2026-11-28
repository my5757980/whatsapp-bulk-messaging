import { REPORT_RANGE_WORDS, dayInZone, reportRangeBounds, reportRangeProblem } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';

// Feature 009 (research R14): the shared pieces of the overview, team member and opt-in reports.

export const RangeQuerySchema = z.object({ from: z.string().trim(), to: z.string().trim() });
export type RangeQuery = z.infer<typeof RangeQuerySchema>;

export interface ReportRange {
  from: string;
  to: string;
  timeZone: string;
  /** Local midnight of `from` (inclusive) and of the day after `to` (exclusive). */
  start: Date;
  end: Date;
}

/** Checks the range against the shared rules in the company time zone; 422 RANGE_INVALID otherwise. */
export async function resolveRange(prisma: PrismaService, query: RangeQuery, now = new Date()): Promise<ReportRange> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
  const timeZone = settings?.defaultTimezone ?? 'UTC';
  const problem = reportRangeProblem(query.from, query.to, dayInZone(now, timeZone));
  if (problem) throw AppError.validation(REPORT_RANGE_WORDS[problem], [{ field: problem === 'TO_BEFORE_FROM' ? 'to' : 'from', issue: REPORT_RANGE_WORDS[problem] }], 'RANGE_INVALID');
  return { from: query.from, to: query.to, timeZone, ...reportRangeBounds(query.from, query.to, timeZone) };
}

/** Exact dollars from micros, as the contract's decimal string. */
export function microsToDecimal(micros: bigint | number | null | undefined): string {
  const value = BigInt(micros ?? 0);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, '0')}`;
}

/** Aggregates over a base set (alias `m`) with status, contact_id, cost_usd_micros and the replied/clicked flags. */
export const COUNTS = Prisma.sql`
  COUNT(*) FILTER (WHERE m.status IN ('SENT', 'DELIVERED', 'READ'))::int AS sent,
  COUNT(*) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
  COUNT(*) FILTER (WHERE m.status = 'READ')::int AS read,
  COUNT(DISTINCT m.contact_id) FILTER (WHERE m.replied)::int AS replied,
  COUNT(DISTINCT m.contact_id) FILTER (WHERE m.clicked)::int AS clicked,
  COUNT(*) FILTER (WHERE m.status = 'FAILED')::int AS failed,
  COUNT(*) FILTER (WHERE m.status = 'EXPIRED')::int AS expired,
  COALESCE(SUM(m.cost_usd_micros), 0)::bigint AS cost_micros`;

export interface CountsRow {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
  expired: number;
  cost_micros: bigint | number;
}

export interface Counts {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
  expired: number;
  estimatedCostUsd: string;
}

export const ZERO_COUNTS: Counts = { sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0, expired: 0, estimatedCostUsd: '0.000000' };

export function toCounts(row: CountsRow | undefined): Counts {
  if (!row) return { ...ZERO_COUNTS };
  return { sent: row.sent, delivered: row.delivered, read: row.read, replied: row.replied, clicked: row.clicked, failed: row.failed, expired: row.expired, estimatedCostUsd: microsToDecimal(row.cost_micros) };
}

export const COUNT_COLUMNS = ['sent', 'delivered', 'read', 'replied', 'clicked', 'failed', 'expired', 'estimated_cost_usd'];

export function countCells(c: Counts): Array<string | number> {
  return [c.sent, c.delivered, c.read, c.replied, c.clicked, c.failed, c.expired, c.estimatedCostUsd];
}
