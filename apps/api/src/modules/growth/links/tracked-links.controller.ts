import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { TargetPatchSchema, TrackedLinksInputSchema, TrackedLinksService, type TargetPatch, type TrackedLinksInput } from './tracked-links.service.js';

/** Tracked links of campaigns (contracts/growth-api.openapi.yaml, tag tracked-links). */
@Controller()
export class TrackedLinksController {
  constructor(private readonly links: TrackedLinksService) {}

  @Get('tracked-links/config')
  @Require('templates.view')
  config() {
    return this.links.settings();
  }

  @Get('campaigns/:id/tracked-links')
  @Require('campaigns.view')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.links.list(id);
  }

  @Put('campaigns/:id/tracked-links')
  @Require('campaigns.manage')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TrackedLinksInputSchema)) body: TrackedLinksInput) {
    return this.links.replace(id, body);
  }

  @Patch('tracked-link-targets/:id')
  @Require('campaigns.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(TargetPatchSchema)) body: TargetPatch,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.links.updateTarget(id, body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
