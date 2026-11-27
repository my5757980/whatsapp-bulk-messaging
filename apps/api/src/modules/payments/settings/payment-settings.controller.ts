import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { PaymentSettingsSchema, PaymentSettingsService, type PaymentSettingsInput } from './payment-settings.service.js';

/** Payment settings (feature 008, contracts/commerce-api.openapi.yaml tag payments-settings). */
@Controller('payments/settings')
export class PaymentSettingsController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get()
  @Require('payments.view')
  get() {
    return this.settings.get();
  }

  @Put()
  @Require('payments.manage')
  update(@Body(new ZodValidationPipe(PaymentSettingsSchema)) body: PaymentSettingsInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.settings.update(body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
