import { Injectable } from '@nestjs/common';
import { OBA_CHECKLIST_CHECKED_AT, OBA_CHECKLIST_STEPS, OBA_STEP_IDS } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

// Feature 010 (US7, research R12, FR-033): the blue tick checklist - the shared steps plus the progress the
// company records. Meta decides; the platform only guides and records.

export const ObaChecklistInputSchema = z
  .object({
    steps: z.record(z.string(), z.boolean()).optional(),
    appliedAt: z.iso.date().nullish(),
    result: z.enum(['PENDING', 'APPROVED', 'DECLINED']).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type ObaChecklistInput = z.infer<typeof ObaChecklistInputSchema>;

type Progress = Record<string, { done: boolean; at: string | null }>;

@Injectable()
export class ObaChecklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async row() {
    return this.prisma.obaChecklist.upsert({ where: { id: 1 }, create: { id: 1, steps: {} }, update: {} });
  }

  private toDto(row: Awaited<ReturnType<ObaChecklistService['row']>>) {
    const progress = (row.steps ?? {}) as Progress;
    return {
      steps: OBA_CHECKLIST_STEPS.map((s) => ({ ...s, links: [...s.links], done: progress[s.id]?.done ?? false, at: progress[s.id]?.at ?? null })),
      appliedAt: row.appliedAt ? row.appliedAt.toISOString().slice(0, 10) : null,
      result: row.result,
      note: row.note,
      checkedAt: OBA_CHECKLIST_CHECKED_AT,
    };
  }

  async get() {
    return this.toDto(await this.row());
  }

  async update(input: ObaChecklistInput, actor: AuditActor) {
    const unknown = Object.keys(input.steps ?? {}).filter((id) => !OBA_STEP_IDS.includes(id));
    if (unknown.length) throw AppError.validation('Unknown checklist steps', unknown.map((id) => ({ field: `steps.${id}`, issue: 'is not a checklist step' })));
    const current = await this.row();
    const progress = { ...((current.steps ?? {}) as Progress) };
    const now = new Date().toISOString();
    const changedSteps: string[] = [];
    for (const [id, done] of Object.entries(input.steps ?? {})) {
      if ((progress[id]?.done ?? false) === done) continue;
      progress[id] = { done, at: done ? now : null };
      changedSteps.push(id);
    }
    const row = await this.prisma.obaChecklist.update({
      where: { id: 1 },
      data: {
        steps: progress as Prisma.InputJsonValue,
        ...(input.appliedAt !== undefined ? { appliedAt: input.appliedAt ? new Date(`${input.appliedAt}T00:00:00.000Z`) : null } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        updatedById: actor.userId ?? null,
      },
    });
    await this.audit.record(actor, 'oba_checklist.changed', { type: 'oba_checklist', id: '1' }, {
      steps: changedSteps,
      ...(input.appliedAt !== undefined ? { applied: Boolean(input.appliedAt) } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
    });
    return this.toDto(row);
  }
}
