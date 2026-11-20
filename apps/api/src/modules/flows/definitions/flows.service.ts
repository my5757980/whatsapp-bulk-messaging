import { HttpStatus, Injectable } from '@nestjs/common';
import { emptyGraph, FlowGraphSchema, validateForPublish, type FlowGraph } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { FLOW_INCLUDE, parseGraph, toFlowDetail, toFlowSummary, type FlowRow } from './flow-views.js';
import { ReservedKeywords } from './reserved-keywords.js';

export const CreateFlowSchema = z.strictObject({ name: z.string().trim().min(1).max(80), starterKey: z.string().max(40).optional() });
export type CreateFlowInput = z.infer<typeof CreateFlowSchema>;
export const UpdateFlowSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  priority: z.int().min(1).max(1000).optional(),
  allNumbers: z.boolean().optional(),
  numberIds: z.array(z.uuid()).max(50).optional(),
  testNumbers: z.array(z.string().trim().min(1).max(20)).max(3).optional(),
});
export type UpdateFlowInput = z.infer<typeof UpdateFlowSchema>;
export const SaveDraftSchema = z.strictObject({ graph: FlowGraphSchema, draftRevision: z.int().min(0) });
export type SaveDraftInput = z.infer<typeof SaveDraftSchema>;

/** Autosave keeps one revision a minute and the newest 20 (FR-007). */
const REVISION_EVERY_MS = 60_000;
export const REVISIONS_KEPT = 20;

/**
 * Flow definitions (003 T022, FR-001, FR-002, FR-005): list, create, rename, numbers, priority,
 * test numbers, duplicate, delete (not while published) and draft saves with a revision check.
 */
@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reserved: ReservedKeywords,
    private readonly settings: SettingsService,
  ) {}

  async list() {
    const rows = await this.prisma.flow.findMany({ where: { deletedAt: null }, include: FLOW_INCLUDE, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    const since = new Date(Date.now() - 7 * 86_400_000);
    const counts = await this.prisma.flowSession.groupBy({
      by: ['flowId', 'result'],
      where: { flowId: { in: rows.map((r) => r.id) }, isTest: false, startedAt: { gte: since } },
      _count: { _all: true },
    });
    return rows.map((row) => {
      const mine = counts.filter((c) => c.flowId === row.id);
      return toFlowSummary(row, {
        started: mine.reduce((n, c) => n + c._count._all, 0),
        completed: mine.filter((c) => c.result === 'COMPLETED').reduce((n, c) => n + c._count._all, 0),
      });
    });
  }

  /** The flow with its draft and what would block publishing it now (the editor shows these on open). */
  async get(id: string) {
    const row = await this.load(id);
    return toFlowDetail(row, validateForPublish(parseGraph(row.draft), { reservedKeywords: await this.reserved.list() }));
  }

  async load(id: string): Promise<FlowRow> {
    const row = await this.prisma.flow.findFirst({ where: { id, deletedAt: null }, include: FLOW_INCLUDE });
    if (!row) throw AppError.notFound('Flow not found');
    return row;
  }

  async create(input: CreateFlowInput, actor: AuditActor) {
    // Starter flows arrive with US9.
    if (input.starterKey) throw AppError.validation('Unknown starter flow', [{ field: 'starterKey', issue: 'is not a starter flow' }]);
    const row = await this.withName(() =>
      this.prisma.flow.create({ data: { name: input.name, draft: emptyGraph() as Prisma.InputJsonValue, createdById: actor.userId ?? null }, include: FLOW_INCLUDE }),
    );
    await this.audit.record(actor, 'flow.created', { type: 'flow', id: row.id }, { name: row.name });
    return toFlowDetail(row);
  }

  async update(id: string, input: UpdateFlowInput, actor: AuditActor) {
    const current = await this.load(id);
    const testNumbers = input.testNumbers ? await this.normaliseTestNumbers(input.testNumbers) : undefined;
    if (input.numberIds) {
      const found = await this.prisma.whatsAppNumber.count({ where: { id: { in: input.numberIds } } });
      if (found !== new Set(input.numberIds).size) throw AppError.validation('Some numbers do not exist', [{ field: 'numberIds', issue: 'contains an unknown number' }]);
    }
    const row = await this.withName(() =>
      this.prisma.$transaction(async (tx) => {
        if (input.numberIds) {
          await tx.flowNumber.deleteMany({ where: { flowId: id } });
          await tx.flowNumber.createMany({ data: [...new Set(input.numberIds)].map((numberId) => ({ flowId: id, numberId })) });
        }
        return tx.flow.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.allNumbers !== undefined ? { allNumbers: input.allNumbers } : {}),
            ...(testNumbers ? { testNumbers } : {}),
          },
          include: FLOW_INCLUDE,
        });
      }),
    );
    const changed = (['name', 'priority', 'allNumbers', 'numberIds'] as const).filter((key) => input[key] !== undefined);
    if (changed.length) await this.audit.record(actor, 'flow.updated', { type: 'flow', id }, { name: row.name, changed });
    if (testNumbers && JSON.stringify(testNumbers) !== JSON.stringify(current.testNumbers)) {
      await this.audit.record(actor, 'flow.test_numbers_updated', { type: 'flow', id }, { name: row.name, count: testNumbers.length });
    }
    return toFlowDetail(row);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.load(id);
    if (row.status === 'PUBLISHED') throw AppError.conflict('Unpublish the flow before deleting it', 'FLOW_PUBLISHED');
    await this.prisma.flow.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record(actor, 'flow.deleted', { type: 'flow', id }, { name: row.name });
  }

  async duplicate(id: string, actor: AuditActor) {
    const source = await this.load(id);
    let name = `${source.name} (copy)`.slice(0, 80);
    for (let n = 2; await this.prisma.flow.findFirst({ where: { name, deletedAt: null }, select: { id: true } }); n++) name = `${source.name} (copy ${n})`.slice(0, 80);
    const row = await this.withName(() =>
      this.prisma.flow.create({
        data: {
          name,
          priority: source.priority,
          allNumbers: source.allNumbers,
          draft: source.draft as Prisma.InputJsonValue,
          createdById: actor.userId ?? null,
          numbers: { create: source.numbers.map((n) => ({ numberId: n.numberId })) },
        },
        include: FLOW_INCLUDE,
      }),
    );
    await this.audit.record(actor, 'flow.duplicated', { type: 'flow', id: row.id }, { name: row.name, from: source.id });
    return toFlowDetail(row);
  }

  /** Saves the draft when the editor's revision is current (409 DRAFT_CONFLICT otherwise). */
  async saveDraft(id: string, input: SaveDraftInput, userId: string | null) {
    const graph: FlowGraph = input.graph;
    const saved = await this.prisma.flow.updateMany({
      where: { id, deletedAt: null, draftRevision: input.draftRevision },
      data: { draft: graph as Prisma.InputJsonValue, draftRevision: { increment: 1 }, draftUpdatedAt: new Date(), draftUpdatedById: userId },
    });
    if (!saved.count) {
      await this.load(id);
      throw AppError.conflict('Someone saved a newer version of this flow; reload to continue', 'DRAFT_CONFLICT');
    }
    await this.recordRevision(id, graph, userId);
    return { draftRevision: input.draftRevision + 1, problems: validateForPublish(graph, { reservedKeywords: await this.reserved.list() }) };
  }

  /**
   * Autosave revisions (003 T071, FR-007): at most one a minute (the latest takes later saves within
   * its minute), and only the newest 20 are kept.
   */
  async recordRevision(flowId: string, graph: unknown, userId: string | null): Promise<void> {
    const last = await this.prisma.flowVersion.findFirst({ where: { flowId, kind: 'REVISION' }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
    if (last && Date.now() - last.createdAt.getTime() < REVISION_EVERY_MS) {
      await this.prisma.flowVersion.update({ where: { id: last.id }, data: { graph: graph as Prisma.InputJsonValue, createdById: userId } });
    } else {
      await this.prisma.flowVersion.create({ data: { flowId, kind: 'REVISION', graph: graph as Prisma.InputJsonValue, createdById: userId } });
    }
    const stale = await this.prisma.flowVersion.findMany({ where: { flowId, kind: 'REVISION' }, orderBy: { createdAt: 'desc' }, skip: REVISIONS_KEPT, select: { id: true } });
    if (stale.length) await this.prisma.flowVersion.deleteMany({ where: { id: { in: stale.map((v) => v.id) } } });
  }

  private async normaliseTestNumbers(values: string[]): Promise<string[]> {
    const { defaultCountryCode } = await this.settings.get();
    const numbers = values.map((value, i) => {
      const phone = normalizePhone(value, defaultCountryCode);
      if (!phone) throw AppError.validation('Test numbers must be valid phone numbers', [{ field: `testNumbers[${i}]`, issue: 'is not a valid phone number' }]);
      return phone.e164;
    });
    return [...new Set(numbers)];
  }

  private async withName<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(HttpStatus.CONFLICT, 'NAME_TAKEN', 'Another flow already has this name');
      throw error;
    }
  }
}
