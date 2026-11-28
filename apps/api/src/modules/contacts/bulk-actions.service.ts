import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { Prisma, type BulkAction, type BulkActionKind } from '../../generated/prisma/client.js';
import type { AuditActor } from '../audit/audit.service.js';
import { ContactFilterSchema, contactFilterSql } from './contact-filter.sql.js';
import { SegmentQueryBuilder } from './segment-query.builder.js';

// Feature 010 (research R3, FR-008, FR-009): bulk work on many contacts runs in the background on the
// `bulk` queue, one action at a time and in order. The selection is walked in id order, in batches of
// 5,000, using the live filter or segment, so contacts that match when the action runs are changed.

export const BULK_BATCH = 5_000;

export const SelectionSchema = z.union([
  z.object({ contactIds: z.array(z.uuid()).min(1).max(10_000) }).strict(),
  z.object({ filter: ContactFilterSchema }).strict(),
  z.object({ segmentId: z.uuid() }).strict(),
]);
export type Selection = z.infer<typeof SelectionSchema>;

export const BulkTagInputSchema = z
  .object({ kind: z.enum(['TAG_ADD', 'TAG_REMOVE']), tagIds: z.array(z.uuid()).min(1).max(20), selection: SelectionSchema })
  .strict();
export type BulkTagInput = z.infer<typeof BulkTagInputSchema>;

/** The BullMQ job name for each kind; tags run in the contacts module, drip enrolment in the drips module. */
export const BULK_JOB: Record<BulkActionKind, string> = { TAG_ADD: 'tags', TAG_REMOVE: 'tags', DRIP_ENROL: 'drip-enrol' };

type Row = BulkAction & { createdBy?: { name: string | null } | null };

export function toBulkActionDto(row: Row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    processed: row.processed,
    changed: row.changed,
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: row.error,
    createdBy: row.createdBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class BulkActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly segments: SegmentQueryBuilder,
  ) {}

  /** Records the action and queues it; segments must exist and not be broken. */
  async create(kind: BulkActionKind, params: Record<string, unknown>, selection: Selection, actor: AuditActor) {
    if ('segmentId' in selection) {
      try {
        await this.segments.whereFor(selection.segmentId);
      } catch (error) {
        if (error instanceof AppError && error.code === 'SEGMENT_NOT_FOUND') throw new AppError(404, 'SEGMENT_NOT_FOUND', 'Segment not found');
        throw error;
      }
    }
    const row = await this.prisma.bulkAction.create({
      data: { kind, params: params as Prisma.InputJsonValue, selection: selection as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null },
    });
    await this.queues.get(QUEUES.BULK).add(BULK_JOB[kind], { actionId: row.id }, { jobId: `bulk-${row.id}`, removeOnComplete: true, removeOnFail: 100 });
    return toBulkActionDto(row);
  }

  async createTags(input: BulkTagInput, actor: AuditActor) {
    const found = await this.prisma.tag.count({ where: { id: { in: input.tagIds } } });
    if (found !== new Set(input.tagIds).size) throw new AppError(404, 'TAG_NOT_FOUND', 'A tag no longer exists');
    return this.create(input.kind, { tagIds: [...new Set(input.tagIds)] }, input.selection, actor);
  }

  async get(id: string) {
    const row = await this.prisma.bulkAction.findUnique({ where: { id }, include: { createdBy: { select: { name: true } } } });
    if (!row) throw AppError.notFound('Bulk action not found');
    return toBulkActionDto(row);
  }

  async list() {
    const rows = await this.prisma.bulkAction.findMany({ include: { createdBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { items: rows.map(toBulkActionDto) };
  }

  // ---------- Used by the processors ----------

  /** Marks the action of this kind running and returns it, or null when it is missing, finished or of another kind. */
  async start(id: string, kinds: readonly BulkActionKind[]): Promise<BulkAction | null> {
    const action = await this.prisma.bulkAction.findUnique({ where: { id }, select: { kind: true } });
    if (!action || !kinds.includes(action.kind)) return null;
    const { count } = await this.prisma.bulkAction.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING', startedAt: new Date() } });
    return count ? this.prisma.bulkAction.findUnique({ where: { id } }) : null;
  }

  async progress(id: string, data: { total?: number; processed?: number; changed?: number }): Promise<void> {
    await this.prisma.bulkAction.update({ where: { id }, data });
  }

  async finish(id: string, outcome: { result?: Record<string, unknown>; error?: string }): Promise<void> {
    await this.prisma.bulkAction.update({
      where: { id },
      data: {
        status: outcome.error ? 'FAILED' : 'DONE',
        finishedAt: new Date(),
        ...(outcome.result ? { result: outcome.result as Prisma.InputJsonValue } : {}),
        ...(outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
      },
    });
  }

  /** How many contacts the selection holds now. */
  async total(selection: Selection): Promise<number> {
    if ('contactIds' in selection) return new Set(selection.contactIds).size;
    const where = await this.where(selection);
    const [row] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM contacts c WHERE ${where}`;
    return Number(row?.n ?? 0);
  }

  /** The selection's contact ids in id order, in batches. */
  async *batches(selection: Selection, size = BULK_BATCH): AsyncGenerator<string[]> {
    if ('contactIds' in selection) {
      const ids = [...new Set(selection.contactIds)].sort();
      for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
      return;
    }
    const where = await this.where(selection);
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const rows: Array<{ id: string }> = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM contacts c WHERE (${where}) ${after} ORDER BY c.id LIMIT ${size}`;
      if (!rows.length) return;
      cursor = rows[rows.length - 1]!.id;
      yield rows.map((r) => r.id);
      if (rows.length < size) return;
    }
  }

  private async where(selection: Exclude<Selection, { contactIds: string[] }>): Promise<Prisma.Sql> {
    return 'segmentId' in selection ? this.segments.whereFor(selection.segmentId) : contactFilterSql(selection.filter);
  }
}
