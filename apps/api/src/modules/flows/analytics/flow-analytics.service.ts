import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { csvField } from '../../campaigns/csv.js';
import { FlowsService } from '../definitions/flows.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
export const AnalyticsQuerySchema = z
  .object({ period: z.enum(['today', '7d', '30d', 'custom']).default('7d'), from: isoDate.optional(), to: isoDate.optional(), versionId: z.uuid().optional() })
  .strict()
  .superRefine((q, ctx) => {
    if (q.period !== 'custom') return;
    if (!q.from || !q.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'from and to are required for a custom period' });
    else if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before from' });
    else if (Date.parse(q.to) - Date.parse(q.from) > 366 * 86_400_000) ctx.addIssue({ code: 'custom', path: ['to'], message: 'a period can be at most a year' });
  });
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** Calendar days in each period, today included (as the 002 team view). */
const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 } as const;

const RESULT_TOTAL: Record<string, keyof Totals> = {
  COMPLETED: 'completed',
  HANDED_OVER: 'handedOver',
  TIMED_OUT: 'timedOut',
  STOPPED_BY_MEMBER: 'stoppedByMember',
  OPTED_OUT: 'optedOut',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
};

export interface Totals {
  started: number;
  completed: number;
  handedOver: number;
  timedOut: number;
  stoppedByMember: number;
  optedOut: number;
  interrupted: number;
  failed: number;
  /** Window closed, send failed, unpublished, expired or blocked. */
  other: number;
  running: number;
}

/**
 * Flow analytics (003 T076, FR-035, FR-036, research R12): sessions started in the period (company
 * time zone, test sessions left out) by result, and per step how many entered, moved on or dropped
 * (the session ended at that step without completing or handing over), with counts per option.
 */
@Injectable()
export class FlowAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
  ) {}

  async get(flowId: string, query: AnalyticsQuery) {
    const flow = await this.flows.load(flowId);
    const { start, end } = await this.bounds(query);
    const versionId = query.versionId ?? flow.publishedVersionId ?? null;
    const scope = this.scope(flowId, start, end, versionId);

    const results = await this.prisma.$queryRaw<Array<{ status: string; result: string | null; n: number }>>`
      SELECT s.status::text AS status, s.result::text AS result, count(*)::int AS n FROM (${scope}) s GROUP BY s.status, s.result`;
    const totals: Totals = { started: 0, completed: 0, handedOver: 0, timedOut: 0, stoppedByMember: 0, optedOut: 0, interrupted: 0, failed: 0, other: 0, running: 0 };
    for (const row of results) {
      totals.started += row.n;
      if (row.status === 'RUNNING') totals.running += row.n;
      else totals[RESULT_TOTAL[row.result ?? ''] ?? 'other'] += row.n;
    }

    const steps = await this.prisma.$queryRaw<Array<{ step_id: string; entered: number; continued: number; dropped: number }>>`
      WITH scoped AS (${scope}),
      last_step AS (
        SELECT DISTINCT ON (st.session_id) st.id FROM flow_session_steps st JOIN scoped ON scoped.id = st.session_id ORDER BY st.session_id, st.id DESC
      ),
      marked AS (
        SELECT st.step_id, st.left_at, (l.id IS NOT NULL AND sc.status = 'ENDED' AND sc.result NOT IN ('COMPLETED', 'HANDED_OVER')) AS dropped
          FROM flow_session_steps st
          JOIN scoped sc ON sc.id = st.session_id
          LEFT JOIN last_step l ON l.id = st.id
      )
      SELECT step_id, count(*)::int AS entered,
             (count(*) FILTER (WHERE left_at IS NOT NULL AND NOT dropped))::int AS continued,
             (count(*) FILTER (WHERE dropped))::int AS dropped
        FROM marked
       GROUP BY step_id`;
    const options = await this.prisma.$queryRaw<Array<{ step_id: string; branch: string; n: number }>>`
      WITH scoped AS (${scope})
      SELECT st.step_id, st.branch, count(*)::int AS n
        FROM flow_session_steps st JOIN scoped ON scoped.id = st.session_id
       WHERE st.branch IS NOT NULL
       GROUP BY st.step_id, st.branch`;

    return {
      period: query.period,
      from: start.toISOString(),
      to: end.toISOString(),
      versionId,
      totals,
      steps: steps
        .sort((a, b) => a.step_id.localeCompare(b.step_id))
        .map((s) => ({
          stepId: s.step_id,
          entered: s.entered,
          continued: s.continued,
          dropped: s.dropped,
          options: options.filter((o) => o.step_id === s.step_id).map((o) => ({ key: o.branch, count: o.n })),
        })),
    };
  }

  /** CSV of the contacts whose session ended at a step without completing (FR-036): name, phone, result, ended_at. */
  async droppedCsv(flowId: string, stepId: string, query: AnalyticsQuery): Promise<string> {
    const flow = await this.flows.load(flowId);
    const { start, end } = await this.bounds(query);
    const scope = this.scope(flowId, start, end, query.versionId ?? flow.publishedVersionId ?? null);
    const rows = await this.prisma.$queryRaw<Array<{ name: string | null; phone: string | null; result: string; ended_at: Date | null }>>`
      WITH scoped AS (${scope}),
      last_step AS (
        SELECT DISTINCT ON (st.session_id) st.session_id, st.step_id FROM flow_session_steps st JOIN scoped ON scoped.id = st.session_id ORDER BY st.session_id, st.id DESC
      )
      SELECT c.name, c.phone_e164 AS phone, sc.result::text AS result, sc.ended_at
        FROM scoped sc
        JOIN last_step l ON l.session_id = sc.id
        LEFT JOIN contacts c ON c.id = sc.contact_id
       WHERE l.step_id = ${stepId} AND sc.status = 'ENDED' AND sc.result NOT IN ('COMPLETED', 'HANDED_OVER')
       ORDER BY sc.ended_at DESC`;
    const lines = [['name', 'phone', 'result', 'ended_at'], ...rows.map((r) => [r.name ?? '', r.phone ?? '', r.result, r.ended_at?.toISOString() ?? ''])];
    return `${lines.map((line) => line.map(csvField).join(',')).join('\r\n')}\r\n`;
  }

  /** Sessions of the flow started in the period, test runs left out, of one version when given. */
  private scope(flowId: string, start: Date, end: Date, versionId: string | null): Prisma.Sql {
    return Prisma.sql`
      SELECT s.id, s.status, s.result, s.contact_id, s.ended_at
        FROM flow_sessions s
       WHERE s.flow_id = ${flowId}::uuid AND NOT s.is_test AND s.started_at >= ${start} AND s.started_at < ${end}
             ${versionId ? Prisma.sql`AND s.flow_version_id = ${versionId}::uuid` : Prisma.empty}`;
  }

  /** The period in the company time zone: from local midnight `days - 1` days ago, or whole custom days. */
  private async bounds(query: AnalyticsQuery): Promise<{ start: Date; end: Date }> {
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    const timezone = settings?.defaultTimezone ?? 'UTC';
    if (query.period === 'custom') {
      if (!query.from || !query.to) throw AppError.validation('from and to are required for a custom period', [{ field: 'from', issue: 'is required' }]);
      const [row] = await this.prisma.$queryRaw<Array<{ start: Date; end: Date }>>`
        SELECT (${query.from}::date::timestamp AT TIME ZONE ${timezone}) AS start, ((${query.to}::date + 1)::timestamp AT TIME ZONE ${timezone}) AS end`;
      return { start: row!.start, end: row!.end };
    }
    const [row] = await this.prisma.$queryRaw<Array<{ start: Date }>>`
      SELECT ((date_trunc('day', now() AT TIME ZONE ${timezone}) - make_interval(days => ${PERIOD_DAYS[query.period] - 1}::int)) AT TIME ZONE ${timezone}) AS start`;
    return { start: row?.start ?? new Date(), end: new Date() };
  }
}
