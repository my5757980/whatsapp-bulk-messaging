import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FlowSessionService } from '../../flows/engine/session.service.js';
import { buildCart, type CartItemInput } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { ChatOrder, PaymentRequest, Prisma } from '../../../generated/prisma/client.js';
import type { AuditActor } from '../../audit/audit.service.js';
import { isLive } from '../../inbox/conversations/window.js';
import type { ChatOrdersPort, InboundOrder } from '../../inbox/inbound/chat-orders.port.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { PaymentGatewayService } from '../../payments/gateway/payment-gateway.service.js';
import { PaymentEffects, type PaymentChange } from '../../payments/requests/payment-effects.js';
import { PaymentRequestsService } from '../../payments/requests/payment-requests.service.js';
import { PaymentSender } from '../../payments/requests/payment-sender.js';
import { PaymentSettingsService } from '../../payments/settings/payment-settings.service.js';

// Carts sent in chat become chat orders (feature 008 US6, FR-026 – FR-029, research R11): items with
// names from the catalog copy, the cart's own prices and total, and warnings (not in the catalog,
// currency, mixed currencies, changed price). Automatic mode sends the payment link at once when there
// is no warning; review mode waits for an agent to edit, send the link or cancel. The order follows its
// request: paid, expired, cancelled and refunded.

export const EditOrderSchema = z
  .object({ items: z.array(z.object({ retailerId: z.string().trim().min(1).max(100), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(30) })
  .strict();
export const SendLinkSchema = z.object({ expiresInMinutes: z.number().int().min(30).max(43_200).optional() }).strict().optional().transform((v) => v ?? {});
export const ListOrdersSchema = z
  .object({
    status: z.enum(['RECEIVED', 'LINK_SENT', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

type StoredItem = { retailerId: string; name: string | null; quantity: number; itemPriceMinor: number; currency: string };
type Warning = { kind: string; retailerId?: string; detail?: string };

function orderDto(row: ChatOrder & { paymentRequests?: Array<Pick<PaymentRequest, 'id' | 'createdAt'>> }) {
  const latest = [...(row.paymentRequests ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    id: row.id,
    contactId: row.contactId,
    conversationId: row.conversationId,
    customerText: row.customerText,
    items: (Array.isArray(row.items) ? row.items : []) as StoredItem[],
    currency: row.currency,
    totalMinor: Number(row.totalMinor),
    warnings: (Array.isArray(row.warnings) ? row.warnings : []) as Warning[],
    mode: row.mode,
    status: row.status,
    paymentRequestId: latest?.id ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const WITH_REQUESTS = { paymentRequests: { select: { id: true, createdAt: true } } } as const;

@Injectable()
export class ChatOrderService implements ChatOrdersPort, OnModuleInit {
  private readonly logger = new Logger(ChatOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly sender: PaymentSender,
    private readonly effects: PaymentEffects,
    private readonly journey: JourneyService,
    private readonly events: PlatformEvents,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.effects.registerHook((request, changes) => this.mirror(request, changes));
  }

  /** An inbound cart (from the inbound job). */
  async received(input: InboundOrder): Promise<void> {
    const raw = (Array.isArray(input.payload.items) ? input.payload.items : []) as CartItemInput[];
    if (!raw.length) return;
    const copies = await this.prisma.catalogProduct.findMany({ where: { retailerId: { in: raw.map((i) => i.retailerId) } } });
    const byId = new Map(copies.map((c) => [c.retailerId, c]));
    const access = await this.gateway.access();
    const cart = buildCart(raw, (id) => {
      const c = byId.get(id);
      return c ? { name: c.name, priceMinor: c.salePriceMinor !== null ? Number(c.salePriceMinor) : c.priceMinor !== null ? Number(c.priceMinor) : null, currency: c.currency, removed: c.removedAt !== null } : undefined;
    }, access?.currency ?? 'aed');
    const settings = await this.settings.row();
    // A flow waiting for a cart (US8) takes it: no automatic link, the flow's payment step charges it.
    const session = await this.prisma.flowSession.findFirst({ where: { conversationId: input.conversationId, status: 'RUNNING', wait: 'ORDER' }, select: { id: true, waitToken: true } });
    const mode = session ? ('FLOW' as const) : settings.chatOrderMode;
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chatOrder.create({
        data: {
          contactId: input.contactId,
          conversationId: input.conversationId,
          chatItemId: input.chatItemId,
          catalogId: (typeof input.payload.catalogId === 'string' ? input.payload.catalogId : '').slice(0, 40),
          customerText: input.text?.slice(0, 1000) ?? null,
          items: cart.items as unknown as Prisma.InputJsonValue,
          currency: cart.currency,
          totalMinor: BigInt(cart.totalMinor),
          warnings: cart.warnings as unknown as Prisma.InputJsonValue,
          mode,
        },
      });
      // The chat item shows the order card.
      await tx.chatMessage.update({ where: { id: input.chatItemId }, data: { payload: { ...input.payload, chatOrderId: created.id } as Prisma.InputJsonValue } });
      await this.events.chatOrder(tx, 'chat_order.received', { order: orderDto(created), contactId: created.contactId });
      return created;
    });
    await this.journey.recordForContact(input.contactId, { type: 'CHAT_ORDER_RECEIVED', actorType: 'CUSTOMER', data: { chatOrderId: order.id, totalMinor: cart.totalMinor, currency: cart.currency, items: cart.items.length } });
    if (session) {
      const sessions = this.moduleRef.get(FlowSessionService, { strict: false });
      await sessions.resume(session.id, { kind: 'order', token: session.waitToken, cart: { chatOrderId: order.id, totalMinor: cart.totalMinor, currency: cart.currency, items: cart.items } });
      return;
    }
    if (settings.chatOrderMode === 'AUTO' && !cart.warnings.length && access?.row.status === 'CONNECTED') {
      try {
        await this.sendLink(order.id, null);
      } catch (error) {
        this.logger.warn({ chatOrderId: order.id, err: error }, 'The automatic payment link for a chat order was not sent');
      }
    }
  }

  async get(id: string) {
    const row = await this.prisma.chatOrder.findUnique({ where: { id }, include: WITH_REQUESTS });
    if (!row) throw AppError.notFound('Chat order not found');
    return orderDto(row);
  }

  async list(query: z.infer<typeof ListOrdersSchema>) {
    const where: Prisma.ChatOrderWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.chatOrder.findMany({ where, include: WITH_REQUESTS, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.chatOrder.count({ where }),
    ]);
    return { items: rows.map(orderDto), total };
  }

  /** PATCH: quantities and removals before the link is sent (FR-027). */
  async edit(id: string, items: Array<{ retailerId: string; quantity: number }>, userId: string) {
    const row = await this.prisma.chatOrder.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Chat order not found');
    if (row.status !== 'RECEIVED') throw AppError.conflict('The payment link was already sent; the order cannot be changed', 'NOT_EDITABLE');
    const current = (Array.isArray(row.items) ? row.items : []) as StoredItem[];
    const unknown = items.filter((i) => !current.some((c) => c.retailerId === i.retailerId));
    if (unknown.length) throw AppError.validation('Only items of the cart can be kept', unknown.map((i) => ({ field: i.retailerId, issue: 'is not in this order' })));
    const next = items.map((i) => ({ ...current.find((c) => c.retailerId === i.retailerId)!, quantity: i.quantity }));
    const totalMinor = next.filter((i) => i.currency === row.currency).reduce((sum, i) => sum + i.quantity * i.itemPriceMinor, 0);
    const kept = new Set(next.map((i) => i.retailerId));
    const warnings = ((Array.isArray(row.warnings) ? row.warnings : []) as Warning[]).filter((w) => !w.retailerId || kept.has(w.retailerId));
    const updated = await this.prisma.chatOrder.update({
      where: { id },
      data: { items: next as unknown as Prisma.InputJsonValue, totalMinor: BigInt(totalMinor), warnings: warnings as unknown as Prisma.InputJsonValue, editedById: userId },
      include: WITH_REQUESTS,
    });
    return orderDto(updated);
  }

  /** POST send-link: a CHAT_ORDER request for the total, sent in the window or with the payment template. */
  async sendLink(id: string, userId: string | null, expiresInMinutes?: number) {
    const row = await this.prisma.chatOrder.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Chat order not found');
    if (row.status !== 'RECEIVED') throw AppError.conflict('The payment link was already sent or the order is closed', 'NOT_EDITABLE');
    const access = await this.gateway.requireReady();
    if (row.currency !== access.currency) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'CURRENCY_MISMATCH', `The order is in ${row.currency.toUpperCase()}, payments are in ${access.currency.toUpperCase()}`);
    if (!row.conversationId) throw AppError.conflict('The chat of this order was deleted', 'NOT_EDITABLE');
    const chat = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: row.conversationId },
      select: { id: true, numberId: true, lastCustomerMessageAt: true, contact: { select: { id: true, name: true, phoneE164: true } }, number: { select: { wabaId: true } } },
    });
    const settings = await this.settings.row();
    const live = isLive(chat.lastCustomerMessageAt);
    const template = live ? null : await this.sender.paymentTemplate(settings, chat.number.wabaId);
    if (!live && !template) throw AppError.conflict('The 24-hour window is closed and no payment template is set', 'WINDOW_CLOSED_NO_TEMPLATE');
    const items = (Array.isArray(row.items) ? row.items : []) as StoredItem[];
    const request = await this.requests.create({
      access,
      settings,
      source: 'CHAT_ORDER',
      amountMinor: Number(row.totalMinor),
      description: `Order of ${items.reduce((n, i) => n + i.quantity, 0)} item${items.length === 1 && items[0]?.quantity === 1 ? '' : 's'}`.slice(0, 250),
      expiresInMinutes: expiresInMinutes ?? settings.chatOrderExpiryMinutes,
      contactId: chat.contact?.id ?? row.contactId,
      conversationId: chat.id,
      phoneE164: chat.contact?.phoneE164 ?? null,
      customerName: chat.contact?.name ?? null,
      createdById: userId,
      chatOrderId: row.id,
      tagId: settings.chatOrderTagId,
    });
    if (live) await this.sender.automatic(chat.id, chat.numberId, request, settings);
    else await this.sender.template({ conversationId: chat.id, numberId: chat.numberId, contactId: chat.contact!.id }, request, template!, settings.templateMapping, { automatic: !userId, sentByUserId: userId });
    const updated = await this.prisma.chatOrder.update({ where: { id }, data: { status: 'LINK_SENT' }, include: WITH_REQUESTS });
    return orderDto(updated);
  }

  /** POST cancel: the order and its waiting request. */
  async cancel(id: string, actor: AuditActor) {
    const row = await this.prisma.chatOrder.findUnique({ where: { id }, include: WITH_REQUESTS });
    if (!row) throw AppError.notFound('Chat order not found');
    if (row.status !== 'RECEIVED' && row.status !== 'LINK_SENT') throw AppError.conflict('A paid, expired or cancelled order cannot be cancelled', 'NOT_CANCELLABLE');
    await this.prisma.chatOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.userId ?? null } });
    const waiting = await this.prisma.paymentRequest.findMany({ where: { chatOrderId: id, status: 'WAITING' }, select: { id: true } });
    for (const request of waiting) await this.requests.cancel(request.id, actor);
    return this.get(id);
  }

  /** The order follows its request. */
  private async mirror(request: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    if (!request.chatOrderId) return;
    const status = changes.includes('PAID') ? 'PAID' : changes.includes('REFUNDED') ? 'REFUNDED' : changes.includes('EXPIRED') ? 'EXPIRED' : changes.includes('CANCELLED') ? 'CANCELLED' : null;
    if (!status) return;
    const from = status === 'PAID' ? ['RECEIVED', 'LINK_SENT', 'EXPIRED'] : status === 'REFUNDED' ? ['PAID'] : ['LINK_SENT'];
    const { count } = await this.prisma.chatOrder.updateMany({ where: { id: request.chatOrderId, status: { in: from as Array<'RECEIVED' | 'LINK_SENT' | 'EXPIRED' | 'PAID'> } }, data: { status } });
    if (count && status === 'PAID') {
      const order = await this.prisma.chatOrder.findUniqueOrThrow({ where: { id: request.chatOrderId }, include: WITH_REQUESTS });
      await this.events.chatOrder(this.prisma, 'chat_order.paid', { order: orderDto(order), contactId: order.contactId });
    }
  }
}

const viewerUser = (user: RequestUser, req: AuthedRequest) => ({ userId: user.id, ip: clientIp(req) ?? null });

/** /chat-orders (contracts/commerce-api.openapi.yaml tag chat-orders). */
@Controller('chat-orders')
export class ChatOrdersController {
  constructor(private readonly orders: ChatOrderService) {}

  @Get()
  @Require('inbox.view')
  list(@Query(new ZodValidationPipe(ListOrdersSchema)) query: z.infer<typeof ListOrdersSchema>) {
    return this.orders.list(query);
  }

  @Get(':id')
  @Require('inbox.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }

  @Patch(':id')
  @Require('inbox.reply')
  edit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EditOrderSchema)) body: z.infer<typeof EditOrderSchema>, @CurrentUser() user: RequestUser) {
    return this.orders.edit(id, body.items, user.id);
  }

  @Post(':id/send-link')
  @Require('inbox.reply')
  sendLink(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SendLinkSchema)) body: { expiresInMinutes?: number }, @CurrentUser() user: RequestUser) {
    return this.orders.sendLink(id, user.id, body.expiresInMinutes);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Require('inbox.reply')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.orders.cancel(id, viewerUser(user, req));
  }
}

