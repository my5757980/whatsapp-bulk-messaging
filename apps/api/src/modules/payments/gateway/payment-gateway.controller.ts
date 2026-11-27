import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { PaymentGatewayService, SaveGatewaySchema, type SaveGatewayInput } from './payment-gateway.service.js';

/** The Stripe connection (feature 008 US1, contracts/commerce-api.openapi.yaml tag payments-gateway). */
@Controller('payments/gateway')
export class PaymentGatewayController {
  constructor(private readonly gateway: PaymentGatewayService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('payments.view')
  async get() {
    return { gateway: await this.gateway.get() };
  }

  @Put()
  @Require('integrations.manage')
  save(@Body(new ZodValidationPipe(SaveGatewaySchema)) body: SaveGatewayInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.gateway.save(body, this.actor(user, req));
  }

  @Delete()
  @HttpCode(204)
  @Require('integrations.manage')
  async disconnect(@CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.gateway.disconnect(this.actor(user, req));
  }

  @Post('recheck')
  @HttpCode(200)
  @Require('integrations.manage')
  recheck(@CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.gateway.recheck(this.actor(user, req));
  }

  @Post('notification-check')
  @HttpCode(202)
  @Require('integrations.manage')
  notificationCheck(@CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.gateway.startNotificationCheck(this.actor(user, req));
  }
}
