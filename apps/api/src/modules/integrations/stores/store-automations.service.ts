import { Injectable } from '@nestjs/common';
import { CART_FIELDS, ORDER_FIELDS, STORE_VALUE_FIELDS, can, cartStepProblems, type MetaTemplateComponent, type Role } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { PageQuerySchema } from '../../../common/validation/pagination.js';
import type { Prisma, StoreAutomationKind } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { headerMediaType } from '../../sending/template-payload.builder.js';
import { STORE_AUTOMATION_KINDS } from './store-connections.service.js';

// Store automations (feature 006 US4 - US6, FR-029, FR-033, FR-034, FR-039): settings with checks,
// results with skip reasons, and the orders list (phones masked without phones.full).

const OrderSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('order'), key: z.enum(STORE_VALUE_FIELDS) }).strict(),
  z.object({ source: z.literal('field'), key: z.enum(['name', 'phone']) }).strict(),
  z.object({ source: z.literal('static'), value: z.string().max(1024) }).strict(),
]);

const StepSchema = z
  .object({
    templateId: z.uuid(),
    variableMapping: z.record(z.string().max(60), OrderSourceSchema),
    waitMinutes: z.number().int().min(30).max(10080).optional(),
  })
  .strict();

const CodSettingsSchema = z
  .object({
    confirmedReply: z.string().trim().max(1000),
    cancelledReply: z.string().trim().max(1000),
    alreadyAnsweredReply: z.string().trim().max(1000),
    reminderMinutes: z.number().int().min(30).max(1440),
    finalMinutes: z.number().int().min(60).max(4320),
    autoCancel: z.boolean(),
  })
  .partial()
  .strict();

export const AutomationInputSchema = z
  .object({ enabled: z.boolean(), steps: z.array(StepSchema).min(1).max(3), settings: CodSettingsSchema.optional() })
  .strict();
export type AutomationInput = z.infer<typeof AutomationInputSchema>;

export const KindSchema = z.enum(STORE_AUTOMATION_KINDS);
export const OrdersQuerySchema = PageQuerySchema.extend({ codStatus: z.enum(['ASKED', 'CONFIRMED', 'CANCELLED', 'NO_ANSWER', 'CLOSED']).optional() }).strict();
export type OrdersQuery = z.infer<typeof OrdersQuerySchema>;
export const ResultsQuerySchema = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).strict();
export type StoreResultsQuery = z.infer<typeof ResultsQuerySchema>;

type Problem = { code: string; message: string };
type Step = z.infer<typeof StepSchema>;

@Injectable()
export class StoreAutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async store(id: string) {
    const store = await this.prisma.storeConnection.findUnique({ where: { id }, select: { id: true, numberId: true, platform: true } });
    if (!store) throw AppError.notFound('Store not found');
    return store;
  }

  async get(storeId: string, kind: StoreAutomationKind) {
    const store = await this.store(storeId);
    const row = await this.prisma.storeAutomation.findUnique({ where: { storeId_kind: { storeId, kind } } });
    const steps = ((row?.steps as unknown as Step[]) ?? []) as Step[];
    return {
      kind,
      enabled: row?.enabled ?? false,
      steps,
      settings: (row?.settings ?? {}) as Record<string, unknown>,
      problems: steps.length ? await this.problems(store.numberId, kind, steps) : [],
    };
  }

  async put(storeId: string, kind: StoreAutomationKind, input: AutomationInput, actor: AuditActor & { userId: string }) {
    const store = await this.store(storeId);
    if (kind !== 'CART_REMINDER' && input.steps.length !== 1) throw AppError.validation('This automation sends one message', [{ field: 'steps', issue: 'must have exactly one step' }]);
    if (kind === 'CART_REMINDER' && input.steps.some((s) => s.waitMinutes === undefined)) {
      throw AppError.validation('Each cart reminder needs its wait', [{ field: 'steps', issue: 'each step needs waitMinutes' }]);
    }
    const problems = await this.problems(store.numberId, kind, input.steps);
    if (input.enabled && problems.length) throw AppError.validation('Fix these problems before turning it on', problems.map((p) => ({ field: 'steps', issue: p.message })));
    await this.prisma.storeAutomation.upsert({
      where: { storeId_kind: { storeId, kind } },
      create: { storeId, kind, enabled: input.enabled, steps: input.steps as Prisma.InputJsonValue, settings: (input.settings ?? {}) as Prisma.InputJsonValue, updatedById: actor.userId },
      update: { enabled: input.enabled, steps: input.steps as Prisma.InputJsonValue, ...(input.settings ? { settings: input.settings as Prisma.InputJsonValue } : {}), updatedById: actor.userId },
    });
    await this.audit.record(actor, 'store_automation.updated', { type: 'store', id: storeId }, { kind, enabled: input.enabled, steps: input.steps.length });
    return this.get(storeId, kind);
  }

  /** Each step's template must be approved, of the store number's account, and fully mapped. */
  private async problems(numberId: string, kind: StoreAutomationKind, steps: Step[]): Promise<Problem[]> {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { wabaId: true } });
    const templates = await this.prisma.template.findMany({ where: { id: { in: steps.map((s) => s.templateId) } }, select: { id: true, name: true, status: true, category: true, wabaId: true, variables: true, components: true } });
    // Order fields for order messages, cart fields for cart reminders.
    const fields: readonly string[] = kind === 'CART_REMINDER' ? CART_FIELDS : ORDER_FIELDS;
    const problems: Problem[] = [];
    steps.forEach((step, index) => {
      const label = steps.length > 1 ? `Message ${index + 1}: ` : '';
      const template = templates.find((t) => t.id === step.templateId);
      if (!template) return problems.push({ code: 'TEMPLATE_MISSING', message: `${label}the template no longer exists` });
      if (template.status !== 'APPROVED') problems.push({ code: 'TEMPLATE_NOT_APPROVED', message: `${label}the template ${template.name} is not approved` });
      if (number && template.wabaId !== number.wabaId) problems.push({ code: 'TEMPLATE_OTHER_ACCOUNT', message: `${label}the template belongs to another WhatsApp account than the store's number` });
      if (headerMediaType(template.components as unknown as MetaTemplateComponent[])) {
        problems.push({ code: 'MEDIA_HEADER', message: `${label}templates with an image, video or document header cannot be used here yet` });
      }
      if (kind === 'COD_CONFIRMATION') {
        const buttons = (template.components as unknown as Array<{ type: string; buttons?: Array<{ type: string }> }>).find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
        if (buttons.length < 2 || buttons[0]?.type !== 'QUICK_REPLY' || buttons[1]?.type !== 'QUICK_REPLY') {
          problems.push({ code: 'COD_BUTTONS', message: 'The template needs two quick-reply buttons first: confirm, then cancel' });
        }
      }
      const variables = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
      for (const v of variables) if (!step.variableMapping[v]) problems.push({ code: 'MAPPING', message: `${label}${v} has no value source` });
      for (const v of Object.keys(step.variableMapping)) if (!variables.includes(v)) problems.push({ code: 'MAPPING', message: `${label}${v} is not a variable of the template` });
      for (const [v, source] of Object.entries(step.variableMapping)) {
        if (source.source === 'order' && !fields.includes(source.key)) problems.push({ code: 'MAPPING', message: `${label}${v}: "${source.key}" is not available here` });
      }
      if (kind === 'CART_REMINDER' && template.category !== 'MARKETING') problems.push({ code: 'NOT_MARKETING', message: `${label}cart reminders are marketing messages: use a Marketing template` });
      return undefined;
    });
    if (kind === 'CART_REMINDER') for (const message of cartStepProblems(steps)) problems.push({ code: 'WAITS', message });
    return problems;
  }

  /** Orders (or carts) with this kind of message: sent, delivered, read, failed and skipped with reasons. */
  async results(storeId: string, kind: StoreAutomationKind, query: StoreResultsQuery) {
    await this.store(storeId);
    const from = query.from ? new Date(`${query.from}T00:00:00Z`) : new Date(0);
    const to = query.to ? new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) : new Date('9999-12-31T00:00:00Z');
    const [counts] = await this.prisma.$queryRaw<Array<Record<string, number>>>`
      SELECT count(*)::int AS orders,
             (count(*) FILTER (WHERE m.outcome = 'QUEUED'))::int AS queued,
             (count(*) FILTER (WHERE msg.status IN ('SENT', 'DELIVERED', 'READ')))::int AS sent,
             (count(*) FILTER (WHERE msg.status IN ('DELIVERED', 'READ')))::int AS delivered,
             (count(*) FILTER (WHERE msg.status = 'READ'))::int AS read,
             (count(*) FILTER (WHERE msg.status = 'FAILED'))::int AS failed,
             (count(*) FILTER (WHERE m.outcome = 'SKIPPED'))::int AS skipped
        FROM store_order_messages m
        JOIN store_orders o ON o.id = m.order_id
        LEFT JOIN messages msg ON msg.id = m.message_id
       WHERE o.store_id = ${storeId}::uuid AND m.kind = ${kind}::"StoreMessageKind"
         AND coalesce(m.skip_reason, '') <> 'off' AND m.created_at >= ${from} AND m.created_at < ${to}`;
    const reasons = await this.prisma.$queryRaw<Array<{ reason: string; n: number }>>`
      SELECT m.skip_reason AS reason, count(*)::int AS n
        FROM store_order_messages m
        JOIN store_orders o ON o.id = m.order_id
       WHERE o.store_id = ${storeId}::uuid AND m.kind = ${kind}::"StoreMessageKind" AND m.outcome = 'SKIPPED'
         AND m.skip_reason IS NOT NULL AND m.skip_reason <> 'off' AND m.created_at >= ${from} AND m.created_at < ${to}
       GROUP BY 1`;
    // COD adds the answers (FR-038).
    const cod =
      kind === 'COD_CONFIRMATION'
        ? (
            await this.prisma.$queryRaw<Array<Record<string, number>>>`
              SELECT (count(*) FILTER (WHERE cod_asked_at IS NOT NULL))::int AS asked,
                     (count(*) FILTER (WHERE cod_status = 'CONFIRMED'))::int AS confirmed,
                     (count(*) FILTER (WHERE cod_status = 'CANCELLED'))::int AS cancelled,
                     (count(*) FILTER (WHERE cod_status = 'NO_ANSWER'))::int AS "notConfirmed",
                     (count(*) FILTER (WHERE cod_status = 'CLOSED'))::int AS closed
                FROM store_orders
               WHERE store_id = ${storeId}::uuid AND cod_asked_at >= ${from} AND cod_asked_at < ${to}`
          )[0]
        : undefined;
    return { kind, counts: { ...(counts ?? {}), ...(cod ?? {}) }, skipReasons: Object.fromEntries(reasons.map((r) => [r.reason, r.n])) };
  }

  async orders(storeId: string, query: OrdersQuery, role: Role) {
    await this.store(storeId);
    const where: Prisma.StoreOrderWhereInput = { storeId, ...(query.codStatus ? { codStatus: query.codStatus } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.storeOrder.count({ where }),
      this.prisma.storeOrder.findMany({
        where,
        include: {
          contact: { select: { id: true, name: true, phoneE164: true } },
          messages: { where: { NOT: { skipReason: 'off' } }, include: { message: { select: { status: true } } }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const full = can(role, 'phones.full');
    return {
      total,
      items: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        contact: o.contact ? { id: o.contact.id, name: o.contact.name, phone: full ? o.contact.phoneE164 : maskPhone(o.contact.phoneE164) } : null,
        total: o.total.toFixed(2),
        currency: o.currency,
        paymentKind: o.paymentKind,
        status: o.status,
        codStatus: o.codStatus,
        placedAt: o.placedAt.toISOString(),
        messages: o.messages.map((m) => ({ kind: m.kind, outcome: m.outcome, skipReason: m.skipReason, status: m.message?.status ?? null })),
      })),
    };
  }
}
