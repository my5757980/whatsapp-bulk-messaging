import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_CAMPAIGN_DAILY_LIMIT_MAX,
  API_CAMPAIGN_MAX_TAGS,
  VALUE_KEY_PATTERN,
  apiNameProblem,
  callValueKeys,
  isContactField,
  mappingProblems,
  startOfLocalDay,
  type ApiVariableMapping,
  type MetaTemplateComponent,
} from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { ApiCampaign, ApiCampaignStatus, Prisma, Template, WhatsAppNumber } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { validateAttributeValue, type AttributeType } from '../../contacts/attribute-validator.js';
import { normaliseTag } from '../../contacts/tags.controller.js';
import { headerMediaType } from '../../sending/template-payload.builder.js';
import { SettingsService } from '../../settings/settings.service.js';

// API campaigns in the dashboard (feature 006 US3, FR-017, FR-018, FR-022, contracts/integrations-api.openapi.yaml):
// drafts, going live with checks, pause and stop, results per day and the export.

const VariableSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('value'), key: z.string().regex(VALUE_KEY_PATTERN, 'use lower-case letters, digits and _') }).strict(),
  z.object({ source: z.literal('field'), key: z.string().max(70).refine(isContactField, 'is not a contact field') }).strict(),
  z.object({ source: z.literal('static'), value: z.string().max(1024) }).strict(),
]);
const AttributeSpecSchema = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.object({ fromValue: z.string().regex(VALUE_KEY_PATTERN, 'use lower-case letters, digits and _') }).strict(),
]);

const fields = {
  name: z.string().trim().min(1).max(120),
  apiName: z
    .string()
    .trim()
    .refine((v) => apiNameProblem(v) === null, { message: 'use 3 to 60 lower-case letters, digits and dashes, starting and ending with a letter or digit' }),
  numberId: z.uuid(),
  templateId: z.uuid(),
  variableMapping: z.record(z.string().max(60), VariableSourceSchema),
  headerMediaAssetId: z.uuid().nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(API_CAMPAIGN_MAX_TAGS),
  attributes: z.record(z.string().min(1).max(60), AttributeSpecSchema),
  createContacts: z.boolean(),
  dailyLimit: z.number().int().min(1).max(API_CAMPAIGN_DAILY_LIMIT_MAX).nullable(),
};

export const ApiCampaignCreateSchema = z
  .object(fields)
  .partial({ variableMapping: true, headerMediaAssetId: true, tags: true, attributes: true, createContacts: true, dailyLimit: true })
  .strict();
export type ApiCampaignCreate = z.infer<typeof ApiCampaignCreateSchema>;

export const ApiCampaignPatchSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field' });
export type ApiCampaignPatch = z.infer<typeof ApiCampaignPatchSchema>;

export const ApiCampaignListQuerySchema = z.object({ status: z.enum(['DRAFT', 'LIVE', 'PAUSED', 'STOPPED']).optional() }).strict();
export const ResultsQuerySchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to', path: ['from'] });
export type ResultsQuery = z.infer<typeof ResultsQuerySchema>;

type CampaignRow = ApiCampaign & {
  template: Pick<Template, 'name' | 'language' | 'category' | 'status' | 'variables' | 'components' | 'wabaId'>;
  number: Pick<WhatsAppNumber, 'label' | 'connectionStatus' | 'wabaId'>;
};

const INCLUDE = {
  template: { select: { name: true, language: true, category: true, status: true, variables: true, components: true, wabaId: true } },
  number: { select: { label: true, connectionStatus: true, wabaId: true } },
} as const;

export interface MessageCounts {
  triggers: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  clicked: number;
  notSent: number;
}

export function templateVariableKeys(template: Pick<Template, 'variables'>): string[] {
  return ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const STOPPED = () => AppError.conflict('This API campaign is stopped; create a new one instead', 'STOPPED');

@Injectable()
export class ApiCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(status?: ApiCampaignStatus) {
    const rows = await this.prisma.apiCampaign.findMany({ where: status ? { status } : {}, include: INCLUDE, orderBy: { createdAt: 'desc' } });
    const today = await this.todayCounts(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, today.get(r.id) ?? 0));
  }

  async get(id: string) {
    const row = await this.load(id);
    return this.toDto(row, (await this.todayCounts([id])).get(id) ?? 0);
  }

  async create(input: ApiCampaignCreate, actor: AuditActor & { userId: string }) {
    const data = await this.checked({ ...input }, null);
    await this.assertNamesFree(input.name, input.apiName, null);
    try {
      const created = await this.prisma.apiCampaign.create({
        data: {
          name: input.name,
          apiName: input.apiName,
          numberId: input.numberId,
          templateId: input.templateId,
          variableMapping: (input.variableMapping ?? {}) as Prisma.InputJsonValue,
          headerMediaAssetId: input.headerMediaAssetId ?? null,
          tags: data.tags ?? [],
          attributes: (data.attributes ?? {}) as Prisma.InputJsonValue,
          createContacts: input.createContacts ?? true,
          dailyLimit: input.dailyLimit ?? null,
          createdById: actor.userId,
        },
      });
      await this.audit.record(actor, 'api_campaign.created', { type: 'api_campaign', id: created.id }, { name: created.name, apiName: created.apiName });
      return this.get(created.id);
    } catch (error) {
      // A parallel request took the name meanwhile.
      if (isUniqueViolation(error)) throw AppError.conflict('An API campaign with this name or API name already exists', 'NAME_TAKEN');
      throw error;
    }
  }

  /** Live campaigns change for new calls only (FR-018); the API name is fixed once it went live. */
  async update(id: string, input: ApiCampaignPatch, actor: AuditActor) {
    const current = await this.load(id);
    if (current.status === 'STOPPED') throw STOPPED();
    if (input.apiName !== undefined && input.apiName !== current.apiName && current.wentLiveAt) {
      throw AppError.conflict('The API name cannot change after the campaign went live; callers use it', 'API_NAME_FIXED');
    }
    const merged = {
      numberId: input.numberId ?? current.numberId,
      templateId: input.templateId ?? current.templateId,
      headerMediaAssetId: input.headerMediaAssetId !== undefined ? input.headerMediaAssetId : current.headerMediaAssetId,
      tags: input.tags,
      attributes: input.attributes,
    };
    const data = await this.checked(merged, current);
    await this.assertNamesFree(input.name ?? null, input.apiName !== undefined && input.apiName !== current.apiName ? input.apiName : null, id);
    const update: Prisma.ApiCampaignUncheckedUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.apiName !== undefined ? { apiName: input.apiName } : {}),
      ...(input.numberId !== undefined ? { numberId: input.numberId } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.variableMapping !== undefined ? { variableMapping: input.variableMapping as Prisma.InputJsonValue } : {}),
      ...(input.headerMediaAssetId !== undefined ? { headerMediaAssetId: input.headerMediaAssetId } : {}),
      ...(data.tags !== undefined ? { tags: data.tags } : {}),
      ...(data.attributes !== undefined ? { attributes: data.attributes as Prisma.InputJsonValue } : {}),
      ...(input.createContacts !== undefined ? { createContacts: input.createContacts } : {}),
      ...(input.dailyLimit !== undefined ? { dailyLimit: input.dailyLimit } : {}),
    };
    // A live campaign must stay sendable after the change.
    if (current.status === 'LIVE') {
      const next = await this.prisma.$transaction(async (tx) => {
        await tx.apiCampaign.update({ where: { id }, data: update });
        const row = await tx.apiCampaign.findUniqueOrThrow({ where: { id }, include: INCLUDE });
        const problems = this.problems(row);
        if (problems.length) throw new AppError(HttpStatus.CONFLICT, 'NOT_READY', 'This change would stop the live campaign from sending; fix these first', undefined, { problems });
        return row;
      });
      await this.audit.record(actor, 'api_campaign.updated', { type: 'api_campaign', id }, { changed: Object.keys(input) });
      return this.get(next.id);
    }
    try {
      await this.prisma.apiCampaign.update({ where: { id }, data: update });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('An API campaign with this name or API name already exists', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'api_campaign.updated', { type: 'api_campaign', id }, { changed: Object.keys(input) });
    return this.get(id);
  }

  /** Drafts and paused campaigns go live once nothing is missing (FR-017). */
  async goLive(id: string, actor: AuditActor) {
    const row = await this.load(id);
    if (row.status === 'STOPPED') throw STOPPED();
    if (row.status === 'LIVE') return this.get(id);
    const problems = this.problems(row);
    if (problems.length) throw new AppError(HttpStatus.CONFLICT, 'NOT_READY', 'Fix these problems before setting the campaign live', undefined, { problems });
    const now = new Date();
    const { count } = await this.prisma.apiCampaign.updateMany({
      where: { id, status: row.status },
      data: { status: 'LIVE', pausedReason: null, pausedAt: null, ...(row.wentLiveAt ? {} : { wentLiveAt: now }) },
    });
    if (!count) throw AppError.conflict('The campaign changed meanwhile; try again');
    await this.audit.record(actor, 'api_campaign.live', { type: 'api_campaign', id }, { previousStatus: row.status, previousReason: row.pausedReason });
    return this.get(id);
  }

  async pause(id: string, actor: AuditActor) {
    await this.load(id);
    const { count } = await this.prisma.apiCampaign.updateMany({ where: { id, status: 'LIVE' }, data: { status: 'PAUSED', pausedReason: 'MEMBER', pausedAt: new Date() } });
    if (!count) throw AppError.conflict('Only a live campaign can be paused', 'NOT_LIVE');
    await this.audit.record(actor, 'api_campaign.paused', { type: 'api_campaign', id }, {});
    return this.get(id);
  }

  /** Stopped for good: results stay and the name is free again. */
  async stop(id: string, actor: AuditActor) {
    const row = await this.load(id);
    if (row.status === 'STOPPED') return this.get(id);
    await this.prisma.apiCampaign.update({ where: { id }, data: { status: 'STOPPED', stoppedAt: new Date() } });
    await this.audit.record(actor, 'api_campaign.stopped', { type: 'api_campaign', id }, { previousStatus: row.status });
    return this.get(id);
  }

  /** Triggers and message results in total and per day of the company time zone (FR-022). */
  async results(id: string, query: ResultsQuery) {
    await this.load(id);
    const { defaultTimezone: tz } = await this.settings.get();
    const today = localDate(new Date(), tz);
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -29);
    const days = await this.prisma.$queryRaw<Array<MessageCounts & { date: string }>>`
      SELECT to_char((t.created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
             count(*)::int AS triggers,
             (count(m.id) FILTER (WHERE m.status IN ('SENT', 'DELIVERED', 'READ')))::int AS sent,
             (count(m.id) FILTER (WHERE m.status IN ('DELIVERED', 'READ')))::int AS delivered,
             (count(m.id) FILTER (WHERE m.status = 'READ'))::int AS read,
             (count(m.id) FILTER (WHERE m.status = 'FAILED'))::int AS failed,
             (count(m.id) FILTER (WHERE EXISTS (SELECT 1 FROM tracked_links tl JOIN link_clicks lc ON lc.tracked_link_id = tl.id WHERE tl.message_id = m.id)))::int AS clicked,
             (count(*) FILTER (WHERE t.outcome = 'NOT_SENT'))::int AS "notSent"
        FROM api_campaign_triggers t
        LEFT JOIN messages m ON m.id = t.message_id
       WHERE t.api_campaign_id = ${id}::uuid
         AND t.created_at >= (${from}::date::timestamp AT TIME ZONE ${tz})
         AND t.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
       GROUP BY 1
       ORDER BY 1`;
    const notSent = await this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
      SELECT coalesce(reason, 'unknown') AS reason, count(*)::int AS n
        FROM api_campaign_triggers
       WHERE api_campaign_id = ${id}::uuid AND outcome = 'NOT_SENT'
         AND created_at >= (${from}::date::timestamp AT TIME ZONE ${tz})
         AND created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
       GROUP BY 1`;
    const failures = await this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
      SELECT coalesce(m.failure_reason, 'unknown') AS reason, count(*)::int AS n
        FROM api_campaign_triggers t
        JOIN messages m ON m.id = t.message_id
       WHERE t.api_campaign_id = ${id}::uuid AND m.status = 'FAILED'
         AND t.created_at >= (${from}::date::timestamp AT TIME ZONE ${tz})
         AND t.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})
       GROUP BY 1`;
    const totals: MessageCounts = { triggers: 0, sent: 0, delivered: 0, read: 0, failed: 0, clicked: 0, notSent: 0 };
    for (const day of days) for (const key of Object.keys(totals) as Array<keyof MessageCounts>) totals[key] += day[key];
    return {
      from,
      to,
      totals,
      days,
      notSentReasons: Object.fromEntries(notSent.map((r) => [r.reason, r.n])),
      failureReasons: Object.fromEntries(failures.map((r) => [r.reason, r.n])),
    };
  }

  /** Every trigger with its message, oldest first, in pages for the CSV export. */
  async *exportRows(id: string): AsyncGenerator<Array<{ createdAt: Date; phone: string | null; outcome: string; reason: string | null; messageId: string | null; status: string | null; failureReason: string | null }>> {
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: Array<Prisma.ApiCampaignTriggerGetPayload<{ include: { message: { select: { status: true; failureReason: true } } } }>> = await this.prisma.apiCampaignTrigger.findMany({
        where: {
          apiCampaignId: id,
          ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
        },
        include: { message: { select: { status: true, failureReason: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1000,
      });
      if (!page.length) return;
      yield page.map((t) => ({
        createdAt: t.createdAt,
        phone: t.phoneE164,
        outcome: t.outcome,
        reason: t.reason,
        messageId: t.messageId,
        status: t.message?.status ?? null,
        failureReason: t.message?.failureReason ?? null,
      }));
      const last = page[page.length - 1]!;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  async assertExists(id: string): Promise<{ id: string; name: string; apiName: string }> {
    const row = await this.prisma.apiCampaign.findUnique({ where: { id }, select: { id: true, name: true, apiName: true } });
    if (!row) throw AppError.notFound('API campaign not found');
    return row;
  }

  /** What keeps the campaign from sending: the template, the number and the mapping. */
  private problems(row: CampaignRow): Array<{ code: string; message: string }> {
    const problems: Array<{ code: string; message: string }> = [];
    if (row.template.status !== 'APPROVED') problems.push({ code: 'TEMPLATE_NOT_APPROVED', message: `The template ${row.template.name} is ${row.template.status.toLowerCase()}, not approved` });
    if (row.number.connectionStatus !== 'CONNECTED') problems.push({ code: 'NUMBER_NOT_CONNECTED', message: `The number ${row.number.label} is not connected` });
    if (row.template.wabaId !== row.number.wabaId) problems.push({ code: 'TEMPLATE_OTHER_ACCOUNT', message: 'The template belongs to another WhatsApp account than the number' });
    for (const message of mappingProblems(templateVariableKeys(row.template), asRecord(row.variableMapping) as ApiVariableMapping)) problems.push({ code: 'MAPPING', message });
    return problems;
  }

  /** Checks references and attribute values; returns tags and attributes as stored. */
  private async checked(
    input: { numberId?: string; templateId?: string; headerMediaAssetId?: string | null; tags?: string[]; attributes?: Record<string, unknown> },
    current: CampaignRow | null,
  ): Promise<{ tags?: string[]; attributes?: Record<string, unknown> }> {
    const details: Array<{ field: string; issue: string }> = [];
    const numberId = input.numberId ?? current?.numberId;
    const templateId = input.templateId ?? current?.templateId;
    const number = numberId ? await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { wabaId: true } }) : null;
    if (!number) details.push({ field: 'numberId', issue: 'is not a WhatsApp number of the company' });
    const template = templateId ? await this.prisma.template.findUnique({ where: { id: templateId }, select: { wabaId: true, status: true } }) : null;
    if (!template || template.status === 'DELETED') details.push({ field: 'templateId', issue: 'is not a template' });
    else if (number && template.wabaId !== number.wabaId) details.push({ field: 'templateId', issue: 'belongs to another WhatsApp account than the number' });
    if (input.headerMediaAssetId && !(await this.prisma.mediaAsset.findUnique({ where: { id: input.headerMediaAssetId }, select: { id: true } }))) {
      details.push({ field: 'headerMediaAssetId', issue: 'is not in the media library' });
    }
    const tags = input.tags ? [...new Set(input.tags.map(normaliseTag).filter(Boolean))] : undefined;
    let attributes: Record<string, unknown> | undefined;
    if (input.attributes) {
      attributes = {};
      const defs = new Map((await this.prisma.attributeDefinition.findMany({ select: { key: true, type: true } })).map((d) => [d.key, d.type as AttributeType]));
      for (const [key, spec] of Object.entries(input.attributes)) {
        const type = defs.get(key);
        if (!type) {
          details.push({ field: `attributes.${key}`, issue: 'is not a defined attribute' });
          continue;
        }
        if (spec && typeof spec === 'object') {
          attributes[key] = spec;
          continue;
        }
        const checked = validateAttributeValue(type, spec);
        if (checked.ok) attributes[key] = checked.value;
        else details.push({ field: `attributes.${key}`, issue: checked.issue });
      }
    }
    if (details.length) throw AppError.validation('Check the campaign settings', details);
    return { tags, attributes };
  }

  /** Names are unique among campaigns that are not stopped; API names are unique for good. */
  private async assertNamesFree(name: string | null, apiName: string | null, exceptId: string | null): Promise<void> {
    if (name) {
      const taken = await this.prisma.apiCampaign.findFirst({ where: { name, status: { not: 'STOPPED' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
      if (taken) throw AppError.conflict('Another API campaign has this name', 'NAME_TAKEN');
    }
    if (apiName) {
      const taken = await this.prisma.apiCampaign.findUnique({ where: { apiName }, select: { id: true } });
      if (taken && taken.id !== exceptId) throw AppError.conflict('Another API campaign uses this API name', 'API_NAME_TAKEN');
    }
  }

  private async load(id: string): Promise<CampaignRow> {
    const row = await this.prisma.apiCampaign.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw AppError.notFound('API campaign not found');
    return row;
  }

  private async todayCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const { defaultTimezone } = await this.settings.get();
    const rows = await this.prisma.apiCampaignTrigger.groupBy({
      by: ['apiCampaignId'],
      where: { apiCampaignId: { in: ids }, createdAt: { gte: startOfLocalDay(new Date(), defaultTimezone) } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.apiCampaignId, r._count._all]));
  }

  private toDto(row: CampaignRow, todayTriggers: number) {
    const mapping = asRecord(row.variableMapping) as ApiVariableMapping;
    const attributes = asRecord(row.attributes);
    const needsMedia = Boolean(headerMediaType(row.template.components as unknown as MetaTemplateComponent[])) && !row.headerMediaAssetId;
    return {
      id: row.id,
      name: row.name,
      apiName: row.apiName,
      numberId: row.numberId,
      numberLabel: row.number.label,
      templateId: row.templateId,
      templateName: row.template.name,
      templateLanguage: row.template.language,
      templateCategory: row.template.category,
      templateStatus: row.template.status,
      variables: templateVariableKeys(row.template),
      variableMapping: mapping,
      headerMediaAssetId: row.headerMediaAssetId,
      headerMediaType: headerMediaType(row.template.components as unknown as MetaTemplateComponent[]),
      tags: row.tags,
      attributes,
      createContacts: row.createContacts,
      dailyLimit: row.dailyLimit,
      status: row.status,
      pausedReason: row.pausedReason as 'TEMPLATE_UNAVAILABLE' | 'NUMBER_DISCONNECTED' | 'MEMBER' | null,
      wentLiveAt: row.wentLiveAt?.toISOString() ?? null,
      pausedAt: row.pausedAt?.toISOString() ?? null,
      stoppedAt: row.stoppedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      callExample: callExample(this.config.APP_URL, row.apiName, callValueKeys(mapping, attributes), needsMedia),
      todayTriggers,
    };
  }
}

/** A ready-made request for the developer (FR-017). */
export function callExample(baseUrl: string, apiName: string, valueKeys: string[], needsMedia: boolean): string {
  const body = {
    phone: '+971501234567',
    name: 'Sara',
    values: Object.fromEntries(valueKeys.map((k) => [k, `<${k}>`])),
    ...(needsMedia ? { mediaUrl: 'https://example.com/receipt.pdf' } : {}),
  };
  return [
    `curl -X POST '${baseUrl.replace(/\/+$/, '')}/api/v1/api-campaigns/${apiName}/messages' \\`,
    "  -H 'Authorization: Bearer wbk_YOUR_KEY' \\",
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Idempotency-Key: a-unique-id-per-message' \\",
    `  -d '${JSON.stringify(body)}'`,
  ].join('\n');
}

/** YYYY-MM-DD of an instant in a time zone. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
