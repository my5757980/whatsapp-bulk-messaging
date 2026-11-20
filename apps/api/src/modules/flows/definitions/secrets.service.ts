import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { parseGraph } from './flow-views.js';
import { FlowsService } from './flows.service.js';
import { FlowSecretsVault } from './secrets-vault.js';

export const CreateSecretSchema = z.strictObject({ name: z.string().trim().min(1).max(60), value: z.string().min(1).max(2000) });
export type CreateSecretInput = z.infer<typeof CreateSecretSchema>;
export const UpdateSecretSchema = z.strictObject({ name: z.string().trim().min(1).max(60).optional(), value: z.string().min(1).max(2000).optional() });
export type UpdateSecretInput = z.infer<typeof UpdateSecretSchema>;

const toDto = (row: { id: string; name: string; updatedAt: Date }) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() });

/**
 * Secret header values for API steps (003 T059, FR-015): stored encrypted, never returned (names
 * only), never in the graph (steps refer to {secret:<id>}), and audited without their values.
 */
@Injectable()
export class FlowSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly vault: FlowSecretsVault,
    private readonly audit: AuditService,
  ) {}

  async create(flowId: string, input: CreateSecretInput, actor: AuditActor) {
    await this.flows.load(flowId);
    const row = await this.prisma.flowSecret.create({
      data: { flowId, name: input.name, valueEncrypted: this.vault.encrypt(input.value), createdById: actor.userId ?? null, updatedById: actor.userId ?? null },
    });
    await this.audit.record(actor, 'flow.secret_changed', { type: 'flow', id: flowId }, { secretId: row.id, name: row.name, change: 'created' });
    return toDto(row);
  }

  async update(flowId: string, secretId: string, input: UpdateSecretInput, actor: AuditActor) {
    await this.load(flowId, secretId);
    const row = await this.prisma.flowSecret.update({
      where: { id: secretId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.value !== undefined ? { valueEncrypted: this.vault.encrypt(input.value) } : {}),
        updatedById: actor.userId ?? null,
      },
    });
    const change = [input.name !== undefined ? 'renamed' : null, input.value !== undefined ? 'value_replaced' : null].filter(Boolean).join(',') || 'unchanged';
    await this.audit.record(actor, 'flow.secret_changed', { type: 'flow', id: flowId }, { secretId, name: row.name, change });
    return toDto(row);
  }

  /** Deletes a secret that neither the draft nor the published version uses (409 SECRET_IN_USE). */
  async remove(flowId: string, secretId: string, actor: AuditActor): Promise<void> {
    const secret = await this.load(flowId, secretId);
    const flow = await this.flows.load(flowId);
    const reference = `{secret:${secretId}}`;
    const graphs = [parseGraph(flow.draft), ...(flow.publishedVersion ? [parseGraph(flow.publishedVersion.graph)] : [])];
    const used = graphs.some((graph) => graph.steps.some((step) => step.type === 'api' && step.headers.some((h) => h.value.includes(reference))));
    if (used) throw new AppError(HttpStatus.CONFLICT, 'SECRET_IN_USE', 'An API step of the draft or the published version still uses this secret');
    await this.prisma.flowSecret.delete({ where: { id: secretId } });
    await this.audit.record(actor, 'flow.secret_changed', { type: 'flow', id: flowId }, { secretId, name: secret.name, change: 'deleted' });
  }

  private async load(flowId: string, secretId: string) {
    const secret = await this.prisma.flowSecret.findFirst({ where: { id: secretId, flowId, flow: { deletedAt: null } }, select: { id: true, name: true } });
    if (!secret) throw AppError.notFound('Secret not found');
    return secret;
  }
}
