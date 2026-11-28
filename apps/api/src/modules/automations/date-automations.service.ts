import { Injectable } from '@nestjs/common';
import { DATE_AUTOMATION_MAX_OFFSET } from '@wbm/shared';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { DELIVERED, REPLIED } from '../campaigns/replied.sql.js';
import { unmappedVariables, VariableMappingSchema, type VariableMapping } from '../campaigns/variable-resolver.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, companyClock, dayDate, dueCondition } from './due-query.js';

// Feature 010 (US5, research R9, FR-020 – FR-024): templates sent on dates stored in contact attributes.

/** A real calendar day as YYYY-MM-DD. */
const day = z.string().refine((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'is not a valid date (YYYY-MM-DD)');
const offsetDays = z.number().int().min(-DATE_AUTOMATION_MAX_OFFSET).max(DATE_AUTOMATION_MAX_OFFSET);

export const DateRuleSchema = z.object({ attributeKey: z.string().trim().min(1).max(40), timing: z.enum(['YEARLY', 'ONCE']), offsetDays }).strict();
export const DateAutomationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    attributeKey: z.string().trim().min(1).max(40),
    timing: z.enum(['YEARLY', 'ONCE']),
    offsetDays,
    sendTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'use HH:mm'),
    numberId: z.uuid(),
    templateId: z.uuid(),
    variableMapping: VariableMappingSchema,
  })
  .strict();
export const SwitchSchema = z.object({ on: z.boolean() }).strict();
export const ResultsQuerySchema = z.object({ from: day.optional(), to: day.optional() });
export const RecipientsQuerySchema = z.object({
  date: day,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DateRule = z.infer<typeof DateRuleSchema>;
export type DateAutomationInput = z.infer<typeof DateAutomationInputSchema>;

export type PauseReason = 'TEMPLATE_NOT_APPROVED' | 'NUMBER_DISCONNECTED' | 'SENDING_OFF';
/** Results never cover more than this many days at once. */
const MAX_RANGE_DAYS = 92;

const include = { number: { select: { label: true } }, template: { select: { name: true } } } as const;
type Row = Prisma.DateAutomationGetPayload<{ include: typeof include }>;
type Last7 = { sent: number; failed: number; skipped: number };

const toDto = (row: Row, last7Days: Last7) => ({
  id: row.id,
  name: row.name,
  attributeKey: row.attributeKey,
  timing: row.timing,
  offsetDays: row.offsetDays,
  sendTime: row.sendTime,
  numberId: row.numberId,
  numberLabel: row.number.label,
  templateId: row.templateId,
  templateName: row.template.name,
  variableMapping: row.variableMapping as VariableMapping,
  status: row.status,
  pausedReason: (row.pausedReason as PauseReason | null) ?? null,
  last7Days,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class DateAutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Today in the company time zone. */
  async today(now = new Date()): Promise<string> {
    return companyClock(now, (await this.settings.get()).defaultTimezone).date;
  }

  private async last7(ids: string[]): Promise<Map<string, Last7>> {
    const map = new Map<string, Last7>(ids.map((id) => [id, { sent: 0, failed: 0, skipped: 0 }]));
    if (!ids.length) return map;
    const from = dayDate(addDays(await this.today(), -6));
    const rows = await this.prisma.dateAutomationOccurrence.groupBy({
      by: ['automationId', 'status'],
      where: { automationId: { in: ids }, dueDate: { gte: from }, status: { in: ['SENT', 'FAILED', 'SKIPPED'] } },
      _count: { _all: true },
    });
    for (const r of rows) {
      const entry = map.get(r.automationId)!;
      if (r.status === 'SENT') entry.sent = r._count._all;
      else if (r.status === 'FAILED') entry.failed = r._count._all;
      else entry.skipped = r._count._all;
    }
    return map;
  }

  async list() {
    const rows = await this.prisma.dateAutomation.findMany({ include, orderBy: { name: 'asc' } });
    const counts = await this.last7(rows.map((r) => r.id));
    return { items: rows.map((r) => toDto(r, counts.get(r.id)!)) };
  }

  private async row(id: string): Promise<Row> {
    const row = await this.prisma.dateAutomation.findUnique({ where: { id }, include });
    if (!row) throw AppError.notFound('Date automation not found');
    return row;
  }

  async get(id: string) {
    const row = await this.row(id);
    return toDto(row, (await this.last7([id])).get(id)!);
  }

  /** The attribute must be a DATE attribute (ATTRIBUTE_NOT_DATE). */
  private async assertDateAttribute(key: string): Promise<void> {
    const attribute = await this.prisma.attributeDefinition.findUnique({ where: { key }, select: { type: true } });
    if (attribute?.type !== 'DATE') throw AppError.validation('Choose a date attribute', [{ field: 'attributeKey', issue: attribute ? 'is not a date attribute' : 'was not found' }], 'ATTRIBUTE_NOT_DATE');
  }

  private async validate(input: DateAutomationInput): Promise<void> {
    await this.assertDateAttribute(input.attributeKey);
    const [number, template] = await Promise.all([
      this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { wabaId: true } }),
      this.prisma.template.findUnique({ where: { id: input.templateId }, select: { wabaId: true, variables: true } }),
    ]);
    if (!number) throw AppError.validation('Choose a WhatsApp number', [{ field: 'numberId', issue: 'was not found' }]);
    if (!template) throw AppError.validation('Choose a template', [{ field: 'templateId', issue: 'was not found' }]);
    if (template.wabaId !== number.wabaId) throw AppError.validation('Choose a template of the same WhatsApp account', [{ field: 'templateId', issue: 'belongs to another WhatsApp account' }]);
    const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
    const details: ErrorDetail[] = [
      ...unmappedVariables(variables, input.variableMapping).map((k) => ({ field: `variableMapping.${k}`, issue: 'needs a value' })),
      // No uploaded row or payment request exists for a date automation.
      ...Object.entries(input.variableMapping)
        .filter(([, s]) => s.source === 'column' || s.source === 'payment')
        .map(([k]) => ({ field: `variableMapping.${k}`, issue: 'use a contact field, an attribute, a global attribute or fixed text' })),
    ];
    if (details.length) throw AppError.validation('Map every template variable', details, 'VARIABLES_UNMAPPED');
  }

  private data(input: DateAutomationInput) {
    return {
      name: input.name,
      attributeKey: input.attributeKey,
      timing: input.timing,
      offsetDays: input.offsetDays,
      sendTime: input.sendTime,
      numberId: input.numberId,
      templateId: input.templateId,
      variableMapping: input.variableMapping as Prisma.InputJsonValue,
    };
  }

  async create(input: DateAutomationInput, actor: AuditActor) {
    await this.validate(input);
    try {
      const row = await this.prisma.dateAutomation.create({ data: { ...this.data(input), status: 'OFF', createdById: actor.userId ?? null }, include });
      await this.audit.record(actor, 'date_automation.created', { type: 'date_automation', id: row.id }, { name: row.name });
      return toDto(row, { sent: 0, failed: 0, skipped: 0 });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('Another date automation has this name', 'NAME_TAKEN');
      throw error;
    }
  }

  async update(id: string, input: DateAutomationInput, actor: AuditActor) {
    await this.row(id);
    await this.validate(input);
    try {
      await this.prisma.dateAutomation.update({ where: { id }, data: this.data(input) });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('Another date automation has this name', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'date_automation.updated', { type: 'date_automation', id }, { name: input.name });
    return this.get(id);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.row(id);
    await this.prisma.dateAutomation.delete({ where: { id } });
    await this.audit.record(actor, 'date_automation.deleted', { type: 'date_automation', id }, { name: row.name });
  }

  /** Switching on needs an approved template and a connected number with sending on; resuming never sends past days. */
  async switch(id: string, on: boolean, actor: AuditActor) {
    const row = await this.prisma.dateAutomation.findUnique({ where: { id }, include: { template: { select: { status: true } }, number: { select: { connectionStatus: true, sendingEnabled: true } } } });
    if (!row) throw AppError.notFound('Date automation not found');
    if (on) {
      if (row.template.status !== 'APPROVED') throw AppError.conflict('The template is not approved', 'TEMPLATE_NOT_APPROVED');
      if (row.number.connectionStatus !== 'CONNECTED') throw AppError.conflict('The WhatsApp number is not connected', 'NUMBER_NOT_CONNECTED');
      if (!row.number.sendingEnabled) throw AppError.conflict('Sending is turned off for this number', 'SENDING_OFF');
    }
    await this.prisma.dateAutomation.update({ where: { id }, data: { status: on ? 'ON' : 'OFF', pausedReason: null } });
    await this.audit.record(actor, 'date_automation.switched', { type: 'date_automation', id }, { on, from: row.status });
    return this.get(id);
  }

  /** How many contacts are due on each of the next 7 days for a rule. */
  async preview(rule: DateRule) {
    await this.assertDateAttribute(rule.attributeKey);
    const today = await this.today();
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    const counts = days.map((day, i) => Prisma.sql`count(*) FILTER (WHERE ${dueCondition(rule.attributeKey, rule.timing, rule.offsetDays, day)})::int AS ${Prisma.raw(`d${i}`)}`);
    const [row] = await this.prisma.$queryRaw<Array<Record<string, number>>>`SELECT ${Prisma.join(counts)} FROM contacts c WHERE (c.attributes ->> ${rule.attributeKey}) IS NOT NULL`;
    return { days: days.map((date, i) => ({ date, due: row?.[`d${i}`] ?? 0 })) };
  }

  /** Results per due day (FR-024): sends, statuses, the 009 replied definition, skips by reason. */
  async results(id: string, query: z.infer<typeof ResultsQuerySchema>) {
    await this.row(id);
    const today = await this.today();
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -29);
    const span = (dayDate(to).getTime() - dayDate(from).getTime()) / 86_400_000;
    if (span < 0 || span >= MAX_RANGE_DAYS) {
      throw AppError.validation('Choose a range of up to 92 days', [{ field: 'from', issue: 'must be on or before to, within 92 days' }], 'RANGE_INVALID');
    }
    const rows = await this.prisma.$queryRaw<Array<{ date: string; due: number; sent: number; delivered: number; read: number; replied: number; failed: number }>>`
      SELECT o.due_date::text AS date,
             count(*)::int AS due,
             count(*) FILTER (WHERE o.status = 'SENT' AND m.status IS DISTINCT FROM 'FAILED')::int AS sent,
             count(*) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
             count(*) FILTER (WHERE m.status = 'READ')::int AS read,
             count(*) FILTER (WHERE m.id IS NOT NULL AND ${DELIVERED} AND ${REPLIED})::int AS replied,
             count(*) FILTER (WHERE o.status = 'FAILED' OR m.status = 'FAILED')::int AS failed
        FROM date_automation_occurrences o
        LEFT JOIN messages m ON m.id = o.message_id
       WHERE o.automation_id = ${id}::uuid AND o.due_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY o.due_date
       ORDER BY o.due_date DESC`;
    const skips = await this.prisma.$queryRaw<Array<{ date: string; reason: string | null; n: number }>>`
      SELECT o.due_date::text AS date, o.reason, count(*)::int AS n
        FROM date_automation_occurrences o
       WHERE o.automation_id = ${id}::uuid AND o.status = 'SKIPPED' AND o.due_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY o.due_date, o.reason`;
    const skipped = new Map<string, Record<string, number>>();
    for (const s of skips) skipped.set(s.date, { ...(skipped.get(s.date) ?? {}), [s.reason ?? 'unknown']: s.n });
    return { days: rows.map((r) => ({ ...r, skipped: skipped.get(r.date) ?? {} })) };
  }

  /** The contacts due on one day and what happened (phones masked by role in the response interceptor). */
  async recipients(id: string, query: z.infer<typeof RecipientsQuerySchema>) {
    await this.row(id);
    const where = { automationId: id, dueDate: dayDate(query.date) };
    const [total, rows] = await Promise.all([
      this.prisma.dateAutomationOccurrence.count({ where }),
      this.prisma.dateAutomationOccurrence.findMany({
        where,
        include: { contact: { select: { name: true, phoneE164: true } }, message: { select: { status: true } } },
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((o) => ({ contactId: o.contactId, name: o.contact.name, phone: o.contact.phoneE164, status: o.status, reason: o.reason, messageStatus: o.message?.status ?? null })),
    };
  }
}

