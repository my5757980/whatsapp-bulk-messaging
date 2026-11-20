import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { FlowVersionsService } from './versions.service.js';

/** /flows/{id}/versions (contracts/flows-api.openapi.yaml, flows.manage). */
@Controller('flows')
export class FlowVersionsController {
  constructor(private readonly versions: FlowVersionsService) {}

  @Get(':id/versions')
  @Require('flows.manage')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.versions.list(id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  @Require('flows.manage')
  restore(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @ClientIp() ip: string | null) {
    return this.versions.restore(id, versionId, { userId: user.id, ip });
  }
}
