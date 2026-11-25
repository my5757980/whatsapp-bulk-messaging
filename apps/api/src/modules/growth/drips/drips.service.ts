import { Injectable } from '@nestjs/common';
import {
  MAX_ACTIVE_DRIPS,
  MAX_DRIP_STEPS,
  MAX_TRACKED_LINKS,
  extractTemplateVariables,
  positionAfterEdit,
  quietHoursProblem,
  stepWaitProblem,
  type MetaTemplateComponent,
} from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { VariableMappingSchema, unmappedVariables, type VariableMapping } from '../../campaigns/variable-resolver.js';
import { headerMediaType } from '../../sending/template-payload.builder.js';
import { TrackedLinksService } from '../links/tracked-links.service.js';
import { DripLeaving } from './drip-leaving.js';
import { DRIP_INCLUDE, toDetailDto, toSummaryDto, type DripDetailDto, type DripProblem, type DripRow, type DripSummaryDto, type EnrolmentCounts } from './drip-views.js';

// Drip campaigns: building, settings, steps and their lifecycle (feature 005 US4, FR-019 - FR-023,
// FR-032, FR-037, FR-038; data-model.md §3).

const HHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'use HH:MM');

export const CreateDripSchema = z.object({ name: z.string().trim().min(1).max(80), numberId: z.uuid() }).strict();
export type CreateDripInput = z.infer<typeof CreateDripSchema>;

const TriggerSchema = z
  .object({
    kind: z.enum(['TAG_ADDED', 'OPTED_IN', 'IMPORTED', 'API_CREATED', 'LINK_CLICKED', 'ORDER_PLACED', 'ORDER_DELIVERED']),
    tagId: z.uuid().nullish(),
    campaignId: z.uuid().nullish(),
  })
  .strict()
  .refine((t) => t.kind !== 'TAG_ADDED' || Boolean(t.tagId), { message: 'choose the tag', path: ['tagId'] });

export const DripSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    quietHours: z.object({ from: HHMM, to: HHMM, days: z.array(z.number().int().min(1).max(7)).min(1).max(7) }).strict().nullable(),
    leaveOnReply: z.boolean(),
    leaveOnClick: z.boolean(),
    stopTagIds: z.array(z.uuid()).max(20),
    allowRejoin: z.boolean(),
    triggers: z.array(TriggerSchema).max(10),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one setting' });
export type DripSettingsInput = z.infer<typeof DripSettingsSchema>;

const StepInputSchema = z
  .object({
    id: z.uuid().nullish(),
    templateId: z.uuid(),
    variableMapping: VariableMappingSchema,
    headerMediaAssetId: z.uuid().nullish(),
    waitMinutes: z.number().int().min(0).max(43_200),
    trackedLinks: z
      .array(z.object({ variableKey: z.string().trim().min(1).max(20), destination: z.string().trim().min(1).max(2000), addCampaignTags: z.boolean().default(false) }).strict())
      .max(MAX_TRACKED_LINKS)
      .default([]),
  })
  .strict();
export const DripStepsSchema = z.object({ steps: z.array(StepInputSchema).min(1).max(MAX_DRIP_STEPS) }).strict();
export type DripStepsInput = z.infer<typeof DripStepsSchema>;

const ARCHIVED = () => AppError.conflict('This drip is archived', 'DRIP_ARCHIVED');

@Injectable()
export class DripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly trackedLinks: TrackedLinksService,
    private readonly leaving: DripLeaving,
  ) {}

  async list(status?: DripRow['status']): Promise<DripSummaryDto[]> {
    const drips = await this.prisma.drip.findMany({
      where: status ? { status } : {},
      include: { number: { select: { id: true, label: true } }, _count: { select: { steps: { where: { deletedAt: null } } } } },
      orderBy: { name: 'asc' },
    });
    const counts = await this.counts(drips.map((d) => d.id));
    return drips.map((d) => toSummaryDto(d, d._count.steps, counts.get(d.id) ?? { active: 0, finished: 0, left: 0 }));
  }

  async get(id: string): Promise<DripDetailDto> {
    const drip = await this.load(id);
    return toDetailDto(drip, (await this.counts([id])).get(id) ?? { active: 0, finished: 0, left: 0 }, this.problems(drip));
  }

  async create(input: CreateDripInput, actor: AuditActor): Promise<DripDetailDto> {
    if (!(await this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { id: true } }))) {
      throw AppError.validation('Choose a WhatsApp number', [{ field: 'numberId', issue: 'does not exist' }]);
    }
    const drip = await this.unique(() => this.prisma.drip.create({ data: { name: input.name, numberId: input.numberId, createdById: actor.userId ?? null } }));
    await this.audit.record(actor, 'drip.created', { type: 'drip', id: drip.id }, { name: input.name });
    return this.get(drip.id);
  }

  /** Name, quiet hours, leaving rules, starting events and joining again (FR-021, FR-024, FR-026, FR-028). */
  async update(id: string, input: DripSettingsInput, actor: AuditActor): Promise<DripDetailDto> {
    const drip = await this.prisma.drip.findUnique({ where: { id }, select: { status: true } });
    if (!drip) throw AppError.notFound('Drip not found');
    if (drip.status === 'ARCHIVED') throw ARCHIVED();
    if (input.quietHours && quietHoursProblem(input.quietHours)) {
      throw AppError.validation('Quiet hours need two different times and at least one day', [{ field: 'quietHours', issue: 'is not valid' }]);
    }
    if (input.stopTagIds?.length) await this.assertTags(input.stopTagIds, 'stopTagIds');
    if (input.triggers) {
      const tagIds = input.triggers.flatMap((t) => (t.kind === 'TAG_ADDED' && t.tagId ? [t.tagId] : []));
      if (tagIds.length) await this.assertTags(tagIds, 'triggers');
      const campaignIds = input.triggers.flatMap((t) => (t.kind === 'LINK_CLICKED' && t.campaignId ? [t.campaignId] : []));
      if (campaignIds.length && (await this.prisma.campaign.count({ where: { id: { in: campaignIds } } })) !== new Set(campaignIds).size) {
        throw AppError.validation('A chosen campaign does not exist', [{ field: 'triggers', issue: 'unknown campaign' }]);
      }
    }
    await this.unique(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.drip.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.quietHours !== undefined
              ? input.quietHours
                ? { quietFrom: input.quietHours.from, quietTo: input.quietHours.to, quietDays: input.quietHours.days }
                : { quietFrom: null, quietTo: null }
              : {}),
            ...(input.leaveOnReply !== undefined ? { leaveOnReply: input.leaveOnReply } : {}),
            ...(input.leaveOnClick !== undefined ? { leaveOnClick: input.leaveOnClick } : {}),
            ...(input.stopTagIds !== undefined ? { stopTagIds: [...new Set(input.stopTagIds)] } : {}),
            ...(input.allowRejoin !== undefined ? { allowRejoin: input.allowRejoin } : {}),
          },
        });
        if (input.triggers) {
          await tx.dripTrigger.deleteMany({ where: { dripId: id } });
          if (input.triggers.length) {
            await tx.dripTrigger.createMany({
              data: input.triggers.map((t) => ({
                dripId: id,
                kind: t.kind,
                tagId: t.kind === 'TAG_ADDED' ? (t.tagId ?? null) : null,
                campaignId: t.kind === 'LINK_CLICKED' ? (t.campaignId ?? null) : null,
              })),
            });
          }
        }
      }),
    );
    await this.audit.record(actor, 'drip.updated', { type: 'drip', id }, { changed: Object.keys(input) });
    return this.get(id);
  }

  /**
   * Replaces the steps (FR-019, FR-020, FR-023). Existing steps keep their ids; removed ones are soft
   * deleted so results keep their history. Contacts move on after the last step they received that is
   * still live, so edits reach only steps they have not reached and nothing is sent twice.
   */
  async replaceSteps(id: string, input: DripStepsInput, actor: AuditActor): Promise<DripDetailDto> {
    const drip = await this.load(id);
    if (drip.status === 'ARCHIVED') throw ARCHIVED();
    const liveIds = new Set(drip.steps.map((s) => s.id));
    const templates = new Map(
      (await this.prisma.template.findMany({ where: { id: { in: input.steps.map((s) => s.templateId) } }, select: { id: true, wabaId: true, components: true } })).map((t) => [
        t.id,
        t,
      ]),
    );
    input.steps.forEach((step, i) => {
      if (stepWaitProblem(i + 1, step.waitMinutes)) {
        throw AppError.validation(i === 0 ? 'The first wait is right away or 10 minutes to 30 days' : 'Each wait is 10 minutes to 30 days', [
          { field: `steps.${i}.waitMinutes`, issue: 'is out of range' },
        ]);
      }
      const template = templates.get(step.templateId);
      if (!template || template.wabaId !== drip.number.wabaId) {
        throw AppError.validation("Choose a template of the drip number's account", [{ field: `steps.${i}.templateId`, issue: 'is not available for this number' }]);
      }
      if (step.id && !liveIds.has(step.id)) throw AppError.validation('A step does not belong to this drip', [{ field: `steps.${i}.id`, issue: 'unknown step' }]);
      const trackable = new Map(this.trackedLinks.trackable(template.components as unknown as MetaTemplateComponent[]).map((v) => [v.variableKey, v]));
      for (const link of step.trackedLinks) {
        const variable = trackable.get(link.variableKey);
        if (!variable?.trackable) {
          throw AppError.validation(variable?.reason ?? `The template has no variable ${link.variableKey}`, [{ field: `steps.${i}.trackedLinks`, issue: 'cannot carry a tracked link' }], 'LINK_NOT_TRACKABLE');
        }
        this.trackedLinks.assertDestination(link.destination, `steps.${i}.trackedLinks.${link.variableKey}`);
      }
    });
    if (new Set(input.steps.flatMap((s) => (s.id ? [s.id] : []))).size !== input.steps.filter((s) => s.id).length) {
      throw AppError.validation('A step appears twice', [{ field: 'steps', issue: 'repeats a step' }]);
    }

    await this.prisma.$transaction(
      async (tx) => {
        const oldOrder = drip.steps.map((s) => s.id);
        // Park live positions out of the way of the unique index while they are renumbered.
        await tx.$executeRaw`UPDATE drip_steps SET position = position + 100 WHERE drip_id = ${id}::uuid AND deleted_at IS NULL`;
        const newOrder: string[] = [];
        for (const [i, step] of input.steps.entries()) {
          const data = {
            position: i + 1,
            templateId: step.templateId,
            variableMapping: step.variableMapping as Prisma.InputJsonValue,
            headerMediaAssetId: step.headerMediaAssetId ?? null,
            waitMinutes: step.waitMinutes,
          };
          const saved = step.id ? await tx.dripStep.update({ where: { id: step.id }, data }) : await tx.dripStep.create({ data: { ...data, dripId: id } });
          newOrder.push(saved.id);
          await this.saveTargets(tx, saved.id, step.trackedLinks);
        }
        // Removed steps keep their history and their old position (the unique index skips deleted steps).
        for (const removed of drip.steps.filter((s) => !newOrder.includes(s.id))) {
          await tx.dripStep.update({ where: { id: removed.id }, data: { deletedAt: new Date(), position: removed.position } });
        }
        await this.remapEnrolments(tx, id, oldOrder, newOrder, input.steps.map((s) => s.waitMinutes));
      },
      { timeout: 120_000 },
    );
    await this.audit.record(actor, 'drip.updated', { type: 'drip', id }, { steps: input.steps.length });
    return this.get(id);
  }

  /** Activates a draft or resumes a paused drip after its checks (FR-022). */
  async activate(id: string, actor: AuditActor): Promise<DripDetailDto> {
    const drip = await this.load(id);
    if (drip.status === 'ARCHIVED') throw ARCHIVED();
    if (drip.status === 'ACTIVE') return this.get(id);
    const problems = this.problems(drip);
    if (problems.length) {
      throw new AppError(422, 'ACTIVATION_BLOCKED', 'Fix these problems before activating the drip', undefined, { problems });
    }
    if ((await this.prisma.drip.count({ where: { status: 'ACTIVE' } })) >= MAX_ACTIVE_DRIPS) {
      throw AppError.conflict(`At most ${MAX_ACTIVE_DRIPS} drips can be active at a time`, 'TOO_MANY_ACTIVE_DRIPS');
    }
    const { count } = await this.prisma.drip.updateMany({
      where: { id, status: drip.status },
      data: { status: 'ACTIVE', pausedReason: null, pausedAt: null, ...(drip.activatedAt ? {} : { activatedAt: new Date() }) },
    });
    if (!count) throw AppError.conflict('The drip changed meanwhile; try again');
    await this.audit.record(actor, drip.status === 'PAUSED' ? 'drip.resumed' : 'drip.activated', { type: 'drip', id }, { previousReason: drip.pausedReason });
    return this.get(id);
  }

  async pause(id: string, actor: AuditActor): Promise<DripDetailDto> {
    await this.assertExists(id);
    const { count } = await this.prisma.drip.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedReason: null, pausedAt: new Date() } });
    if (!count) throw AppError.conflict('Only an active drip can be paused', 'NOT_ACTIVE');
    await this.audit.record(actor, 'drip.paused', { type: 'drip', id });
    return this.get(id);
  }

  /** Archives a drip; contacts in it leave with ARCHIVED. */
  async archive(id: string, actor: AuditActor): Promise<DripDetailDto> {
    await this.assertExists(id);
    const ended = await this.prisma.$transaction(async (tx) => {
      await tx.drip.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      return this.leaving.archiveAll(id, tx);
    });
    await this.audit.record(actor, 'drip.archived', { type: 'drip', id }, { contactsLeft: ended });
    return this.get(id);
  }

  /** Deletes a draft that never had contacts; others are archived instead. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const drip = await this.prisma.drip.findUnique({ where: { id }, select: { status: true, name: true, _count: { select: { enrolments: true } } } });
    if (!drip) throw AppError.notFound('Drip not found');
    if (drip.status !== 'DRAFT' || drip._count.enrolments > 0) throw AppError.conflict('This drip has been used; archive it instead', 'DRIP_IN_USE');
    await this.prisma.drip.delete({ where: { id } });
    await this.audit.record(actor, 'drip.deleted', { type: 'drip', id }, { name: drip.name });
  }

  /** What blocks activating the drip (FR-022). A drip without starting events serves contacts enrolled by hand. */
  problems(drip: DripRow): DripProblem[] {
    const problems: DripProblem[] = [];
    if (!drip.steps.length) problems.push({ code: 'NO_STEPS', message: 'Add at least one step', stepPosition: null });
    if (drip.number.connectionStatus !== 'CONNECTED' || !drip.number.sendingEnabled) {
      problems.push({ code: 'NUMBER_NOT_CONNECTED', message: 'The WhatsApp number is not connected or sending is turned off', stepPosition: null });
    }
    for (const step of drip.steps) {
      const position = step.position;
      if (step.template.wabaId !== drip.number.wabaId) {
        problems.push({ code: 'WRONG_ACCOUNT', message: "The template belongs to another account than the drip's number", stepPosition: position });
      }
      if (step.template.status !== 'APPROVED') {
        problems.push({ code: 'TEMPLATE_NOT_APPROVED', message: `Template "${step.template.name}" is not approved by Meta`, stepPosition: position });
      }
      const components = step.template.components as unknown as MetaTemplateComponent[];
      const trackedKeys = new Set(step.trackedLinkTargets.map((t) => t.variableKey));
      const variables = extractTemplateVariables(components).filter((v) => !trackedKeys.has(v.key));
      const unmapped = unmappedVariables(variables, (step.variableMapping ?? {}) as VariableMapping);
      const untracked = this.trackedLinks.buttonsWithoutDestination(components, trackedKeys);
      if (unmapped.length || untracked.length) {
        problems.push({ code: 'VARIABLES_NOT_MAPPED', message: `Fill in ${[...unmapped, ...untracked].join(', ')}`, stepPosition: position });
      }
      if (headerMediaType(components) && !step.headerMediaAssetId) {
        problems.push({ code: 'HEADER_MEDIA_MISSING', message: 'This template needs header media', stepPosition: position });
      }
    }
    return problems;
  }

  async load(id: string): Promise<DripRow> {
    const drip = await this.prisma.drip.findUnique({ where: { id }, include: DRIP_INCLUDE });
    if (!drip) throw AppError.notFound('Drip not found');
    return drip;
  }

  private async assertExists(id: string): Promise<void> {
    if (!(await this.prisma.drip.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound('Drip not found');
  }

  private async assertTags(tagIds: string[], field: string): Promise<void> {
    const unique = [...new Set(tagIds)];
    if ((await this.prisma.tag.count({ where: { id: { in: unique } } })) !== unique.length) {
      throw AppError.validation('A chosen tag does not exist', [{ field, issue: 'unknown tag' }]);
    }
  }

  private async counts(ids: string[]): Promise<Map<string, EnrolmentCounts>> {
    const map = new Map<string, EnrolmentCounts>();
    if (!ids.length) return map;
    const rows = await this.prisma.dripEnrolment.groupBy({ by: ['dripId', 'status'], where: { dripId: { in: ids } }, _count: { _all: true } });
    for (const row of rows) {
      const counts = map.get(row.dripId) ?? { active: 0, finished: 0, left: 0 };
      if (row.status === 'ACTIVE') counts.active = row._count._all;
      else if (row.status === 'FINISHED') counts.finished = row._count._all;
      else counts.left = row._count._all;
      map.set(row.dripId, counts);
    }
    return map;
  }

  /** Tracked links of a step, by variable; targets that already have links are kept for their history. */
  private async saveTargets(tx: Prisma.TransactionClient, stepId: string, links: DripStepsInput['steps'][number]['trackedLinks']): Promise<void> {
    const existing = await tx.trackedLinkTarget.findMany({ where: { dripStepId: stepId }, include: { _count: { select: { links: true } } } });
    for (const link of links) {
      const current = existing.find((t) => t.variableKey === link.variableKey);
      if (current) {
        await tx.trackedLinkTarget.update({ where: { id: current.id }, data: { destination: link.destination, addCampaignTags: link.addCampaignTags } });
      } else {
        await tx.trackedLinkTarget.create({ data: { dripStepId: stepId, variableKey: link.variableKey, destination: link.destination, addCampaignTags: link.addCampaignTags } });
      }
    }
    const kept = new Set(links.map((l) => l.variableKey));
    const unused = existing.filter((t) => !kept.has(t.variableKey) && t._count.links === 0).map((t) => t.id);
    if (unused.length) await tx.trackedLinkTarget.deleteMany({ where: { id: { in: unused } } });
  }

  /**
   * After an edit, each active contact waits for the step after the last step they received that is
   * still live, its wait counted from their last step (or from joining). Past the last step they finish
   * at the next tick.
   */
  private async remapEnrolments(tx: Prisma.TransactionClient, dripId: string, oldOrder: string[], newOrder: string[], waits: number[]): Promise<void> {
    const rows = Array.from({ length: oldOrder.length + 1 }, (_, i) => {
      const next = positionAfterEdit(oldOrder, newOrder, i + 1);
      return Prisma.sql`(${i + 1}::int, ${next}::int, ${next <= newOrder.length ? (waits[next - 1] ?? 0) : -1}::int)`;
    });
    await tx.$executeRaw`
      UPDATE drip_enrolments e
         SET current_position = v.new_position,
             next_due_at = CASE WHEN v.wait < 0 THEN now()
                                ELSE COALESCE((SELECT max(s.created_at) FROM drip_step_sends s WHERE s.enrolment_id = e.id), e.joined_at) + make_interval(mins => v.wait) END
        FROM (VALUES ${Prisma.join(rows)}) AS v(old_position, new_position, wait)
       WHERE e.drip_id = ${dripId}::uuid AND e.status = 'ACTIVE' AND e.current_position = v.old_position`;
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A drip with this name already exists', 'NAME_TAKEN');
      throw error;
    }
  }
}
