import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  ChecksSchema,
  ConnectSchema,
  FixSchema,
  NumberWizardService,
  StartSchema,
  TestMessageSchema,
  type ChecksInput,
  type ConnectInput,
  type FixInput,
  type TestMessageInput,
} from './number-wizard.service.js';

/** The number connection wizard and the health check (feature 006 US8, contracts tag number-wizard); admins only. */
@Controller()
export class NumberWizardController {
  constructor(private readonly wizard: NumberWizardService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Post('number-wizard/sessions')
  @Require('numbers.manage')
  start(@Body(new ZodValidationPipe(StartSchema)) body: { accessToken: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.start(body.accessToken, this.actor(user, req));
  }

  @Post('number-wizard/sessions/:id/checks')
  @HttpCode(200)
  @Require('numbers.manage')
  checks(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ChecksSchema)) body: ChecksInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.checks(id, body, this.actor(user, req));
  }

  @Post('number-wizard/sessions/:id/fixes')
  @HttpCode(200)
  @Require('numbers.manage')
  fix(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(FixSchema)) body: FixInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.fix(id, body, this.actor(user, req));
  }

  @Post('number-wizard/sessions/:id/test-message')
  @HttpCode(200)
  @Require('numbers.manage')
  testMessage(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TestMessageSchema)) body: TestMessageInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.testMessage(id, body, this.actor(user, req));
  }

  @Post('number-wizard/sessions/:id/connect')
  @Require('numbers.manage')
  connect(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ConnectSchema)) body: ConnectInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.connect(id, body, this.actor(user, req));
  }

  @Post('numbers/:id/health-check')
  @HttpCode(200)
  @Require('numbers.manage')
  healthCheck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.wizard.healthCheck(id, this.actor(user, req));
  }
}
