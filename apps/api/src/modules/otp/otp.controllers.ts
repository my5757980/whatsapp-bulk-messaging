import { Body, Controller, Get, Headers, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ApiKeyGuard, type ApiRequest } from '../public-api/api-key.guard.js';
import { RequireScope } from '../public-api/api-scope.decorator.js';
import { IdempotentResponses } from '../public-api/idempotent-responses.service.js';
import { answerOnce, keyOf } from '../public-api/public-contacts.controller.js';
import { RateLimitGuard } from '../public-api/rate-limit.guard.js';
import { OtpService, OtpSettingsSchema, SendCodeSchema, type OtpSettingsInput, type SendCodeInput } from './otp.service.js';

/** One-time codes through the public API (feature 009 US1, contracts/public-otp-v1.openapi.yaml). */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PublicOtpController {
  constructor(
    private readonly otp: OtpService,
    private readonly idempotent: IdempotentResponses,
  ) {}

  @Post('otp')
  @RequireScope('otp.send')
  async send(@Body(new ZodValidationPipe(SendCodeSchema)) body: SendCodeInput, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    try {
      // The idempotency record keeps a keyed fingerprint of the code, never the code (research R4).
      if (key?.trim()) return await answerOnce(this.idempotent, req, res, key, this.otp.idempotencyBody(body), () => this.otp.send(body, keyOf(req).id));
      const answer = await this.otp.send(body, keyOf(req).id);
      res.status(answer.status);
      return answer.body;
    } catch (error) {
      if (error instanceof AppError && error.code === 'TOO_MANY_CODES') res.setHeader('Retry-After', String(error.extra?.retryAfterSeconds ?? 60));
      throw error;
    }
  }

  @Get('otp/:id')
  @RequireScope('otp.send')
  status(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.otp.status(id, keyOf(req).id);
  }
}

/** One-time code settings (contracts/templates-growth-api.openapi.yaml tag otp-settings). */
@Controller('otp/settings')
export class OtpSettingsController {
  constructor(private readonly otp: OtpService) {}

  @Get()
  @Require('settings.view')
  get() {
    return this.otp.settings();
  }

  @Put()
  @Require('settings.manage')
  update(@Body(new ZodValidationPipe(OtpSettingsSchema)) body: OtpSettingsInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.otp.saveSettings(body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
