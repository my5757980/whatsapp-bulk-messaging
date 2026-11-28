import { Injectable } from '@nestjs/common';
import { can, SegmentRulesSchema, segmentReferences, type BrokenSegmentRule, type Role, type SegmentRules } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { maskPhone } from '../../common/phone/phone.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma, Segment } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { SegmentQueryBuilder, compileSegment, type SegmentContext } from './segment-query.builder.js';

// Feature 010 (US1, FR-001 – FR-007, contracts/contacts-settings-api.openapi.yaml tag segments).

export const SegmentInputSchema = z
  .object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).nullish(), rules: z.unknown() })
  .strict();
export type SegmentInput = z.infer<typeof SegmentInputSchema>;
export const SegmentPreviewSchema = z.object({ rules: z.unknown() }).strict();
export const SegmentCopySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

const UNFINISHED = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED'] as const;
const NAME_TAKEN = () => AppError.conflict('Another segment has this name', 'NAME_TAKEN');
type Row = Segment & { createdBy: { name: string | null } | null };

@Injectable()
export class SegmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: SegmentQueryBuilder,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.segment.findMany({ include: { createdBy: { select: { name: true } } }, orderBy: { name: 'asc' } });
    const contexts = await this.contexts(rows);
    const used = await this.usedBy(rows.map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, contexts.get(r.id)!, used.get(r.id) ?? [])) };
  }

  async get(id: string) {
    const row = await this.load(id);
    const [contexts, used] = await Promise.all([this.contexts([row]), this.usedBy([id])]);
    return this.toDto(row, contexts.get(id)!, used.get(id) ?? []);
  }

  async create(input: SegmentInput, actor: AuditActor) {
    const rules = await this.checked(input.rules);
    try {
      const row = await this.prisma.segment.create({ data: { name: input.name, description: input.description ?? null, rules: rules as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null } });
      await this.audit.record(actor, 'segment.created', { type: 'segment', id: row.id }, { name: row.name, rules: rules.groups.reduce((n, g) => n + g.rules.length, 0) });
      return this.get(row.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw NAME_TAKEN();
      throw error;
    }
  }

  async update(id: string, input: SegmentInput, actor: AuditActor) {
    await this.load(id);
    const rules = await this.checked(input.rules);
    try {
      await this.prisma.segment.update({ where: { id }, data: { name: input.name, description: input.description ?? null, rules: rules as unknown as Prisma.InputJsonValue } });
    } catch (error) {
      if (isUniqueViolation(error)) throw NAME_TAKEN();
      throw error;
    }
    await this.audit.record(actor, 'segment.updated', { type: 'segment', id }, { name: input.name });
    return this.get(id);
  }

  async copy(id: string, name: string, actor: AuditActor) {
    const row = await this.load(id);
    return this.create({ name, description: row.description, rules: row.rules }, actor);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.load(id);
    const used = (await this.usedBy([id])).get(id) ?? [];
    if (used.length) {
      throw new AppError(409, 'SEGMENT_IN_USE', 'Campaigns that have not finished use this segment', used.map((c) => ({ field: `campaign.${c.id}`, issue: `${c.name} (${c.state.toLowerCase()})` })));
    }
    await this.prisma.segment.delete({ where: { id } });
    await this.audit.record(actor, 'segment.deleted', { type: 'segment', id }, { name: row.name });
  }

  /** Counts and a sample for rules being edited; broken rules are listed, not refused (FR-003). */
  async preview(rawRules: unknown, role: Role) {
    const rules = this.builder.parse(rawRules);
    const compiled = await this.builder.compile(rules);
    const [counts, sample] = await Promise.all([this.builder.counts(rules, compiled.where), this.builder.sample(compiled.where)]);
    const fullPhones = can(role, 'phones.full');
    return { ...counts, broken: compiled.broken, sample: sample.map((c) => ({ id: c.id, name: c.name, phone: fullPhones ? c.phone_e164 : (maskPhone(c.phone_e164) ?? '') })) };
  }

  async count(id: string) {
    const row = await this.load(id);
    const rules = this.builder.parse(row.rules);
    const compiled = await this.builder.compile(rules);
    return { ...(await this.builder.counts(rules, compiled.where)), broken: compiled.broken };
  }

  /** Rules must be valid and name only things that exist when saved. */
  private async checked(raw: unknown): Promise<SegmentRules> {
    const rules = this.builder.parse(raw);
    const { broken } = await this.builder.compile(rules);
    if (broken.length) {
      throw AppError.validation(
        'A rule names a tag, attribute or campaign that does not exist',
        broken.map((b) => ({ field: `rules.groups.${b.group}.rules.${b.rule}`, issue: b.issue })),
        'SEGMENT_BROKEN',
      );
    }
    return rules;
  }

  private async load(id: string): Promise<Row> {
    const row = await this.prisma.segment.findUnique({ where: { id }, include: { createdBy: { select: { name: true } } } });
    if (!row) throw AppError.notFound('Segment not found');
    return row;
  }

  /** One read of the tags, attributes and campaigns all the segments refer to. */
  private async contexts(rows: Segment[]): Promise<Map<string, { rules: SegmentRules | null; ctx: SegmentContext }>> {
    const parsed = rows.map((r) => ({ id: r.id, rules: parseStoredRules(r.rules) }));
    const refs = parsed.map((p) => (p.rules ? segmentReferences(p.rules) : { tags: [], attributes: [], campaignIds: [] }));
    const tagNames = [...new Set(refs.flatMap((r) => r.tags))];
    const campaignIds = [...new Set(refs.flatMap((r) => r.campaignIds))];
    const [defs, tags, campaigns, settings] = await Promise.all([
      this.prisma.attributeDefinition.findMany({ select: { key: true, type: true } }),
      tagNames.length ? this.prisma.tag.findMany({ where: { name: { in: tagNames } }, select: { name: true } }) : Promise.resolve([]),
      campaignIds.length ? this.prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true } }) : Promise.resolve([]),
      this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } }),
    ]);
    const ctx: SegmentContext = {
      attributes: new Map(defs.map((d) => [d.key, d.type])),
      tags: new Set(tags.map((t) => t.name)),
      campaigns: new Set(campaigns.map((c) => c.id)),
      timezone: settings?.defaultTimezone ?? 'UTC',
    };
    return new Map(parsed.map((p) => [p.id, { rules: p.rules, ctx }]));
  }

  private async usedBy(ids: string[]): Promise<Map<string, Array<{ id: string; name: string; state: string }>>> {
    if (!ids.length) return new Map();
    const campaigns = await this.prisma.campaign.findMany({ where: { segmentId: { in: ids }, state: { in: [...UNFINISHED] } }, select: { id: true, name: true, state: true, segmentId: true } });
    const map = new Map<string, Array<{ id: string; name: string; state: string }>>();
    for (const c of campaigns) map.set(c.segmentId!, [...(map.get(c.segmentId!) ?? []), { id: c.id, name: c.name, state: c.state }]);
    return map;
  }

  private toDto(row: Row, entry: { rules: SegmentRules | null; ctx: SegmentContext }, usedBy: Array<{ id: string; name: string; state: string }>) {
    let broken: BrokenSegmentRule[] = [];
    if (entry.rules) {
      try {
        broken = compileSegment(entry.rules, entry.ctx).broken;
      } catch {
        broken = [];
      }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      rules: row.rules,
      broken,
      usedBy,
      createdBy: row.createdBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Stored rules that no longer parse (they never should) are treated as having no rules. */
function parseStoredRules(raw: unknown): SegmentRules | null {
  const parsed = SegmentRulesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
