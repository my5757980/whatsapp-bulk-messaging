import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { validateAttributeValue, type AttributeType } from './attribute-validator.js';

// Filter-based audiences (contract AudienceFilter, FR-014, T125). Rules are combined with AND
// and compiled to parameterised SQL over `contacts c`. Consent is applied separately:
// OPTED_OUT is always excluded, and MARKETING templates need OPTED_IN (research R11).

export const ATTRIBUTE_OPERATORS = ['eq', 'neq', 'contains', 'gt', 'lt', 'before', 'after', 'is_true', 'is_false'] as const;
export type AttributeOperator = (typeof ATTRIBUTE_OPERATORS)[number];

export const AudienceRuleSchema = z.union([
  z.object({ tag: z.string().trim().min(1).max(50) }).strict(),
  z.object({ attr: z.string().trim().min(1).max(40), op: z.enum(ATTRIBUTE_OPERATORS), value: z.unknown().optional() }).strict(),
]);
export type AudienceRule = z.infer<typeof AudienceRuleSchema>;

export const AudienceFilterSchema = z.object({ all: z.array(AudienceRuleSchema).max(20) }).strict();
export type AudienceFilter = z.infer<typeof AudienceFilterSchema>;

export interface AttributeDef {
  key: string;
  type: AttributeType;
}

/** Operators allowed per attribute type. */
const OPERATORS_BY_TYPE: Record<AttributeType, ReadonlySet<AttributeOperator>> = {
  TEXT: new Set(['eq', 'neq', 'contains']),
  NUMBER: new Set(['eq', 'neq', 'gt', 'lt']),
  DATE: new Set(['eq', 'neq', 'before', 'after']),
  BOOLEAN: new Set(['is_true', 'is_false', 'eq', 'neq']),
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

function compileRule(rule: AudienceRule, index: number, defs: ReadonlyMap<string, AttributeType>, errors: ErrorDetail[]): Prisma.Sql | null {
  const field = `audienceFilter.all.${index}`;
  if ('tag' in rule) {
    const name = rule.tag.trim().toLowerCase();
    return Prisma.sql`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = ${name})`;
  }
  const type = defs.get(rule.attr);
  if (!type) {
    errors.push({ field: `${field}.attr`, issue: `"${rule.attr}" is not a defined attribute` });
    return null;
  }
  if (!OPERATORS_BY_TYPE[type].has(rule.op)) {
    errors.push({ field: `${field}.op`, issue: `"${rule.op}" does not apply to ${type.toLowerCase()} attributes` });
    return null;
  }
  const key = rule.attr;
  if (rule.op === 'is_true') return Prisma.sql`(c.attributes -> ${key}) = 'true'::jsonb`;
  if (rule.op === 'is_false') return Prisma.sql`(c.attributes -> ${key}) = 'false'::jsonb`;

  const checked = validateAttributeValue(type, rule.value);
  if (!checked.ok) {
    errors.push({ field: `${field}.value`, issue: checked.issue });
    return null;
  }
  const value = checked.value;
  switch (rule.op) {
    case 'eq':
      return Prisma.sql`(c.attributes ->> ${key}) = ${String(value)}`;
    case 'neq':
      return Prisma.sql`(c.attributes ->> ${key}) IS DISTINCT FROM ${String(value)}`;
    case 'contains':
      return Prisma.sql`(c.attributes ->> ${key}) ILIKE ${`%${escapeLike(String(value))}%`} ESCAPE '\\'`;
    case 'gt':
      return Prisma.sql`(jsonb_typeof(c.attributes -> ${key}) = 'number' AND (c.attributes ->> ${key})::numeric > ${value})`;
    case 'lt':
      return Prisma.sql`(jsonb_typeof(c.attributes -> ${key}) = 'number' AND (c.attributes ->> ${key})::numeric < ${value})`;
    case 'before':
      return Prisma.sql`((c.attributes ->> ${key}) ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (c.attributes ->> ${key}) < ${value})`;
    case 'after':
      return Prisma.sql`((c.attributes ->> ${key}) ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (c.attributes ->> ${key}) > ${value})`;
  }
}

/** Compiles a filter to a WHERE condition on `contacts c`; throws 422 with per-rule details. */
export function compileFilter(filter: AudienceFilter, definitions: readonly AttributeDef[]): Prisma.Sql {
  const defs = new Map(definitions.map((d) => [d.key, d.type]));
  const errors: ErrorDetail[] = [];
  const parts = filter.all.map((rule, i) => compileRule(rule, i, defs, errors));
  if (errors.length) throw AppError.validation('The audience filter is not valid', errors);
  const sql = parts.filter((p): p is Prisma.Sql => p !== null);
  if (!sql.length) return Prisma.sql`TRUE`;
  if (sql.length === 1) return sql[0]!;
  return Prisma.join(
    sql.map((p) => Prisma.sql`(${p})`),
    ' AND ',
  );
}

/** Consent condition for recipients who may receive the template. */
export function eligibilityCondition(category: string, opts: { optedInOnly?: boolean } = {}): Prisma.Sql {
  return category === 'MARKETING' || opts.optedInOnly ? Prisma.sql`c.consent_status = 'OPTED_IN'` : Prisma.sql`c.consent_status <> 'OPTED_OUT'`;
}

export interface AudienceCounts {
  eligible: number;
  excluded: { optedOut: number; noOptIn: number; invalidNumber: number; duplicate: number; missingVariable: number };
}

export interface AudienceContact {
  id: string;
  phone_e164: string;
  country_code: string;
  name: string | null;
  attributes: unknown;
  consent_status: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
}

export type FilterAudience = { type: 'FILTER'; filter: AudienceFilter } | { type: 'ALL_OPTED_IN' };

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AudienceQueryBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async definitions(db: Db = this.prisma): Promise<AttributeDef[]> {
    return db.attributeDefinition.findMany({ select: { key: true, type: true } });
  }

  /** Validates a filter against the current attribute definitions. */
  async compile(filter: AudienceFilter, db: Db = this.prisma): Promise<Prisma.Sql> {
    return compileFilter(filter, await this.definitions(db));
  }

  private async condition(audience: FilterAudience, db: Db): Promise<Prisma.Sql> {
    return audience.type === 'ALL_OPTED_IN' ? Prisma.sql`c.consent_status = 'OPTED_IN'` : this.compile(audience.filter, db);
  }

  /** Eligible and excluded counts for POST /contacts/audience-preview and campaign estimates. */
  async preview(audience: FilterAudience, templateCategory: string, db: Db = this.prisma): Promise<AudienceCounts> {
    const where = await this.condition(audience, db);
    const [row] = await db.$queryRaw<Array<{ total: bigint; opted_out: bigint; unknown: bigint }>>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE c.consent_status = 'OPTED_OUT') AS opted_out,
             count(*) FILTER (WHERE c.consent_status = 'UNKNOWN') AS unknown
        FROM contacts c
       WHERE ${where}`;
    const total = Number(row?.total ?? 0);
    const optedOut = Number(row?.opted_out ?? 0);
    const noOptIn = templateCategory === 'MARKETING' ? Number(row?.unknown ?? 0) : 0;
    return { eligible: total - optedOut - noOptIn, excluded: { optedOut, noOptIn, invalidNumber: 0, duplicate: 0, missingVariable: 0 } };
  }

  /** Matching contacts in id order, in batches (used by the launch snapshot). */
  async *iterate(audience: FilterAudience, db: Db = this.prisma, batchSize = 1000): AsyncGenerator<AudienceContact[]> {
    const where = await this.condition(audience, db);
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const rows: AudienceContact[] = await db.$queryRaw<AudienceContact[]>`
        SELECT c.id, c.phone_e164, c.country_code, c.name, c.attributes, c.consent_status
          FROM contacts c
         WHERE (${where}) ${after}
         ORDER BY c.id
         LIMIT ${batchSize}`;
      if (!rows.length) return;
      cursor = rows[rows.length - 1]!.id;
      yield rows;
      if (rows.length < batchSize) return;
    }
  }
}
