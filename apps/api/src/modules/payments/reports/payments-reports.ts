import { Controller, Get, Injectable, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';

// The payments page (feature 008 US4, FR-019, FR-020, contracts/commerce-api.openapi.yaml tag
// payments-reports): totals by status, day (the company time zone) and source for a period, test
// requests left out, and the CSV export (phones masked without phones.full; audited).

const SOURCES = ['INBOX', 'FLOW', 'CAMPAIGN', 'API', 'STORE_ORDER', 'CHAT_ORDER'] as const;
const STATUSES = ['WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

const PeriodSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((p) => p.from <= p.to, { message: 'from must not be after to', path: ['from'] })
  .refine((p) => (Date.parse(p.to) - Date.parse(p.from)) / DAY_MS < MAX_DAYS, { message: `at most ${MAX_DAYS} days`, path: ['to'] });

export const SummaryQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), source: z.enum(SOURCES).optional(), createdById: z.uuid().optional() })
  .strict()
  .superRefine((q, ctx) => {
    const period = PeriodSchema.safeParse(q);
    if (!period.success) for (const issue of period.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });
export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;

export const ExportQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), status: z.enum(STATUSES).optional(), source: z.enum(SOURCES).optional() })
  .strict()
  .superRefine((q, ctx) => {
    const period = PeriodSchema.safeParse(q);
    if (!period.success) for (const issue of period.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

export interface Totals {
  requestedMinor: number;
  requestedCount: number;
  paidMinor: number;
  paidCount: number;
  waitingMinor: number;
  waitingCount: number;
  expiredMinor: number;
  expiredCount: number;
  refundedMinor: number;
  refundedCount: number;
}

const empty = (): Totals => ({ requestedMinor: 0, requestedCount: 0, paidMinor: 0, paidCount: 0, waitingMinor: 0, waitingCount: 0, expiredMinor: 0, expiredCount: 0, refundedMinor: 0, refundedCount: 0 });

interface Group {
  day: string;
  source: (typeof SOURCES)[number];
  status: (typeof STATUSES)[number];
  n: number;
  amount: bigint;
  paid: bigint;
  refunded: bigint;
  refunded_n: number;
}

function add(target: Totals, g: Group): void {
  const amount = Number(g.amount);
  target.requestedMinor += amount;
  target.requestedCount += g.n;
  if (g.status === 'PAID' || g.status === 'REFUNDED') {
    target.paidMinor += Number(g.paid);
    target.paidCount += g.n;
  }
  if (g.status === 'WAITING') {
    target.waitingMinor += amount;
    target.waitingCount += g.n;
  }
  if (g.status === 'EXPIRED') {
    target.expiredMinor += amount;
    target.expiredCount += g.n;
  }
  target.refundedMinor += Number(g.refunded);
  target.refundedCount += g.refunded_n;
}

/** Every day of the period, as YYYY-MM-DD. */
function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

@Injectable()
export class PaymentsReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
  ) {}

  private async zone(): Promise<string> {
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    return settings?.defaultTimezone ?? 'UTC';
  }

  /** GET /payments/summary (FR-019). */
  async summary(query: SummaryQuery) {
    const zone = await this.zone();
    const rows = await this.prisma.$queryRaw<Group[]>`
      SELECT to_char(timezone(${zone}, created_at)::date, 'YYYY-MM-DD') AS day, source::text AS source, status::text AS status,
             COUNT(*)::int AS n,
             COALESCE(SUM(amount_minor), 0)::bigint AS amount,
             COALESCE(SUM(COALESCE(paid_amount_minor, amount_minor)) FILTER (WHERE status IN ('PAID', 'REFUNDED')), 0)::bigint AS paid,
             COALESCE(SUM(refunded_minor), 0)::bigint AS refunded,
             (COUNT(*) FILTER (WHERE refunded_minor > 0))::int AS refunded_n
        FROM payment_requests
       WHERE is_test = false
         AND created_at >= timezone(${zone}, ${query.from}::date::timestamp)
         AND created_at < timezone(${zone}, (${query.to}::date + 1)::timestamp)
         ${query.source ? Prisma.sql`AND source = ${query.source}::"PaymentSource"` : Prisma.empty}
         ${query.createdById ? Prisma.sql`AND created_by_id = ${query.createdById}::uuid` : Prisma.empty}
       GROUP BY 1, 2, 3`;
    const totals = empty();
    const days = new Map(daysOf(query.from, query.to).map((day) => [day, empty()]));
    const sources = new Map<string, Totals>();
    for (const g of rows) {
      add(totals, g);
      const day = days.get(g.day);
      if (day) add(day, g);
      const source = sources.get(g.source) ?? empty();
      add(source, g);
      sources.set(g.source, source);
    }
    const access = await this.gateway.access();
    return {
      currency: access?.currency ?? 'aed',
      totals,
      days: [...days.entries()].map(([day, t]) => ({ day, ...t })),
      sources: SOURCES.filter((s) => sources.has(s)).map((source) => ({ source, ...sources.get(source)! })),
    };
  }

  /** The export's rows in pages of 1,000, oldest first (FR-020). */
  async *exportRows(query: ExportQuery, zone: string) {
    let cursor: string | null = null;
    for (;;) {
      const page: Array<Prisma.PaymentRequestGetPayload<{ include: { createdBy: { select: { name: true } } } }>> = await this.prisma.paymentRequest.findMany({
        where: {
          isTest: false,
          createdAt: { gte: this.localStart(query.from, zone), lt: this.localStart(this.nextDay(query.to), zone) },
          ...(query.status ? { status: query.status } : {}),
          ...(query.source ? { source: query.source } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: { createdBy: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      if (!page.length) return;
      cursor = page[page.length - 1]!.id;
      yield page;
    }
  }

  private nextDay(day: string): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  }

  /** Midnight of a day in the company time zone, as an instant. */
  localStart(day: string, zone: string): Date {
    const utc = Date.parse(`${day}T00:00:00Z`);
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utc));
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
      const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      return new Date(utc - (asLocal - utc));
    } catch {
      return new Date(utc);
    }
  }

  async exportZone(): Promise<string> {
    return this.zone();
  }
}

const NEWLINE = '\n';

/** GET /payments/summary and /payments/export.csv. */
@Controller('payments')
export class PaymentsReportsController {
  constructor(
    private readonly reports: PaymentsReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('summary')
  @Require('payments.view')
  summary(@Query(new ZodValidationPipe(SummaryQuerySchema)) query: SummaryQuery) {
    return this.reports.summary(query);
  }

  @Get('export.csv')
  @Require('data.export')
  async export(@Query(new ZodValidationPipe(ExportQuerySchema)) query: ExportQuery, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    if (!can(user.role, 'payments.view')) throw AppError.forbidden('Payments are not available to your role');
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'payments.exported', { type: 'payments', id: null }, { from: query.from, to: query.to, status: query.status ?? null, source: query.source ?? null });
    const fullPhones = can(user.role, 'phones.full');
    const zone = await this.reports.exportZone();
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="payments-${query.from}-to-${query.to}.csv"`);
    res.write(`created_at,reference,description,amount_minor,currency,status,source,customer_name,phone,paid_at,paid_late,refunded_minor,failed_attempts,created_by,chat_order_id,test${NEWLINE}`);
    for await (const page of this.reports.exportRows(query, zone)) {
      const chunk = page
        .map((r) =>
          [
            r.createdAt.toISOString(),
            r.reference ?? '',
            r.description,
            String(r.amountMinor),
            r.currency,
            r.status,
            r.source,
            r.customerName ?? '',
            fullPhones ? (r.phoneE164 ?? '') : (maskPhone(r.phoneE164) ?? ''),
            r.paidAt?.toISOString() ?? '',
            r.paidLate ? 'yes' : 'no',
            String(r.refundedMinor),
            String(r.failedAttempts),
            r.createdBy?.name ?? '',
            r.chatOrderId ?? '',
            r.isTest ? 'yes' : 'no',
          ]
            .map(csvField)
            .join(','),
        )
        .join(NEWLINE);
      if (!res.write(`${chunk}${NEWLINE}`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }
}
