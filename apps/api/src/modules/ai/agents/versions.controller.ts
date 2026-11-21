import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AgentVersionsService } from './versions.service.js';

/** Versions of an agent and restoring one into the draft (T062). */
@Controller('ai-agents')
export class AgentVersionsController {
  constructor(private readonly versions: AgentVersionsService) {}

  @Get(':id/versions')
  @Require('ai.manage')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.versions.list(id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  @Require('ai.manage')
  restore(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @ClientIp() ip: string | null) {
    return this.versions.restore(id, versionId, { userId: user.id, ip });
  }
}
