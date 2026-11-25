import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AdCampaignsService, CampaignInputSchema, CampaignPatchSchema, ListSchema, VersionSchema, type CampaignInput, type CampaignPatch, type VersionInput } from './ad-campaigns.service.js';

/** Ad campaigns and their versions (feature 007 US2, contracts/ads-api.openapi.yaml tag ad-campaigns). */
@Controller('ads/campaigns')
export class AdCampaignsController {
  constructor(private readonly campaigns: AdCampaignsService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list(@Query(new ZodValidationPipe(ListSchema)) query: z.infer<typeof ListSchema>) {
    return this.campaigns.list(query.status);
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(CampaignInputSchema)) body: CampaignInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  patch(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CampaignPatchSchema)) body: CampaignPatch, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.patch(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('campaigns.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.campaigns.remove(id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Require('campaigns.launch')
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.submit(id, this.actor(user, req));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Require('campaigns.launch')
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.pause(id, this.actor(user, req));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @Require('campaigns.launch')
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.resume(id, this.actor(user, req));
  }

  @Post(':id/end')
  @HttpCode(200)
  @Require('campaigns.launch')
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.end(id, this.actor(user, req));
  }

  @Post(':id/duplicate')
  @Require('campaigns.manage')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.duplicate(id, this.actor(user, req));
  }

  @Post(':id/versions/:versionId/pause')
  @HttpCode(200)
  @Require('campaigns.launch')
  pauseVersion(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.pauseVersion(id, versionId, this.actor(user, req));
  }

  @Post(':id/versions/:versionId/resume')
  @HttpCode(200)
  @Require('campaigns.launch')
  resumeVersion(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.resumeVersion(id, versionId, this.actor(user, req));
  }

  @Put(':id/versions/:versionId')
  @Require('campaigns.manage')
  updateVersion(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Body(new ZodValidationPipe(VersionSchema)) body: VersionInput) {
    return this.campaigns.updateVersion(id, versionId, body);
  }
}
