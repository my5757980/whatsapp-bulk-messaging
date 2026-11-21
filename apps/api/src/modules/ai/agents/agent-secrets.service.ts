import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiSkillSchema, type ApiSkill } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { callApi } from '../../flows/steps/api-client.js';
import { runSkill, skillSecretIds, type SkillContact } from '../claude/skills.js';
import { AgentSecretsVault } from './secrets-vault.js';

export const CreateSecretSchema = z.strictObject({ name: z.string().trim().min(1).max(60), value: z.string().min(1).max(2000) });
export type CreateSecretInput = z.infer<typeof CreateSecretSchema>;
export const UpdateSecretSchema = z.strictObject({ name: z.string().trim().min(1).max(60).optional(), value: z.string().min(1).max(2000).optional() });
export type UpdateSecretInput = z.infer<typeof UpdateSecretSchema>;
export const SkillTestSchema = z.strictObject({
  skill: ApiSkillSchema,
  inputs: z.record(z.string(), z.string().max(200)).default({}),
  contactId: z.uuid().optional(),
});
export type SkillTestInput = z.infer<typeof SkillTestSchema>;

const BODY_PREVIEW_BYTES = 2048;

/**
 * Agent secrets and the skill test request (004 T074, FR-030): values are stored encrypted, returned
 * by name only and audited without values; a secret that the draft or any version uses cannot be
 * deleted (409 SECRET_IN_USE). The test request runs one skill call with the same client and
 * safety rules as at run time.
 */
@Injectable()
export class AgentSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly vault: AgentSecretsVault,
  ) {}

  async create(agentId: string, input: CreateSecretInput, actor: AuditActor) {
    await this.agentOrThrow(agentId);
    const row = await this.prisma.aiAgentSecret.create({
      data: { agentId, name: input.name, valueEncrypted: this.vault.encrypt(input.value), createdById: actor.userId ?? null, updatedById: actor.userId ?? null },
      select: { id: true, name: true, updatedAt: true },
    });
    await this.audit.record(actor, 'ai.secret_changed', { type: 'ai_agent', id: agentId }, { change: 'created', secretId: row.id, name: row.name });
    return { id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() };
  }

  async update(agentId: string, secretId: string, input: UpdateSecretInput, actor: AuditActor) {
    await this.secretOrThrow(agentId, secretId);
    const row = await this.prisma.aiAgentSecret.update({
      where: { id: secretId },
      data: { ...(input.name ? { name: input.name } : {}), ...(input.value ? { valueEncrypted: this.vault.encrypt(input.value) } : {}), updatedById: actor.userId ?? null },
      select: { id: true, name: true, updatedAt: true },
    });
    await this.audit.record(actor, 'ai.secret_changed', { type: 'ai_agent', id: agentId }, { change: 'updated', secretId, name: row.name, renamed: Boolean(input.name), valueReplaced: Boolean(input.value) });
    return { id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() };
  }

  async remove(agentId: string, secretId: string, actor: AuditActor): Promise<void> {
    const secret = await this.secretOrThrow(agentId, secretId);
    const agent = await this.prisma.aiAgent.findUniqueOrThrow({ where: { id: agentId }, select: { draft: true, versions: { select: { config: true } } } });
    const marker = `{secret:${secretId}}`;
    const used = [agent.draft, ...agent.versions.map((v) => v.config)].some((config) => JSON.stringify(config ?? {}).includes(marker));
    if (used) throw new AppError(HttpStatus.CONFLICT, 'SECRET_IN_USE', 'An API skill of the draft or a published version uses this secret. Remove it from the skills first.');
    await this.prisma.aiAgentSecret.delete({ where: { id: secretId } });
    await this.audit.record(actor, 'ai.secret_changed', { type: 'ai_agent', id: agentId }, { change: 'deleted', secretId, name: secret.name });
  }

  /** Runs a skill once with sample inputs; failures come back as `ok: false` with the reason. */
  async test(agentId: string, input: SkillTestInput) {
    await this.agentOrThrow(agentId);
    const skill: ApiSkill = input.skill;
    const secrets = await this.vault.values(agentId, skillSecretIds(skill));
    let contact: SkillContact = { name: null, phoneE164: null, attributes: {} };
    if (input.contactId) {
      const row = await this.prisma.contact.findUnique({ where: { id: input.contactId }, select: { name: true, phoneE164: true, attributes: true } });
      if (!row) throw AppError.notFound('Contact not found');
      contact = { name: row.name, phoneE164: row.phoneE164, attributes: (row.attributes ?? {}) as Record<string, unknown> };
    }
    const started = Date.now();
    let status: number | null = null;
    let body: unknown = null;
    const result = await runSkill(skill, input.inputs, {
      contact,
      secrets,
      call: async (request) => {
        const response = await callApi(request);
        status = response.status;
        body = response.body ?? (response.text ? [...response.text].slice(0, BODY_PREVIEW_BYTES).join('') : null);
        return response;
      },
    });
    return {
      ok: result.ok,
      status,
      durationMs: Date.now() - started,
      body,
      mapped: result.ok ? result.fields : {},
      error: result.ok ? null : result.reason.toUpperCase(),
    };
  }

  private async agentOrThrow(agentId: string): Promise<void> {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
    if (!agent) throw AppError.notFound('Agent not found');
  }

  private async secretOrThrow(agentId: string, secretId: string) {
    await this.agentOrThrow(agentId);
    const secret = await this.prisma.aiAgentSecret.findFirst({ where: { id: secretId, agentId }, select: { id: true, name: true } });
    if (!secret) throw AppError.notFound('Secret not found');
    return secret;
  }
}
