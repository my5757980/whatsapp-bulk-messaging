import { HttpStatus, Injectable } from '@nestjs/common';
import { jumpsWithoutWait, normalizePhrase, reachableSteps, validateForPublish, type FlowGraph, type Problem } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { validateAttributeValue, type AttributeType } from '../../contacts/attribute-validator.js';
import { FLOW_INCLUDE, parseGraph, toFlowDetail, type FlowRow } from './flow-views.js';
import { FlowsService } from './flows.service.js';
import { ReservedKeywords } from './reserved-keywords.js';

/** One `flow_triggers` row per trigger phrase of a published graph (research R2). */
export function triggerRows(flowId: string, flowVersionId: string, graph: FlowGraph): Prisma.FlowTriggerCreateManyInput[] {
  return graph.triggers.flatMap((t): Prisma.FlowTriggerCreateManyInput[] => {
    const common = { flowId, flowVersionId, triggerKey: t.id };
    switch (t.kind) {
      case 'KEYWORD':
        return t.phrases
          .map(normalizePhrase)
          .filter(Boolean)
          .map((phrase) => ({ ...common, kind: 'KEYWORD', match: t.match, phrase, canInterrupt: t.canInterrupt }));
      case 'FIRST_MESSAGE':
        return t.phrases
          .map(normalizePhrase)
          .filter(Boolean)
          .map((phrase) => ({ ...common, kind: 'FIRST_MESSAGE', match: t.match, phrase, firstMessageTagId: t.tagId, startFlow: t.startFlow }));
      case 'PATTERN':
        return [{ ...common, kind: 'PATTERN', pattern: t.pattern, answerName: t.answerName ?? null, canInterrupt: t.canInterrupt }];
      case 'TEMPLATE_BUTTON':
        return [{ ...common, kind: 'TEMPLATE_BUTTON', templateId: t.templateId, buttonText: t.buttonText.trim(), canInterrupt: t.canInterrupt }];
    }
  });
}

/**
 * Publishing (003 T023, FR-002–FR-004): the shared checks plus those needing the database, then a
 * new numbered version and its trigger rows in one transaction. Unpublishing removes the triggers;
 * running sessions end at their next step (session service).
 */
@Injectable()
export class PublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    private readonly audit: AuditService,
    private readonly reserved: ReservedKeywords,
  ) {}

  async publish(id: string, actor: AuditActor) {
    const row = await this.flows.load(id);
    const graph = parseGraph(row.draft);
    const problems = [...validateForPublish(graph, { reservedKeywords: await this.reserved.list() }), ...(await this.databaseProblems(row, graph))];
    if (problems.length) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'PUBLISH_BLOCKED', 'Fix the listed problems before publishing', undefined, { problems });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`flow-publish:${id}`}::text))`;
      const last = await tx.flowVersion.aggregate({ where: { flowId: id, kind: 'PUBLISHED' }, _max: { number: true } });
      const version = await tx.flowVersion.create({
        data: { flowId: id, kind: 'PUBLISHED', number: (last._max.number ?? 0) + 1, graph: graph as Prisma.InputJsonValue, createdById: actor.userId ?? null },
      });
      await tx.flowTrigger.deleteMany({ where: { flowId: id } });
      const rows = triggerRows(id, version.id, graph);
      if (rows.length) await tx.flowTrigger.createMany({ data: rows });
      return tx.flow.update({ where: { id }, data: { status: 'PUBLISHED', publishedVersionId: version.id }, include: FLOW_INCLUDE });
    });
    await this.audit.record(actor, 'flow.published', { type: 'flow', id }, { name: updated.name, version: updated.publishedVersion?.number ?? null });
    return toFlowDetail(updated);
  }

  async unpublish(id: string, actor: AuditActor) {
    const row = await this.flows.load(id);
    if (row.status !== 'PUBLISHED') return toFlowDetail(row);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.flowTrigger.deleteMany({ where: { flowId: id } });
      return tx.flow.update({ where: { id }, data: { status: 'UNPUBLISHED', publishedVersionId: null }, include: FLOW_INCLUDE });
    });
    await this.audit.record(actor, 'flow.unpublished', { type: 'flow', id }, { name: updated.name });
    return toFlowDetail(updated);
  }

  /** Checks that need other flows (later stories add attributes, templates, jumps and loops). */
  private async databaseProblems(row: FlowRow, graph: FlowGraph): Promise<Problem[]> {
    const problems: Problem[] = [];
    const myNumbers = new Set(row.numbers.map((n) => n.numberId));
    for (const trigger of graph.triggers) {
      if (trigger.kind !== 'KEYWORD' || trigger.match !== 'EXACT') continue;
      const phrases = [...new Set(trigger.phrases.map(normalizePhrase).filter(Boolean))];
      if (!phrases.length) continue;
      const clashes = await this.prisma.flowTrigger.findMany({
        where: { kind: 'KEYWORD', match: 'EXACT', phrase: { in: phrases }, flowId: { not: row.id }, flow: { status: 'PUBLISHED', deletedAt: null } },
        select: { phrase: true, flow: { select: { name: true, allNumbers: true, numbers: { select: { numberId: true } } } } },
      });
      for (const clash of clashes) {
        const overlaps = row.allNumbers || clash.flow.allNumbers || clash.flow.numbers.some((n) => myNumbers.has(n.numberId));
        if (!overlaps) continue;
        problems.push({
          code: 'KEYWORD_TAKEN',
          message: `The keyword "${clash.phrase}" already starts the published flow "${clash.flow.name}" on the same number`,
          stepId: null,
          triggerId: trigger.id,
          field: 'phrases',
        });
      }
    }
    problems.push(...(await this.attributeProblems(graph)));
    problems.push(...(await this.jumpProblems(row, graph)));
    problems.push(...(await this.templateProblems(graph)));
    return problems;
  }

  /** Template-button triggers need the template and one of its quick-reply buttons (FR-019, T065). */
  private async templateProblems(graph: FlowGraph): Promise<Problem[]> {
    const triggers = graph.triggers.flatMap((t) => (t.kind === 'TEMPLATE_BUTTON' && t.templateId && t.buttonText.trim() ? [{ id: t.id, templateId: t.templateId, buttonText: t.buttonText.trim() }] : []));
    if (!triggers.length) return [];
    const templates = await this.prisma.template.findMany({ where: { id: { in: [...new Set(triggers.map((t) => t.templateId))] } }, select: { id: true, name: true, status: true, components: true } });
    const byId = new Map(templates.map((t) => [t.id, t]));
    return triggers.flatMap((trigger): Problem[] => {
      const template = byId.get(trigger.templateId);
      if (!template || template.status === 'DELETED') {
        return [{ code: 'MISSING_CONTENT', message: 'The template no longer exists', stepId: null, triggerId: trigger.id, field: 'templateId' }];
      }
      const components = (Array.isArray(template.components) ? template.components : []) as Array<{ type?: string; buttons?: Array<{ type?: string; text?: string }> }>;
      const quickReplies = components
        .filter((c) => (c.type ?? '').toUpperCase() === 'BUTTONS')
        .flatMap((c) => c.buttons ?? [])
        .filter((b) => (b.type ?? '').toUpperCase() === 'QUICK_REPLY')
        .map((b) => normalizePhrase(b.text ?? ''));
      if (quickReplies.includes(normalizePhrase(trigger.buttonText))) return [];
      return [{ code: 'MISSING_CONTENT', message: `The template "${template.name}" has no quick-reply button "${trigger.buttonText}"`, stepId: null, triggerId: trigger.id, field: 'buttonText' }];
    });
  }

  /**
   * Answers saved to contact attributes, and attribute steps, need existing attributes of a fitting
   * type (FR-010, FR-011, T035, T051): TEXT takes any value; NUMBER and DATE need answers of that kind;
   * fixed values must already be valid for the attribute; the contact name or phone needs TEXT.
   */
  private async attributeProblems(graph: FlowGraph): Promise<Problem[]> {
    const reachable = reachableSteps(graph);
    type Target = { stepId: string; key: string; field: string; issue: (type: AttributeType) => string | null };
    const targets: Target[] = [];
    for (const step of graph.steps) {
      if (!reachable.has(step.id)) continue;
      if ((step.type === 'question' || step.type === 'buttons' || step.type === 'list') && step.saveTo) {
        const kind = step.type === 'question' ? step.answer.kind : 'text';
        const key = step.saveTo.attributeKey;
        targets.push({
          stepId: step.id,
          key,
          field: 'saveTo',
          issue: (type) => (type === 'TEXT' || (type === 'NUMBER' && kind === 'number') || (type === 'DATE' && kind === 'date') ? null : `A ${kind} answer cannot be saved to the ${type.toLowerCase()} attribute "${key}"`),
        });
      }
      if (step.type === 'attributes') {
        for (const item of step.set) {
          const value = item.value;
          targets.push({
            stepId: step.id,
            key: item.key,
            field: 'set',
            issue: (type) => {
              // Clearing fits any type; answers are checked when they are saved.
              if (!value || value.source === 'answer') return null;
              if (value.source === 'field') return type === 'TEXT' ? null : `The contact ${value.key} can only be saved to a text attribute, not "${item.key}"`;
              return validateAttributeValue(type, value.value).ok ? null : `"${value.value}" is not a valid ${type.toLowerCase()} for the attribute "${item.key}"`;
            },
          });
        }
      }
    }
    if (!targets.length) return [];
    const definitions = await this.prisma.attributeDefinition.findMany({
      where: { key: { in: [...new Set(targets.map((t) => t.key))] } },
      select: { key: true, type: true },
    });
    const typeOf = new Map(definitions.map((d) => [d.key, d.type]));
    return targets.flatMap((target): Problem[] => {
      const type = typeOf.get(target.key);
      if (!type) return [{ code: 'UNKNOWN_ATTRIBUTE', message: `The contact attribute "${target.key}" does not exist`, stepId: target.stepId, triggerId: null, field: target.field }];
      const issue = target.issue(type);
      return issue ? [{ code: 'ATTRIBUTE_TYPE', message: issue, stepId: target.stepId, triggerId: null, field: target.field }] : [];
    });
  }

  /**
   * Jumps (T051): the target must be published, and following jumps made without waiting for the
   * customer must not come round in a loop (this draft plus the published versions it reaches).
   */
  private async jumpProblems(row: FlowRow, graph: FlowGraph): Promise<Problem[]> {
    const reachable = reachableSteps(graph);
    const jumps = graph.steps.flatMap((step) => (step.type === 'jump' && step.flowId && reachable.has(step.id) ? [{ stepId: step.id, flowId: step.flowId }] : []));
    if (!jumps.length) return [];
    const problems: Problem[] = [];
    const targets = await this.prisma.flow.findMany({
      where: { id: { in: [...new Set(jumps.map((j) => j.flowId))] } },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    const byId = new Map(targets.map((t) => [t.id, t]));
    for (const jump of jumps) {
      if (jump.flowId === row.id) continue;
      const target = byId.get(jump.flowId);
      if (target && !target.deletedAt && target.status === 'PUBLISHED') continue;
      problems.push({
        code: 'JUMP_TARGET_NOT_PUBLISHED',
        message: target && !target.deletedAt ? `The flow "${target.name}" is not published` : 'The flow to continue in no longer exists',
        stepId: jump.stepId,
        triggerId: null,
        field: 'flowId',
      });
    }

    const graphs = new Map<string, FlowGraph | null>([[row.id, graph]]);
    const graphOf = async (id: string): Promise<FlowGraph | null> => {
      if (!graphs.has(id)) {
        const flow = await this.prisma.flow.findFirst({ where: { id, status: 'PUBLISHED', deletedAt: null }, select: { publishedVersion: { select: { graph: true } } } });
        graphs.set(id, flow?.publishedVersion ? parseGraph(flow.publishedVersion.graph) : null);
      }
      return graphs.get(id) ?? null;
    };
    const onPath = new Set<string>();
    const cleared = new Set<string>();
    const loops = async (id: string, depth: number): Promise<boolean> => {
      if (depth > 25) return false;
      onPath.add(id);
      const g = await graphOf(id);
      for (const next of g ? jumpsWithoutWait(g) : []) {
        if (onPath.has(next)) return true;
        if (!cleared.has(next) && (await loops(next, depth + 1))) return true;
      }
      onPath.delete(id);
      cleared.add(id);
      return false;
    };
    if (await loops(row.id, 0)) {
      const direct = new Set(jumpsWithoutWait(graph));
      const first = jumps.find((j) => direct.has(j.flowId)) ?? jumps[0]!;
      problems.push({
        code: 'LOOP_WITHOUT_WAIT',
        message: 'Jumps between flows go round in a loop without waiting for the customer; add a question, buttons or a list on the way',
        stepId: first.stepId,
        triggerId: null,
        field: null,
      });
    }
    return problems;
  }
}
