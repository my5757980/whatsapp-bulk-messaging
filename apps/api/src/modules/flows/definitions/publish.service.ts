import { HttpStatus, Injectable } from '@nestjs/common';
import { normalizePhrase, reachableSteps, validateForPublish, type FlowGraph, type Problem } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
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
    return problems;
  }

  /** Answers saved to contact attributes need an existing attribute of a fitting type (FR-010, T035). */
  private async attributeProblems(graph: FlowGraph): Promise<Problem[]> {
    const reachable = reachableSteps(graph);
    const targets = graph.steps.flatMap((step) => {
      if (!reachable.has(step.id) || !(step.type === 'question' || step.type === 'buttons' || step.type === 'list') || !step.saveTo) return [];
      return [{ step, key: step.saveTo.attributeKey, kind: step.type === 'question' ? step.answer.kind : 'text' }];
    });
    if (!targets.length) return [];
    const definitions = await this.prisma.attributeDefinition.findMany({
      where: { key: { in: [...new Set(targets.map((t) => t.key))] } },
      select: { key: true, type: true },
    });
    const typeOf = new Map(definitions.map((d) => [d.key, d.type]));
    return targets.flatMap(({ step, key, kind }): Problem[] => {
      const type = typeOf.get(key);
      if (!type) return [{ code: 'UNKNOWN_ATTRIBUTE', message: `The contact attribute "${key}" does not exist`, stepId: step.id, triggerId: null, field: 'saveTo' }];
      // TEXT takes any answer; NUMBER and DATE need that answer kind; BOOLEAN is not an answer target.
      const fits = type === 'TEXT' || (type === 'NUMBER' && kind === 'number') || (type === 'DATE' && kind === 'date');
      if (fits) return [];
      return [{ code: 'ATTRIBUTE_TYPE', message: `A ${kind} answer cannot be saved to the ${type.toLowerCase()} attribute "${key}"`, stepId: step.id, triggerId: null, field: 'saveTo' }];
    });
  }
}
