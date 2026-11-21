import { isIP } from 'node:net';
import { HttpStatus, Injectable } from '@nestjs/common';
import { agentConfigProblems, type AgentConfig, type AgentProblem } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { isBlockedAddress } from '../../flows/steps/api-client.js';
import { AGENT_INCLUDE, parseConfig, toAgentDetail } from './agent-views.js';

const SECRET_REFERENCE = /\{secret:([^}]+)\}/g;

/** A skill address whose host is written as a private or local address (localhost, 10.x, 192.168.x, ::1 …). */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.trim().replace(/\{[^}]*\}/g, 'x')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && isBlockedAddress(host);
}

/**
 * Publishing agents (T034, FR-002, FR-005): the shared checks plus the ones that need the database;
 * publishing writes a numbered, immutable version. Unpublishing stops new answers; active AI
 * conversations end at their next customer message (UNPUBLISHED).
 */
@Injectable()
export class AgentPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everything that blocks publishing this configuration now. */
  async problems(agentId: string, config: AgentConfig): Promise<AgentProblem[]> {
    const problems = agentConfigProblems(config);
    const add = (code: string, message: string, field: string | null) => problems.push({ code, message, field });

    const mediaIds = config.skills.media.map((m) => m.mediaId);
    if (mediaIds.length) {
      const found = new Set(
        (await this.prisma.mediaAsset.findMany({ where: { id: { in: mediaIds }, purpose: 'LIBRARY', removedAt: null }, select: { id: true } })).map((m) => m.id),
      );
      config.skills.media.forEach((m, i) => {
        if (!found.has(m.mediaId)) add('MEDIA_NOT_FOUND', 'This file is no longer in the media library.', `skills.media[${i}].mediaId`);
      });
    }

    const keys = config.skills.memory.map((m) => m.key);
    if (keys.length) {
      const found = new Set((await this.prisma.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((a) => a.key));
      config.skills.memory.forEach((m, i) => {
        if (!found.has(m.key)) add('UNKNOWN_ATTRIBUTE', `There is no attribute "${m.key}".`, `skills.memory[${i}].key`);
      });
    }

    const flowIds = config.skills.flows.map((f) => f.flowId);
    if (flowIds.length) {
      const published = new Set(
        (await this.prisma.flow.findMany({ where: { id: { in: flowIds }, status: 'PUBLISHED', deletedAt: null }, select: { id: true } })).map((f) => f.id),
      );
      config.skills.flows.forEach((f, i) => {
        if (!published.has(f.flowId)) add('FLOW_NOT_PUBLISHED', 'This flow is not published.', `skills.flows[${i}].flowId`);
      });
    }

    const secretIds = new Set((await this.prisma.aiAgentSecret.findMany({ where: { agentId }, select: { id: true } })).map((s) => s.id));
    config.skills.api.forEach((skill, i) => {
      // Private and local addresses are refused here when written as such; names are checked again at call time.
      if (isPrivateHost(skill.request.url)) add('BLOCKED_ADDRESS', 'This address is on a private network, which skills cannot reach.', `skills.api[${i}].request.url`);
      skill.request.headers.forEach((header, h) => {
        for (const match of header.value.matchAll(SECRET_REFERENCE)) {
          if (!secretIds.has(match[1]!)) add('UNKNOWN_SECRET', 'This header uses a secret that does not exist.', `skills.api[${i}].request.headers[${h}].value`);
        }
      });
    });

    const replaceMe = await this.prisma.aiKnowledgeSource.count({ where: { agentId, replaceMe: true } });
    if (replaceMe) add('REPLACE_ME_LEFT', `Replace or remove the ${replaceMe} example answer(s) marked "replace me".`, 'knowledge');

    return problems;
  }

  async publish(id: string, actor: AuditActor) {
    const row = await this.prisma.aiAgent.findFirst({ where: { id, deletedAt: null }, include: AGENT_INCLUDE });
    if (!row) throw AppError.notFound('Agent not found');
    const config = parseConfig(row.draft, row.name);
    const problems = await this.problems(id, config);
    if (problems.length) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'PUBLISH_BLOCKED', 'Fix the listed problems before publishing', undefined, { problems });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-agent-publish:${id}`}::text))`;
      const last = await tx.aiAgentVersion.aggregate({ where: { agentId: id }, _max: { number: true } });
      const version = await tx.aiAgentVersion.create({
        data: { agentId: id, number: (last._max.number ?? 0) + 1, config: config as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null },
      });
      return tx.aiAgent.update({ where: { id }, data: { status: 'PUBLISHED', publishedVersionId: version.id }, include: AGENT_INCLUDE });
    });
    await this.audit.record(actor, 'ai.agent_published', { type: 'ai_agent', id }, { name: updated.name, version: updated.publishedVersion?.number ?? null });
    return toAgentDetail(updated, []);
  }

  async unpublish(id: string, actor: AuditActor) {
    const row = await this.prisma.aiAgent.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } });
    if (!row) throw AppError.notFound('Agent not found');
    const updated = await this.prisma.aiAgent.update({ where: { id }, data: { status: row.status === 'DRAFT' ? 'DRAFT' : 'UNPUBLISHED' }, include: AGENT_INCLUDE });
    await this.audit.record(actor, 'ai.agent_unpublished', { type: 'ai_agent', id }, { name: updated.name });
    return toAgentDetail(updated, await this.problems(id, parseConfig(updated.draft, updated.name)));
  }
}
