import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { amountProblem, makeLinkCode, type PaymentSource } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest, PaymentSettings, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { PaymentGatewayService, type GatewayAccess } from '../gateway/payment-gateway.service.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';
import { PaymentEffects } from './payment-effects.js';
import { PaymentSessions } from './payment-sessions.js';
import { REQUEST_INCLUDE, eventPayment, requestDto, type RequestRow } from './payment-views.js';

// Payment requests (feature 008 US2, FR-006 – FR-016, research R2, R5,
// contracts/commerce-api.openapi.yaml tag payment-requests), the parts the worker shares: made at
// Stripe first (so nothing is sent when Stripe refuses or is down), read, listed and cancelled. Every
// source (live chat, flows, campaigns, the API, store and chat orders) uses `create`; the chat actions
// live in PaymentChatService (HTTP app only).

export const CreateRequestSchema = z
  .object({
    amountMinor: z.number().int().min(1),
    description: z.string().trim().min(1).max(250),
    reference: z.string().trim().max(80).optional(),
    expiresInMinutes: z.number().int().min(30).max(43_200).optional(),
    tagId: z.uuid().optional(),
    flowId: z.uuid().optional(),
  })
  .strict();
export type CreateRequestInput = z.infer<typeof CreateRequestSchema>;

export const ListRequestsSchema = z
  .object({
    status: z.enum(['WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED']).optional(),
    source: z.enum(['INBOX', 'FLOW', 'CAMPAIGN', 'API', 'STORE_ORDER', 'CHAT_ORDER']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    createdById: z.uuid().optional(),
    contactId: z.uuid().optional(),
    campaignId: z.uuid().optional(),
    reference: z.string().trim().max(80).optional(),
    includeTest: z.stringbool().optional(),
    /** The waiting test requests of a flow's test sessions (the flow editor's test panel, R13). */
    testFlowId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListRequestsQuery = z.infer<typeof ListRequestsSchema>;

/** What every source gives to make a request. */
export interface MakeRequest {
  access: GatewayAccess;
  settings: PaymentSettings;
  source: PaymentSource;
  amountMinor: number;
  description: string;
  reference?: string | null;
  expiresInMinutes: number;
  contactId: string | null;
  conversationId: string | null;
  phoneE164?: string | null;
  customerName?: string | null;
  createdById?: string | null;
  apiKeyId?: string | null;
  flowSessionId?: string | null;
  campaignId?: string | null;
  storeOrderId?: string | null;
  chatOrderId?: string | null;
  tagId?: string | null;
  flowId?: string | null;
  isTest?: boolean;
  /** Campaign requests get their session when first opened (R2). */
  lazySession?: boolean;
}

@Injectable()
export class PaymentRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly sessions: PaymentSessions,
    private readonly effects: PaymentEffects,
    private readonly audit: AuditService,
    private readonly events: PlatformEvents,
  ) {}

  /**
   * Makes a request: limits checked, the first Checkout Session made at Stripe (unless lazy), then the
   * row with its journey entry and `payment.requested` event. Sending is the caller's.
   */
  async create(input: MakeRequest): Promise<PaymentRequest> {
    const problem = amountProblem(input.amountMinor, input.access.currency, Number(input.settings.maxAmountMinor));
    if (problem === 'AMOUNT_INVALID') throw AppError.validation('Enter an amount', [{ field: 'amountMinor', issue: 'must be a positive whole number of minor units' }]);
    if (problem === 'AMOUNT_TOO_SMALL') throw AppError.validation('The amount is below the smallest payment Stripe takes', [{ field: 'amountMinor', issue: 'is too small' }], 'AMOUNT_TOO_SMALL');
    if (problem === 'AMOUNT_TOO_LARGE') throw AppError.validation('The amount is above the limit set in Payments > Settings', [{ field: 'amountMinor', issue: 'is too large' }], 'AMOUNT_TOO_LARGE');
    const id = uuidv7();
    const code = makeLinkCode(randomInt);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
    const session = input.lazySession
      ? null
      : await this.sessions.create(input.access, { requestId: id, code, amountMinor: input.amountMinor, currency: input.access.currency, description: input.description, reference: input.reference ?? null, expiresAt, sequence: 1 });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.paymentRequest.create({
        data: {
          id,
          code,
          contactId: input.contactId,
          conversationId: input.conversationId,
          phoneE164: input.phoneE164 ?? null,
          customerName: input.customerName ?? null,
          amountMinor: BigInt(input.amountMinor),
          currency: input.access.currency,
          description: input.description,
          reference: input.reference ?? null,
          expiresAt,
          status: 'WAITING',
          source: input.source,
          createdById: input.createdById ?? null,
          apiKeyId: input.apiKeyId ?? null,
          flowSessionId: input.flowSessionId ?? null,
          campaignId: input.campaignId ?? null,
          storeOrderId: input.storeOrderId ?? null,
          chatOrderId: input.chatOrderId ?? null,
          tagId: input.tagId ?? null,
          flowId: input.flowId ?? null,
          isTest: (input.isTest ?? false) || !input.access.livemode,
          sessionId: session?.id ?? null,
          sessionUrl: session?.url ?? null,
          sessionExpiresAt: session?.expiresAt ?? null,
          sessionsCreated: session ? 1 : 0,
        },
      });
      if (created.conversationId) {
        await tx.conversationEvent.create({
          data: {
            conversationId: created.conversationId,
            type: 'PAYMENT_REQUESTED',
            actorType: input.createdById ? 'MEMBER' : input.apiKeyId ? 'API_KEY' : input.flowSessionId ? 'FLOW' : 'SYSTEM',
            actorUserId: input.createdById ?? null,
            data: { paymentRequestId: created.id, amountMinor: input.amountMinor, currency: created.currency, description: created.description, source: created.source },
          },
        });
      }
      await this.events.payment(tx, 'payment.requested', { payment: eventPayment(created, this.effects.linkBase()), contactId: created.contactId });
      return created;
    });
    return row;
  }

  async get(id: string) {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!row) throw AppError.notFound('Payment request not found');
    const events = await this.prisma.paymentEvent.findMany({ where: { paymentRequestId: id }, orderBy: { receivedAt: 'asc' }, select: { type: true, result: true, source: true, receivedAt: true } });
    const delivery = await this.deliveryStatus(row);
    return {
      ...requestDto(row, this.effects.linkBase(), delivery === 'FAILED'),
      delivery,
      events: events.map((e) => ({ type: e.type, result: e.result, source: e.source, receivedAt: e.receivedAt.toISOString() })),
    };
  }

  async dto(id: string) {
    const row = await this.prisma.paymentRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
    return requestDto(row, this.effects.linkBase(), (await this.deliveryStatus(row)) === 'FAILED');
  }

  async list(query: ListRequestsQuery) {
    const where: Prisma.PaymentRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.createdById ? { createdById: query.createdById } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.reference ? { reference: query.reference } : {}),
      ...(query.includeTest ? {} : { isTest: false }),
      ...(query.testFlowId
        ? { isTest: true, source: 'FLOW' as const, flowSessionId: { in: (await this.prisma.flowSession.findMany({ where: { flowId: query.testFlowId, isTest: true }, select: { id: true }, orderBy: { startedAt: 'desc' }, take: 50 })).map((s) => s.id) } }
        : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}), ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00Z`).getTime() + 86_400_000) } : {}) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentRequest.findMany({ where, include: REQUEST_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.paymentRequest.count({ where }),
    ]);
    const failed = await this.failedDeliveries(rows);
    return { items: rows.map((r) => requestDto(r, this.effects.linkBase(), failed.has(r.id))), total };
  }

  /** GET /contacts/{id}/payments (FR-016); chat orders come with US6. */
  async forContact(contactId: string) {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } });
    if (!contact) throw AppError.notFound('Contact not found');
    const rows = await this.prisma.paymentRequest.findMany({ where: { contactId }, include: REQUEST_INCLUDE, orderBy: { createdAt: 'desc' }, take: 200 });
    const failed = await this.failedDeliveries(rows);
    return { requests: rows.map((r) => requestDto(r, this.effects.linkBase(), failed.has(r.id))), chatOrders: await this.chatOrdersOf(contactId) };
  }

  /**
   * POST /payments/requests/{id}/test-result (R13): drives a flow test session's payment step without
   * paying. Paid marks the test request paid; not paid cancels it; both resume the session.
   */
  async testResult(id: string, result: 'paid' | 'notPaid', actor: AuditActor) {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Payment request not found');
    if (!row.isTest || row.source !== 'FLOW') throw AppError.conflict('Only test requests from flow test sessions can be driven', 'NOT_TEST');
    if (row.status !== 'WAITING') throw AppError.conflict('The request is no longer waiting', 'NOT_WAITING');
    if (result === 'notPaid') return this.cancel(id, actor);
    const access = await this.gateway.access();
    const at = Math.floor(Date.now() / 1000);
    await this.effects.applyTo(
      id,
      { id: `test:${id}`, type: 'checkout.session.completed', livemode: access?.livemode ?? false, created: at, requestId: id, paymentIntentId: null, check: false, change: { kind: 'paid', at, amountMinor: Number(row.amountMinor), paymentIntentId: null, sessionId: row.sessionId ?? 'test' } },
      access?.livemode ?? false,
    );
    return this.dto(id);
  }

  /** Overridden by US6 to list chat orders; empty until then. */
  protected async chatOrdersOf(_contactId: string): Promise<unknown[]> {
    return [];
  }

  /** Cancel a waiting request (FR-014): its open session is expired at Stripe. Callers check who may. */
  async cancel(id: string, actor: AuditActor) {
    const existing = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Payment request not found');
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.paymentRequest.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'WAITING') throw AppError.conflict('Only waiting requests can be cancelled', 'NOT_WAITING');
      const updated = await tx.paymentRequest.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.userId ?? null, nextReminderAt: null, sessionExpirePending: Boolean(current.sessionId) },
      });
      await this.effects.ended(tx, updated, 'CANCELLED');
      return updated;
    });
    await this.audit.record(actor, 'payment_request.cancelled', { type: 'payment_request', id }, { amountMinor: Number(row.amountMinor), currency: row.currency, source: row.source });
    if (row.sessionId && (await this.sessions.closeSession(row))) {
      await this.prisma.paymentRequest.updateMany({ where: { id, sessionExpirePending: true }, data: { sessionExpirePending: false } });
    }
    await this.effects.afterEnded(row, 'CANCELLED');
    return this.dto(id);
  }

  /** The status of the message that carried the link: a failed one shows the request as not delivered. */
  private async deliveryStatus(row: Pick<RequestRow, 'chatItemId' | 'messageId'>): Promise<string | null> {
    if (row.chatItemId) {
      const item = await this.prisma.chatMessage.findUnique({ where: { id: row.chatItemId }, select: { kind: true, status: true, message: { select: { status: true } } } });
      if (item) return item.kind === 'SESSION_OUT' ? (item.status ?? null) : (item.message?.status ?? null);
    }
    if (row.messageId) return (await this.prisma.message.findUnique({ where: { id: row.messageId }, select: { status: true } }))?.status ?? null;
    return null;
  }

  private async failedDeliveries(rows: RequestRow[]): Promise<Set<string>> {
    const waiting = rows.filter((r) => r.status === 'WAITING');
    const itemIds = waiting.map((r) => r.chatItemId).filter((x): x is string => Boolean(x));
    if (!itemIds.length) return new Set();
    const items = await this.prisma.chatMessage.findMany({ where: { id: { in: itemIds } }, select: { id: true, kind: true, status: true, message: { select: { status: true } } } });
    const failedItems = new Set(items.filter((i) => (i.kind === 'SESSION_OUT' ? i.status : i.message?.status) === 'FAILED').map((i) => i.id));
    return new Set(waiting.filter((r) => r.chatItemId && failedItems.has(r.chatItemId)).map((r) => r.id));
  }
}
