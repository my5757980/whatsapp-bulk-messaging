import { HttpStatus, Injectable } from '@nestjs/common';
import { AgentConfigSchema, AI_LIMITS, defaultAgentConfig, type AgentConfig } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AGENT_INCLUDE, parseConfig, toAgentDetail, toAgentSummary, type AgentRow } from './agent-views.js';
import { AgentPublishService } from './publish.service.js';

export const CreateAgentSchema = z.strictObject({ name: z.string().trim().min(1).max(80), starterKey: z.string().max(40).optional() });
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;
export const RenameAgentSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });
export type RenameAgentInput = z.infer<typeof RenameAgentSchema>;
export const SaveAgentDraftSchema = z.strictObject({ config: AgentConfigSchema, draftRevision: z.int().min(0) });
export type SaveAgentDraftInput = z.infer<typeof SaveAgentDraftSchema>;
export const SetAgentNumbersSchema = z.strictObject({ numberIds: z.array(z.uuid()).max(50), replace: z.boolean().default(false) });
export type SetAgentNumbersInput = z.infer<typeof SetAgentNumbersSchema>;
export const SetTestNumbersSchema = z.strictObject({ testNumbers: z.array(z.string().trim().min(1).max(20)).max(AI_LIMITS.testNumbers) });
export type SetTestNumbersInput = z.infer<typeof SetTestNumbersSchema>;

type Stats = { replies: number; handedOver: number };

/**
 * AI agent definitions (T033, FR-001–FR-004): list, create, rename, delete (not while published),
 * duplicate with knowledge and secrets, draft saves with a revision check, and the numbers an agent
 * answers on (one agent per number).
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly publishing: AgentPublishService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  async list() {
    const rows = await this.prisma.aiAgent.findMany({ where: { deletedAt: null }, include: AGENT_INCLUDE, orderBy: { name: 'asc' } });
    const stats = await this.lastSevenDays(rows.map((r) => r.id));
    return rows.map((row) => toAgentSummary(row, stats.get(row.id) ?? { replies: 0, handedOver: 0 }));
  }

  /** The agent with its draft and what would block publishing it now. */
  async get(id: string) {
    const row = await this.load(id);
    const stats = await this.lastSevenDays([id]);
    return toAgentDetail(row, await this.publishing.problems(id, parseConfig(row.draft, row.name)), stats.get(id));
  }

  async load(id: string): Promise<AgentRow> {
    const row = await this.prisma.aiAgent.findFirst({ where: { id, deletedAt: null }, include: AGENT_INCLUDE });
    if (!row) throw AppError.notFound('Agent not found');
    return row;
  }

  async create(input: CreateAgentInput, actor: AuditActor) {
    // Starter agents arrive with US8.
    if (input.starterKey) throw AppError.validation('Unknown starter agent', [{ field: 'starterKey', issue: 'is not a starter agent' }]);
    const config = defaultAgentConfig(input.name);
    const row = await this.withName(() =>
      this.prisma.aiAgent.create({ data: { name: input.name, draft: config as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null }, include: AGENT_INCLUDE }),
    );
    await this.audit.record(actor, 'ai.agent_created', { type: 'ai_agent', id: row.id }, { name: row.name });
    return toAgentDetail(row, await this.publishing.problems(row.id, config));
  }

  async rename(id: string, input: RenameAgentInput, actor: AuditActor) {
    await this.load(id);
    const row = await this.withName(() => this.prisma.aiAgent.update({ where: { id }, data: { name: input.name }, include: AGENT_INCLUDE }));
    await this.audit.record(actor, 'ai.agent_updated', { type: 'ai_agent', id }, { name: row.name, changed: ['name'] });
    return this.get(id);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.load(id);
    if (row.status === 'PUBLISHED') throw AppError.conflict('Unpublish the agent before deleting it', 'AGENT_PUBLISHED');
    await this.prisma.$transaction([
      this.prisma.aiAgentNumber.deleteMany({ where: { agentId: id } }),
      this.prisma.aiAgent.update({ where: { id }, data: { deletedAt: new Date(), testNumbers: [] } }),
    ]);
    await this.audit.record(actor, 'ai.agent_deleted', { type: 'ai_agent', id }, { name: row.name });
  }

  /** A new unpublished agent with the draft, knowledge (files copied) and secrets of another. */
  async duplicate(id: string, input: RenameAgentInput, actor: AuditActor) {
    const source = await this.load(id);
    const secrets = await this.prisma.aiAgentSecret.findMany({ where: { agentId: id }, orderBy: { createdAt: 'asc' } });
    const knowledge = await this.prisma.aiKnowledgeSource.findMany({ where: { agentId: id }, orderBy: { createdAt: 'asc' } });

    // Secret ids change, so the draft's {secret:<id>} references are rewritten to the copies.
    const secretIds = new Map(secrets.map((s) => [s.id, uuidv7()]));
    let draftText = JSON.stringify(source.draft);
    for (const [from, to] of secretIds) draftText = draftText.split(`{secret:${from}}`).join(`{secret:${to}}`);

    const copiedFiles: string[] = [];
    const fileKeys = new Map<string, string>();
    for (const item of knowledge) {
      if (!item.storageKey) continue;
      const key = `ai-knowledge/${uuidv7()}${item.storageKey.slice(item.storageKey.lastIndexOf('.'))}`;
      await this.storage.put(key, await this.storage.getBuffer(item.storageKey), item.mimeType ?? undefined);
      copiedFiles.push(key);
      fileKeys.set(item.id, key);
    }

    try {
      const row = await this.withName(() =>
        this.prisma.$transaction(async (tx) => {
          const created = await tx.aiAgent.create({
            data: { name: input.name, draft: JSON.parse(draftText) as Prisma.InputJsonValue, starterKey: source.starterKey, createdById: actor.userId ?? null },
          });
          if (secrets.length) {
            await tx.aiAgentSecret.createMany({
              data: secrets.map((s) => ({ id: secretIds.get(s.id)!, agentId: created.id, name: s.name, valueEncrypted: s.valueEncrypted, createdById: actor.userId ?? null })),
            });
          }
          for (const item of knowledge) {
            const { id: oldId, agentId: _agent, createdAt: _created, updatedAt: _updated, ...fields } = item;
            const copy = await tx.aiKnowledgeSource.create({
              data: { ...fields, agentId: created.id, storageKey: fileKeys.get(oldId) ?? item.storageKey, createdById: actor.userId ?? null },
            });
            await tx.$executeRaw`
              INSERT INTO ai_knowledge_chunks (id, source_id, agent_id, position, title, heading, url, page, text, created_at)
              SELECT gen_random_uuid(), ${copy.id}::uuid, ${created.id}::uuid, position, title, heading, url, page, text, now()
                FROM ai_knowledge_chunks WHERE source_id = ${oldId}::uuid`;
          }
          return tx.aiAgent.findUniqueOrThrow({ where: { id: created.id }, include: AGENT_INCLUDE });
        }),
      );
      await this.audit.record(actor, 'ai.agent_duplicated', { type: 'ai_agent', id: row.id }, { name: row.name, from: id });
      return toAgentDetail(row, await this.publishing.problems(row.id, parseConfig(row.draft, row.name)));
    } catch (error) {
      for (const key of copiedFiles) await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /** Saves the draft when the editor's revision is current (409 DRAFT_CONFLICT otherwise). */
  async saveDraft(id: string, input: SaveAgentDraftInput, actor: AuditActor) {
    const before = await this.prisma.aiAgent.findFirst({ where: { id, deletedAt: null }, select: { name: true, draft: true } });
    if (!before) throw AppError.notFound('Agent not found');
    const config: AgentConfig = input.config;
    const saved = await this.prisma.aiAgent.updateMany({
      where: { id, deletedAt: null, draftRevision: input.draftRevision },
      data: { draft: config as unknown as Prisma.InputJsonValue, draftRevision: { increment: 1 }, draftUpdatedAt: new Date(), draftUpdatedById: actor.userId ?? null },
    });
    if (!saved.count) throw AppError.conflict('Someone saved a newer version of this agent; reload to continue', 'DRAFT_CONFLICT');
    if (JSON.stringify(parseConfig(before.draft).skills) !== JSON.stringify(config.skills)) {
      await this.audit.record(actor, 'ai.skills_changed', { type: 'ai_agent', id }, { name: before.name, api: config.skills.api.length, flows: config.skills.flows.length, media: config.skills.media.length, memory: config.skills.memory.length });
    }
    return { draftRevision: input.draftRevision + 1, problems: await this.publishing.problems(id, config) };
  }

  /**
   * The up to 3 phones that meet this agent's draft instead of its published version (FR-035, T061).
   * Numbers are stored in E.164; national numbers use the company's default country.
   */
  async setTestNumbers(id: string, input: SetTestNumbersInput, actor: AuditActor) {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!agent) throw AppError.notFound('Agent not found');
    const { defaultCountryCode } = await this.settings.get();
    const numbers: string[] = [];
    const problems: Array<{ field: string; issue: string }> = [];
    for (const raw of input.testNumbers) {
      const phone = normalizePhone(raw, defaultCountryCode);
      if (!phone) problems.push({ field: 'testNumbers', issue: `"${raw}" is not a valid phone number` });
      else if (!numbers.includes(phone.e164)) numbers.push(phone.e164);
    }
    if (problems.length) throw AppError.validation('Use full phone numbers, for example +971 50 123 4567', problems);
    await this.prisma.aiAgent.update({ where: { id }, data: { testNumbers: numbers } });
    await this.audit.record(actor, 'ai.test_numbers_updated', { type: 'ai_agent', id }, { count: numbers.length });
    return this.get(id);
  }

  /** The numbers this agent answers on; a number another agent has needs `replace` (FR-004). */
  async setNumbers(id: string, input: SetAgentNumbersInput, actor: AuditActor) {
    const row = await this.load(id);
    const wanted = [...new Set(input.numberIds)];
    if (wanted.length) {
      const found = await this.prisma.whatsAppNumber.count({ where: { id: { in: wanted } } });
      if (found !== wanted.length) throw AppError.validation('Some numbers do not exist', [{ field: 'numberIds', issue: 'contains an unknown number' }]);
    }
    const taken = await this.prisma.aiAgentNumber.findMany({
      where: { numberId: { in: wanted }, agentId: { not: id } },
      include: { agent: { select: { name: true } }, number: { select: { displayPhoneNumber: true } } },
    });
    if (taken.length && !input.replace) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'NUMBER_HAS_AGENT',
        'Some numbers are already answered by another agent',
        taken.map((t) => ({ field: 'numberIds', issue: `${t.number.displayPhoneNumber} is answered by ${t.agent.name}` })),
      );
    }
    await this.prisma.$transaction([
      this.prisma.aiAgentNumber.deleteMany({ where: { OR: [{ agentId: id, numberId: { notIn: wanted } }, { numberId: { in: wanted }, agentId: { not: id } }] } }),
      this.prisma.aiAgentNumber.createMany({ data: wanted.map((numberId) => ({ numberId, agentId: id, assignedById: actor.userId ?? null })), skipDuplicates: true }),
    ]);
    await this.audit.record(actor, 'ai.number_agent_changed', { type: 'ai_agent', id }, { name: row.name, numbers: wanted.length, takenFromOthers: taken.length });
    return this.get(id);
  }

  private async lastSevenDays(ids: string[]): Promise<Map<string, Stats>> {
    const stats = new Map<string, Stats>();
    if (!ids.length) return stats;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [replies, handedOver] = await Promise.all([
      this.prisma.aiReply.groupBy({ by: ['agentId'], where: { agentId: { in: ids }, counted: true, test: false, createdAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.aiConversation.groupBy({ by: ['agentId'], where: { agentId: { in: ids }, test: false, result: 'HANDED_OVER', endedAt: { gte: since } }, _count: { _all: true } }),
    ]);
    for (const id of ids) stats.set(id, { replies: 0, handedOver: 0 });
    for (const r of replies) stats.get(r.agentId)!.replies = r._count._all;
    for (const h of handedOver) stats.get(h.agentId)!.handedOver = h._count._all;
    return stats;
  }

  private async withName<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(HttpStatus.CONFLICT, 'NAME_TAKEN', 'Another agent already has this name');
      throw error;
    }
  }
}
