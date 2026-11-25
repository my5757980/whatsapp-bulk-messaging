import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AdsConnectionService, CapSchema, ChecksSchema, SaveSchema, TokenSchema } from './ads-connection.service.js';

/** The ads connection (feature 007 US1, contracts/ads-api.openapi.yaml tag ads-connection). */
@Controller('ads/connection')
export class AdsConnectionController {
  constructor(private readonly connection: AdsConnectionService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  async get() {
    return { connection: await this.connection.get() };
  }

  @Post()
  @Require('integrations.manage')
  save(@Body(new ZodValidationPipe(SaveSchema)) body: z.infer<typeof SaveSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.connection.save(body, this.actor(user, req));
  }

  @Delete()
  @HttpCode(204)
  @Require('integrations.manage')
  async disconnect(@CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.connection.disconnect(this.actor(user, req));
  }

  @Post('token')
  @Require('integrations.manage')
  token(@Body(new ZodValidationPipe(TokenSchema)) body: { accessToken: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.connection.startSession(body.accessToken, this.actor(user, req));
  }

  @Post('checks')
  @HttpCode(200)
  @Require('integrations.manage')
  checks(@Body(new ZodValidationPipe(ChecksSchema)) body: z.infer<typeof ChecksSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    if (body.sessionId) return this.connection.sessionChecks(body.sessionId, body.adAccountId!, body.pageId!, user.id);
    return this.connection.recheck(this.actor(user, req));
  }

  @Put('spend-cap')
  @Require('integrations.manage')
  cap(@Body(new ZodValidationPipe(CapSchema)) body: { monthlyCapMinor: number | null }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.connection.setCap(body.monthlyCapMinor, this.actor(user, req));
  }
}
