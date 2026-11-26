import { Body, Controller, Get, Headers, HttpStatus, Injectable, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../../../common/auth/public.decorator.js';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import { ContactsService } from '../../contacts/contacts.service.js';
import { isLive } from '../../inbox/conversations/window.js';
import { ApiKeyGuard, type ApiRequest } from '../../public-api/api-key.guard.js';
import { RequireScope } from '../../public-api/api-scope.decorator.js';
import { answerOnce, keyOf } from '../../public-api/public-contacts.controller.js';
import { IdempotentResponses } from '../../public-api/idempotent-responses.service.js';
import { RateLimitGuard } from '../../public-api/rate-limit.guard.js';
import { SettingsService } from '../../settings/settings.service.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PaymentEffects } from '../requests/payment-effects.js';
import { PaymentRequestsService } from '../requests/payment-requests.service.js';
import { PaymentSender } from '../requests/payment-sender.js';
import { payUrl } from '../requests/payment-views.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';

// Payment requests through the public API (feature 008 US3, FR-010, contracts/public-payments-v1.openapi.yaml):
// make one for a phone number and send it (in the window as a Pay now message, otherwise with the
// payment template), read it back by id, reference or phone, and cancel it. POSTs need Idempotency-Key.

export const PublicPaymentSchema = z
  .object({
    phone: z.string().trim().min(5).max(32),
    name: z.string().trim().max(120).optional(),
    amountMinor: z.number().int().min(1),
    currency: z.string().regex(/^[a-z]{3}$/).optional(),
    description: z.string().trim().min(1).max(250),
    reference: z.string().trim().max(80).optional(),
    expiresInMinutes: z.number().int().min(30).max(43_200).optional(),
    tagId: z.uuid().optional(),
    flowId: z.uuid().optional(),
    numberId: z.uuid().optional(),
    send: z.boolean().default(true),
  })
  .strict();
export type PublicPaymentInput = z.infer<typeof PublicPaymentSchema>;

const ListSchema = z
  .object({
    reference: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(32).optional(),
    status: z.enum(['WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

@Injectable()
export class PublicPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly sender: PaymentSender,
    private readonly effects: PaymentEffects,
    private readonly contacts: ContactsService,
    private readonly appSettings: SettingsService,
  ) {}

  async create(input: PublicPaymentInput, apiKeyId: string) {
    const access = await this.gateway.requireReady().catch(() => {
      throw new AppError(HttpStatus.CONFLICT, 'gateway_not_ready', 'Stripe is not connected or has a problem');
    });
    if (input.currency && input.currency !== access.currency) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'currency_mismatch', `Payments are in ${access.currency.toUpperCase()}`);
    const { defaultCountryCode } = await this.appSettings.get();
    const phone = normalizePhone(input.phone, defaultCountryCode);
    if (!phone) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Invalid phone number', [{ field: 'phone', issue: 'is not a valid phone number' }]);
    let contact = await this.prisma.contact.findUnique({ where: { phoneE164: phone.e164 }, select: { id: true, name: true } });
    if (!contact) {
      try {
        const created = await this.contacts.create({ phone: phone.e164, name: input.name ?? null, attributes: {}, tags: [] }, null, 'api');
        contact = { id: created.id, name: input.name ?? null };
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== HttpStatus.CONFLICT) throw error;
        contact = await this.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone.e164 }, select: { id: true, name: true } });
      }
    }
    // The chat to send in: the given number's, else the contact's latest chat, else the default number.
    const chat = await this.prisma.conversation.findFirst({
      where: { contactId: contact.id, ...(input.numberId ? { numberId: input.numberId } : {}) },
      orderBy: { lastActivityAt: 'desc' },
      select: { id: true, numberId: true, lastCustomerMessageAt: true, number: { select: { wabaId: true } } },
    });
    const number = chat ? null : await this.prisma.whatsAppNumber.findFirst({ where: { ...(input.numberId ? { id: input.numberId } : {}), connectionStatus: 'CONNECTED', sendingEnabled: true }, orderBy: { createdAt: 'asc' }, select: { id: true, wabaId: true } });
    const settings = await this.settings.row();
    const live = Boolean(chat && isLive(chat.lastCustomerMessageAt));
    const template = input.send && !live ? await this.sender.paymentTemplate(settings, chat?.number.wabaId ?? number?.wabaId ?? '') : null;
    if (input.send && !live && !template) throw new AppError(HttpStatus.CONFLICT, 'window_closed_no_template', 'The 24-hour window is closed and no payment template is set');
    if (input.send && !chat && !number) throw new AppError(HttpStatus.CONFLICT, 'window_closed_no_template', 'No WhatsApp number can send this request');

    let row: PaymentRequest;
    try {
      row = await this.requests.create({
        access,
        settings,
        source: 'API',
        amountMinor: input.amountMinor,
        description: input.description,
        reference: input.reference ?? null,
        expiresInMinutes: input.expiresInMinutes ?? settings.defaultExpiryMinutes,
        contactId: contact.id,
        conversationId: chat?.id ?? null,
        phoneE164: phone.e164,
        customerName: contact.name,
        apiKeyId,
        tagId: input.tagId ?? null,
        flowId: input.flowId ?? null,
      });
    } catch (error) {
      throw this.publicError(error);
    }
    if (input.send) {
      if (live && chat) await this.sender.automatic(chat.id, chat.numberId, row, settings);
      else await this.sender.template({ conversationId: chat?.id ?? null, numberId: chat?.numberId ?? number!.id, contactId: contact.id }, row, template!, settings.templateMapping, { automatic: true }).catch((error: unknown) => {
        throw this.publicError(error);
      });
    }
    return { status: 201, body: await this.dto(row.id) };
  }

  async get(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(HttpStatus.NOT_FOUND, 'not_found', 'Payment request not found');
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'not_found', 'Payment request not found');
    return this.toPublic(row);
  }

  async list(query: z.infer<typeof ListSchema>) {
    const { defaultCountryCode } = await this.appSettings.get();
    const phone = query.phone ? normalizePhone(query.phone, defaultCountryCode)?.e164 : undefined;
    const rows = await this.prisma.paymentRequest.findMany({
      where: { ...(query.reference ? { reference: query.reference } : {}), ...(phone ? { phoneE164: phone } : {}), ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return { data: page.map((r) => this.toPublic(r)), nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
  }

  async cancel(id: string, apiKeyId: string) {
    await this.get(id);
    try {
      await this.requests.cancel(id, { apiKeyId });
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_WAITING') throw new AppError(HttpStatus.CONFLICT, 'not_waiting', 'Only waiting requests can be cancelled');
      throw error;
    }
    return this.get(id);
  }

  private async dto(id: string) {
    return this.toPublic(await this.prisma.paymentRequest.findUniqueOrThrow({ where: { id } }));
  }

  private toPublic(row: PaymentRequest) {
    return {
      id: row.id,
      contactId: row.contactId,
      phone: row.phoneE164,
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
      description: row.description,
      reference: row.reference,
      status: row.status,
      failedAttempts: row.failedAttempts,
      paidAt: row.paidAt?.toISOString() ?? null,
      paidLate: row.paidLate,
      refundedMinor: Number(row.refundedMinor),
      expiresAt: row.expiresAt.toISOString(),
      payUrl: payUrl(this.effects.linkBase(), row.code),
      messageId: row.messageId,
      test: row.isTest,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Dashboard error codes in the public API's lower-case style. */
  private publicError(error: unknown): unknown {
    if (!(error instanceof AppError)) return error;
    const map: Record<string, string> = { AMOUNT_TOO_SMALL: 'amount_too_small', AMOUNT_TOO_LARGE: 'amount_too_large', GATEWAY_REFUSED: 'gateway_refused', GATEWAY_UNAVAILABLE: 'gateway_unavailable', GATEWAY_NOT_READY: 'gateway_not_ready', CONTACT_OPTED_OUT: 'contact_opted_out', NO_OPT_IN: 'contact_opted_out' };
    const code = map[error.code];
    if (!code) return error;
    const status = code === 'contact_opted_out' ? HttpStatus.FORBIDDEN : error.status;
    return new AppError(status, code, error.message, error.details);
  }
}

/** /api/v1/payments (contracts/public-payments-v1.openapi.yaml). */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PublicPaymentsController {
  constructor(
    private readonly payments: PublicPaymentsService,
    private readonly idempotent: IdempotentResponses,
  ) {}

  @Post('payments')
  @RequireScope('payments.write')
  create(@Body(new ZodValidationPipe(PublicPaymentSchema)) body: PublicPaymentInput, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (!key?.trim()) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Send an Idempotency-Key header', [{ field: 'Idempotency-Key', issue: 'is required' }]);
    return answerOnce(this.idempotent, req, res, key, body, () => this.payments.create(body, keyOf(req).id));
  }

  @Get('payments')
  @RequireScope('payments.read')
  list(@Query(new ZodValidationPipe(ListSchema)) query: z.infer<typeof ListSchema>) {
    return this.payments.list(query);
  }

  @Get('payments/:id')
  @RequireScope('payments.read')
  get(@Param('id') id: string) {
    return this.payments.get(id);
  }

  @Post('payments/:id/cancel')
  @RequireScope('payments.write')
  cancel(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (!key?.trim()) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Send an Idempotency-Key header', [{ field: 'Idempotency-Key', issue: 'is required' }]);
    return answerOnce(this.idempotent, req, res, key, { id }, async () => ({ status: 200, body: await this.payments.cancel(id, keyOf(req).id) }));
  }
}
