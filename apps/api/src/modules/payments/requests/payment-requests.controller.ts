import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { permissionsFor } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { PaymentChatService } from './payment-chat.service.js';
import { CreateRequestSchema, ListRequestsSchema, PaymentRequestsService, type CreateRequestInput, type ListRequestsQuery } from './payment-requests.service.js';

const TestResultSchema = z.object({ result: z.enum(['paid', 'notPaid']) }).strict();

const viewerOf = (user: RequestUser) => ({ id: user.id, role: user.role, permissions: new Set<string>(permissionsFor(user.role)) });

/** Payment requests in chats (feature 008 US2, contracts/commerce-api.openapi.yaml tag payment-requests). */
@Controller()
export class PaymentRequestsController {
  constructor(
    private readonly requests: PaymentRequestsService,
    private readonly chat: PaymentChatService,
  ) {}

  @Post('inbox/conversations/:id/payment-requests')
  @Require('inbox.reply')
  create(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreateRequestSchema)) body: CreateRequestInput, @CurrentUser() user: RequestUser) {
    return this.chat.createFromChat(viewerOf(user), id, body);
  }

  @Get('payments/requests')
  @Require('payments.view')
  list(@Query(new ZodValidationPipe(ListRequestsSchema)) query: ListRequestsQuery) {
    return this.requests.list(query);
  }

  @Get('payments/requests/:id')
  @Require('payments.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(id);
  }

  @Post('payments/requests/:id/cancel')
  @HttpCode(200)
  @Require('inbox.reply')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.chat.cancel(viewerOf(user), id, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Post('payments/requests/:id/resend')
  @HttpCode(200)
  @Require('inbox.reply')
  resend(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.chat.resend(viewerOf(user), id);
  }

  @Post('payments/requests/:id/test-result')
  @HttpCode(200)
  @Require('flows.manage')
  testResult(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TestResultSchema)) body: { result: 'paid' | 'notPaid' }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.requests.testResult(id, body.result, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Get('contacts/:id/payments')
  @Require('contacts.view')
  forContact(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.forContact(id);
  }
}
