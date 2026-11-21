import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  AgentsService,
  CreateAgentSchema,
  RenameAgentSchema,
  SaveAgentDraftSchema,
  SetAgentNumbersSchema,
  SetTestNumbersSchema,
  type CreateAgentInput,
  type RenameAgentInput,
  type SaveAgentDraftInput,
  type SetAgentNumbersInput,
  type SetTestNumbersInput,
} from './agents.service.js';
import { AgentPublishService } from './publish.service.js';

/** /ai-agents (contracts/ai-api.openapi.yaml): building and publishing AI agents (ai.manage). */
@Controller('ai-agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly publishing: AgentPublishService,
  ) {}

  @Get()
  @Require('ai.manage')
  list() {
    return this.agents.list();
  }

  @Post()
  @Require('ai.manage')
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(CreateAgentSchema)) body: CreateAgentInput, @ClientIp() ip: string | null) {
    return this.agents.create(body, { userId: user.id, ip });
  }

  @Get(':id')
  @Require('ai.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.get(id);
  }

  @Patch(':id')
  @Require('ai.manage')
  rename(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RenameAgentSchema)) body: RenameAgentInput, @ClientIp() ip: string | null) {
    return this.agents.rename(id, body, { userId: user.id, ip });
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('ai.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null): Promise<void> {
    await this.agents.remove(id, { userId: user.id, ip });
  }

  @Post(':id/duplicate')
  @Require('ai.manage')
  duplicate(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RenameAgentSchema)) body: RenameAgentInput, @ClientIp() ip: string | null) {
    return this.agents.duplicate(id, body, { userId: user.id, ip });
  }

  @Put(':id/draft')
  @Require('ai.manage')
  saveDraft(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SaveAgentDraftSchema)) body: SaveAgentDraftInput, @ClientIp() ip: string | null) {
    return this.agents.saveDraft(id, body, { userId: user.id, ip });
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Require('ai.manage')
  publish(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.publishing.publish(id, { userId: user.id, ip });
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @Require('ai.manage')
  unpublish(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.publishing.unpublish(id, { userId: user.id, ip });
  }

  @Put(':id/numbers')
  @Require('ai.manage')
  setNumbers(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SetAgentNumbersSchema)) body: SetAgentNumbersInput, @ClientIp() ip: string | null) {
    return this.agents.setNumbers(id, body, { userId: user.id, ip });
  }

  @Put(':id/test-numbers')
  @Require('ai.manage')
  setTestNumbers(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SetTestNumbersSchema)) body: SetTestNumbersInput, @ClientIp() ip: string | null) {
    return this.agents.setTestNumbers(id, body, { userId: user.id, ip });
  }
}
