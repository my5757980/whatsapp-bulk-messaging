import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { FlowsService } from './flows.service.js';

/**
 * Versions and revisions (003 T071, FR-007): published versions plus the last 20 autosave revisions,
 * newest first; restoring copies one into the draft, keeping the draft it replaces as a revision so
 * the restore can itself be undone.
 */
@Injectable()
export class FlowVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly audit: AuditService,
  ) {}

  async list(flowId: string) {
    const flow = await this.flows.load(flowId);
    const rows = await this.prisma.flowVersion.findMany({
      where: { flowId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, kind: true, number: true, createdAt: true, createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      number: row.number,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      current: row.id === flow.publishedVersionId,
    }));
  }

  async restore(flowId: string, versionId: string, actor: AuditActor) {
    const flow = await this.flows.load(flowId);
    const version = await this.prisma.flowVersion.findFirst({ where: { id: versionId, flowId }, select: { id: true, kind: true, number: true, graph: true } });
    if (!version) throw AppError.notFound('Version not found');
    await this.flows.recordRevision(flowId, flow.draft, actor.userId ?? null);
    await this.prisma.flow.update({
      where: { id: flowId },
      data: { draft: version.graph as Prisma.InputJsonValue, draftRevision: { increment: 1 }, draftUpdatedAt: new Date(), draftUpdatedById: actor.userId ?? null },
    });
    await this.audit.record(actor, 'flow.restored', { type: 'flow', id: flowId }, { versionId: version.id, kind: version.kind, number: version.number });
    return this.flows.get(flowId);
  }
}
