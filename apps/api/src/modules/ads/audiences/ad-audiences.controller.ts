import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AdAudiencesService, AudienceInputSchema, LookalikeSchema, type AudienceInput } from './ad-audiences.service.js';

/** Saved audiences and lookalikes (feature 007 US6, contracts/ads-api.openapi.yaml tag ad-audiences). */
@Controller('ads/audiences')
export class AdAudiencesController {
  constructor(private readonly audiences: AdAudiencesService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.audiences.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(AudienceInputSchema)) body: AudienceInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.audiences.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.audiences.get(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('campaigns.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.audiences.remove(id, this.actor(user, req));
  }

  @Post(':id/lookalikes')
  @Require('campaigns.manage')
  lookalike(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(LookalikeSchema)) body: z.infer<typeof LookalikeSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.audiences.lookalike(id, body, this.actor(user, req));
  }

  @Post(':id/sync')
  @HttpCode(202)
  @Require('campaigns.manage')
  async sync(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.audiences.syncNow(id);
  }
}
