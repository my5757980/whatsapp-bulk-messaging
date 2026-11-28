import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { TwoFactorService } from './two-factor.service.js';

// Feature 010 (US6, contracts/login-2fa.md §5 – §6): self-service at /me/2fa, the company requirement and
// admin resets.

export const CodeInputSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'enter the 6-digit code') }).strict();
const RequireSchema = z.object({ require2fa: z.boolean() }).strict();
const actorOf = (user: RequestUser, req: AuthedRequest) => ({ userId: user.id, ip: clientIp(req) ?? null });

/** /me/2fa: the signed-in member's own two-factor sign-in (any role). */
@Controller('me/2fa')
export class MyTwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Get()
  status(@CurrentUser() user: RequestUser) {
    return this.twoFactor.status(user.id);
  }

  @Post('setup')
  @HttpCode(200)
  setup(@CurrentUser() user: RequestUser) {
    return this.twoFactor.startSetup(user.id);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(@Body(new ZodValidationPipe(CodeInputSchema)) body: { code: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.twoFactor.confirmSetup(user.id, body.code, actorOf(user, req));
  }

  @Post('disable')
  @HttpCode(204)
  async disable(@Body(new ZodValidationPipe(CodeInputSchema)) body: { code: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.twoFactor.disable(user.id, body.code, actorOf(user, req));
  }

  @Post('recovery-codes')
  @HttpCode(200)
  regenerate(@Body(new ZodValidationPipe(CodeInputSchema)) body: { code: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.twoFactor.regenerate(user.id, body.code, actorOf(user, req));
  }
}

/** /settings/security: whether the company requires 2FA, and each member's state. */
@Controller('settings/security')
export class SecuritySettingsController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Get()
  @Require('users.manage')
  get() {
    return this.twoFactor.securitySettings();
  }

  @Put()
  @Require('users.manage')
  update(@Body(new ZodValidationPipe(RequireSchema)) body: { require2fa: boolean }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.twoFactor.setRequired(body.require2fa, actorOf(user, req));
  }
}

/** POST /users/{id}/2fa/reset: another member's 2FA is reset and their sessions end. */
@Controller('users')
export class UserTwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Post(':id/2fa/reset')
  @Require('users.manage')
  @HttpCode(204)
  async reset(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.twoFactor.reset(id, actorOf(user, req));
  }
}
