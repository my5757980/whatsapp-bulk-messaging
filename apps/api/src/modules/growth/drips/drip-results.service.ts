import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { PageQuerySchema } from '../../../common/validation/pagination.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { retargetCondition } from '../../campaigns/retarget.service.js';

// Drip results (feature 005 US6, FR-035, FR-036, research R11): counted with SQL when read, so every
// number equals the records behind it. Replies use the retarget rule (a message to the drip's number
// within 72 hours of the step's delivery).

export const STEP_METRICS = ['SENT', 'DELIVERED', 'READ', 'CLICKED', 'REPLIED', 'FAILED', 'SKIPPED'] as const;
export type StepMetric = (typeof STEP_METRICS)[number];

export const MetricQuerySchema = z.object({ stepId: z.uuid(), metric: z.enum(STEP_METRICS) });
export const MetricPageQuerySchema = PageQuerySchema.extend(MetricQuerySchema.shape);
export type MetricQuery = z.infer<typeof MetricQuerySchema>;
export type MetricPageQuery = z.infer<typeof MetricPageQuerySchema>;

export interface DripResultsDto {
  active: number;
  finished: number;
  left: Record<string, number>;
  steps: Array<{
    stepId: string;
    position: number;
    templateName: string;
    removed: boolean;
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    replied: number;
    failed: number;
    skipped: number;
  }>;
}

export interface ContactRowDto {
  id: string | null;
  name: string | null;
  /** Masked for roles without phones.full by the global PhoneMaskInterceptor. */
  phone: string | null;
}

/** Which step messages (alias `m`) a metric counts; SKIPPED has no message. */
function metricCondition(metric: Exclude<StepMetric, 'SKIPPED'>): Prisma.Sql {
  switch (metric) {
    case 'SENT':
      return Prisma.sql`m.status IN ('SENT', 'DELIVERED', 'READ')`;
    case 'DELIVERED':
      return Prisma.sql`m.status IN ('DELIVERED', 'READ')`;
    case 'READ':
      return Prisma.sql`m.status = 'READ'`;
    case 'CLICKED':
      return retargetCondition('CLICKED');
    case 'REPLIED':
      return retargetCondition('REPLIED');
    case 'FAILED':
      return Prisma.sql`m.status = 'FAILED'`;
  }
}

@Injectable()
export class DripResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async results(dripId: string): Promise<DripResultsDto> {
    await this.assertDrip(dripId);
    const enrolments = await this.prisma.dripEnrolment.groupBy({ by: ['status', 'leftReason'], where: { dripId }, _count: { _all: true } });
    const result: DripResultsDto = { active: 0, finished: 0, left: {}, steps: [] };
    for (const row of enrolments) {
      if (row.status === 'ACTIVE') result.active += row._count._all;
      else if (row.status === 'FINISHED') result.finished += row._count._all;
      else result.left[row.leftReason ?? 'UNKNOWN'] = (result.left[row.leftReason ?? 'UNKNOWN'] ?? 0) + row._count._all;
    }
    result.steps = await this.prisma.$queryRaw<DripResultsDto['steps']>`
      SELECT s.id AS "stepId", s.position::int AS position, t.name AS "templateName", (s.deleted_at IS NOT NULL) AS removed,
             COUNT(m.id) FILTER (WHERE ${metricCondition('SENT')})::int AS sent,
             COUNT(m.id) FILTER (WHERE ${metricCondition('DELIVERED')})::int AS delivered,
             COUNT(m.id) FILTER (WHERE ${metricCondition('READ')})::int AS read,
             COUNT(m.id) FILTER (WHERE ${metricCondition('CLICKED')})::int AS clicked,
             COUNT(m.id) FILTER (WHERE ${metricCondition('REPLIED')})::int AS replied,
             COUNT(m.id) FILTER (WHERE ${metricCondition('FAILED')})::int AS failed,
             COUNT(ss.id) FILTER (WHERE ss.outcome = 'SKIPPED')::int AS skipped
        FROM drip_steps s
        JOIN templates t ON t.id = s.template_id
        LEFT JOIN drip_step_sends ss ON ss.step_id = s.id
        LEFT JOIN messages m ON m.id = ss.message_id
       WHERE s.drip_id = ${dripId}::uuid
         AND (s.deleted_at IS NULL OR EXISTS (SELECT 1 FROM drip_step_sends x WHERE x.step_id = s.id))
       GROUP BY s.id, t.name
       ORDER BY s.deleted_at IS NOT NULL, s.position, s.created_at`;
    return result;
  }

  /** The contacts behind one count of a step, paged (FR-035). */
  async contacts(dripId: string, query: MetricPageQuery): Promise<{ items: ContactRowDto[]; total: number }> {
    await this.assertStep(dripId, query.stepId);
    const from = this.from(query);
    const [{ total } = { total: 0 }] = await this.prisma.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS total ${from}`;
    const items = await this.prisma.$queryRaw<ContactRowDto[]>`
      SELECT c.id, c.name, COALESCE(c.phone_e164, m.phone_e164) AS phone ${from}
       ORDER BY ss.created_at DESC, ss.id
       LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    return { items, total };
  }

  /** The same contacts in batches, for the export (flat memory). */
  async *batches(dripId: string, query: MetricQuery, size = 1000): AsyncGenerator<ContactRowDto[]> {
    await this.assertStep(dripId, query.stepId);
    const from = this.from(query);
    for (let offset = 0; ; offset += size) {
      const rows = await this.prisma.$queryRaw<ContactRowDto[]>`
        SELECT c.id, c.name, COALESCE(c.phone_e164, m.phone_e164) AS phone ${from}
         ORDER BY ss.created_at, ss.id
         LIMIT ${size} OFFSET ${offset}`;
      if (!rows.length) return;
      yield rows;
      if (rows.length < size) return;
    }
  }

  async assertDrip(dripId: string): Promise<{ id: string; name: string }> {
    const drip = await this.prisma.drip.findUnique({ where: { id: dripId }, select: { id: true, name: true } });
    if (!drip) throw AppError.notFound('Drip not found');
    return drip;
  }

  private async assertStep(dripId: string, stepId: string): Promise<void> {
    await this.assertDrip(dripId);
    if (!(await this.prisma.dripStep.findFirst({ where: { id: stepId, dripId }, select: { id: true } }))) throw AppError.notFound('Step not found');
  }

  /** FROM and WHERE of the rows behind a metric (one row per step send). */
  private from(query: MetricQuery): Prisma.Sql {
    const base = Prisma.sql`FROM drip_step_sends ss
      JOIN drip_enrolments e ON e.id = ss.enrolment_id
      LEFT JOIN messages m ON m.id = ss.message_id
      LEFT JOIN contacts c ON c.id = COALESCE(m.contact_id, e.contact_id)
     WHERE ss.step_id = ${query.stepId}::uuid`;
    return query.metric === 'SKIPPED' ? Prisma.sql`${base} AND ss.outcome = 'SKIPPED'` : Prisma.sql`${base} AND m.id IS NOT NULL AND ${metricCondition(query.metric)}`;
  }
}
