import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { AgentsService } from './agents.service.js';

/**
 * Published versions of an agent (T062, FR-005): every publish keeps a numbered copy of the
 * configuration. Restoring copies one into the draft; customers keep meeting the published version
 * until the next publish.
 */
@Injectable()
export class AgentVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
  ) {}

  /** Newest first, with the one customers meet marked current. */
  async list(agentId: string) {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id: agentId, deletedAt: null }, select: { publishedVersionId: true } });
    if (!agent) throw AppError.notFound('Agent not found');
    const rows = await this.prisma.aiAgentVersion.findMany({
      where: { agentId },
      orderBy: { number: 'desc' },
      select: { id: true, number: true, createdAt: true, createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((row) => ({ id: row.id, number: row.number, publishedAt: row.createdAt.toISOString(), publishedBy: row.createdBy, isCurrent: row.id === agent.publishedVersionId }));
  }

  /** Copies the version's configuration into the draft; an editor open on the old draft reloads (draftRevision). */
  async restore(agentId: string, versionId: string, actor: AuditActor) {
    const version = await this.prisma.aiAgentVersion.findFirst({ where: { id: versionId, agentId, agent: { deletedAt: null } }, select: { number: true, config: true } });
    if (!version) throw AppError.notFound('Version not found');
    await this.prisma.aiAgent.update({
      where: { id: agentId },
      data: { draft: version.config as Prisma.InputJsonValue, draftRevision: { increment: 1 }, draftUpdatedAt: new Date(), draftUpdatedById: actor.userId ?? null },
    });
    await this.audit.record(actor, 'ai.agent_restored', { type: 'ai_agent', id: agentId }, { version: version.number });
    return this.agents.get(agentId);
  }
}
