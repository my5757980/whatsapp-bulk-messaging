import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SegmentRulesSchema, segmentReferences, type BrokenSegmentRule, type SegmentRule, type SegmentRules } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AttributeType } from '../../generated/prisma/client.js';
import { CLICKED, DELIVERED, REPLIED } from '../campaigns/replied.sql.js';
import { compileRule } from './audience-query.builder.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';

// Feature 010 (research R1, FR-001 – FR-003, FR-006): saved segments compiled to one parameterised WHERE
// over `contacts c`. Members are never stored; every use runs the SQL. Rules that name a missing tag,
// attribute or campaign compile to FALSE and are reported as broken.

export interface SegmentContext {
  attributes: ReadonlyMap<string, AttributeType>;
  tags: ReadonlySet<string>;
  campaigns: ReadonlySet<string>;
  timezone: string;
}

export interface CompiledSegment {
  where: Prisma.Sql;
  broken: BrokenSegmentRule[];
}

export interface SegmentCounts {
  count: number;
  marketable: number;
}

const FALSE = Prisma.sql`FALSE`;

const EVENT: Record<Extract<SegmentRule, { kind: 'behaviour' }>['event'], Prisma.Sql> = {
  sent: Prisma.sql`m.sent_at IS NOT NULL`,
  delivered: DELIVERED,
  read: Prisma.sql`m.read_at IS NOT NULL`,
  replied: Prisma.sql`${DELIVERED} AND ${REPLIED}`,
  clicked: CLICKED,
  failed: Prisma.sql`m.status = 'FAILED'`,
};

const not = (sql: Prisma.Sql, negate: boolean) => (negate ? Prisma.sql`NOT (${sql})` : sql);

function compileOne(rule: SegmentRule, group: number, index: number, ctx: SegmentContext, broken: BrokenSegmentRule[], errors: ErrorDetail[]): Prisma.Sql {
  const field = `rules.groups.${group}.rules.${index}`;
  switch (rule.kind) {
    case 'tag': {
      const name = rule.tag.trim().toLowerCase();
      if (!ctx.tags.has(name)) {
        broken.push({ group, rule: index, issue: 'TAG_MISSING' });
        return FALSE;
      }
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = ${name})`;
      return not(exists, !rule.has);
    }
    case 'attr': {
      if (!ctx.attributes.has(rule.attr)) {
        broken.push({ group, rule: index, issue: 'ATTRIBUTE_MISSING' });
        return FALSE;
      }
      if (rule.op === 'is_empty' || rule.op === 'is_not_empty') {
        const empty = Prisma.sql`(c.attributes -> ${rule.attr} IS NULL OR (c.attributes ->> ${rule.attr}) = '')`;
        return not(empty, rule.op === 'is_not_empty');
      }
      const sql = compileRule({ attr: rule.attr, op: rule.op, value: rule.value }, index, ctx.attributes, errors, field);
      return sql ?? FALSE;
    }
    case 'consent':
      return Prisma.sql`c.consent_status::text IN (${Prisma.join(rule.statuses)})`;
    case 'lead_source':
      return Prisma.sql`c.lead_source_kind::text IN (${Prisma.join(rule.sources)})`;
    case 'added':
      if (rule.days !== undefined) return Prisma.sql`c.created_at >= now() - make_interval(days => ${rule.days})`;
      if (rule.before !== undefined) return Prisma.sql`c.created_at < ((${rule.before}::date)::timestamp AT TIME ZONE ${ctx.timezone})`;
      return Prisma.sql`c.created_at >= (((${rule.after!}::date) + 1)::timestamp AT TIME ZONE ${ctx.timezone})`;
    case 'last_inbound': {
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = c.id AND cv.last_inbound_at >= now() - make_interval(days => ${rule.days}))`;
      return not(exists, !rule.within);
    }
    case 'blocked':
      return rule.blocked ? Prisma.sql`c.blocked_at IS NOT NULL` : Prisma.sql`c.blocked_at IS NULL`;
    case 'behaviour': {
      if (rule.campaignId && !ctx.campaigns.has(rule.campaignId)) {
        broken.push({ group, rule: index, issue: 'CAMPAIGN_MISSING' });
        return FALSE;
      }
      const scope = rule.campaignId ? Prisma.sql`m.campaign_id = ${rule.campaignId}::uuid` : Prisma.sql`m.created_at >= now() - make_interval(days => ${rule.days!})`;
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.origin = 'CAMPAIGN' AND ${scope} AND ${EVENT[rule.event]})`;
      return not(exists, !rule.did);
    }
  }
}

/**
 * Compiles checked rules. Values that do not fit an attribute's type are a 422 (they can be fixed now);
 * missing tags, attributes or campaigns are reported as broken (FR-006).
 */
export function compileSegment(rules: SegmentRules, ctx: SegmentContext): CompiledSegment {
  const broken: BrokenSegmentRule[] = [];
  const errors: ErrorDetail[] = [];
  const groups = rules.groups.map((group, g) => {
    const parts = group.rules.map((rule, i) => Prisma.sql`(${compileOne(rule, g, i, ctx, broken, errors)})`);
    return Prisma.sql`(${Prisma.join(parts, group.match === 'all' ? ' AND ' : ' OR ')})`;
  });
  if (errors.length) throw AppError.validation('The segment rules are not valid', errors);
  return { where: Prisma.join(groups, ' AND '), broken };
}

/** Opted in and not blocked: who can receive marketing messages. */
export const MARKETABLE = Prisma.sql`c.consent_status = 'OPTED_IN' AND c.blocked_at IS NULL`;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SegmentQueryBuilder {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Parses stored or submitted rules; a 422 names the problems. */
  parse(rules: unknown): SegmentRules {
    const parsed = SegmentRulesSchema.safeParse(rules);
    if (!parsed.success) throw AppError.validation('The segment rules are not valid', parsed.error.issues.map((i) => ({ field: ['rules', ...i.path].join('.'), issue: i.message })));
    return parsed.data;
  }

  /** What the rules refer to, read only for the names and ids they use. */
  async context(rules: SegmentRules, db: Db = this.prisma): Promise<SegmentContext> {
    const refs = segmentReferences(rules);
    const [defs, tags, campaigns, settings] = await Promise.all([
      db.attributeDefinition.findMany({ select: { key: true, type: true } }),
      refs.tags.length ? db.tag.findMany({ where: { name: { in: refs.tags } }, select: { name: true } }) : Promise.resolve([]),
      refs.campaignIds.length ? db.campaign.findMany({ where: { id: { in: refs.campaignIds } }, select: { id: true } }) : Promise.resolve([]),
      db.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } }),
    ]);
    return {
      attributes: new Map(defs.map((d) => [d.key, d.type])),
      tags: new Set(tags.map((t) => t.name)),
      campaigns: new Set(campaigns.map((c) => c.id)),
      timezone: settings?.defaultTimezone ?? 'UTC',
    };
  }

  async compile(rules: SegmentRules, db: Db = this.prisma): Promise<CompiledSegment> {
    return compileSegment(rules, await this.context(rules, db));
  }

  /** The WHERE of a saved segment for campaigns and enrolments: 404 when missing, 422 when broken. */
  async whereFor(segmentId: string, db: Db = this.prisma): Promise<Prisma.Sql> {
    const segment = await db.segment.findUnique({ where: { id: segmentId }, select: { rules: true } });
    if (!segment) throw new AppError(404, 'SEGMENT_NOT_FOUND', 'The segment no longer exists');
    const compiled = await this.compile(this.parse(segment.rules), db);
    if (compiled.broken.length) {
      throw AppError.validation(
        'The segment has a rule that names a deleted tag, attribute or campaign. Fix the segment first.',
        compiled.broken.map((b) => ({ field: `rules.groups.${b.group}.rules.${b.rule}`, issue: b.issue })),
        'SEGMENT_BROKEN',
      );
    }
    return compiled.where;
  }

  /** Matching and marketable counts, cached 10 seconds per rules and run with a 10-second limit (SC-001). */
  async counts(rules: SegmentRules, where: Prisma.Sql): Promise<SegmentCounts> {
    const key = `wbm:segcount:${createHash('sha256').update(JSON.stringify(rules)).digest('hex')}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as SegmentCounts;
    const stopTimer = this.metrics?.segmentQuerySeconds.startTimer();
    const [row] = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
      return tx.$queryRaw<Array<{ count: bigint; marketable: bigint }>>`
        SELECT count(*) AS count, count(*) FILTER (WHERE ${MARKETABLE}) AS marketable FROM contacts c WHERE ${where}`;
    });
    stopTimer?.();
    const counts = { count: Number(row?.count ?? 0), marketable: Number(row?.marketable ?? 0) };
    await this.redis.set(key, JSON.stringify(counts), 'EX', 10).catch(() => undefined);
    return counts;
  }

  /** Up to 20 matching contacts, newest first. */
  async sample(where: Prisma.Sql): Promise<Array<{ id: string; name: string | null; phone_e164: string }>> {
    return this.prisma.$queryRaw<Array<{ id: string; name: string | null; phone_e164: string }>>`
      SELECT c.id, c.name, c.phone_e164 FROM contacts c WHERE ${where} ORDER BY c.created_at DESC LIMIT 20`;
  }
}
