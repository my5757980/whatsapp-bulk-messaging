import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  CreateFlowSchema,
  FlowsService,
  SaveDraftSchema,
  UpdateFlowSchema,
  type CreateFlowInput,
  type SaveDraftInput,
  type UpdateFlowInput,
} from './flows.service.js';
import { PublishService } from './publish.service.js';

/** /flows (contracts/flows-api.openapi.yaml): building and publishing flows (flows.manage). */
@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flows: FlowsService,
    private readonly publishing: PublishService,
  ) {}

  @Get()
  @Require('flows.manage')
  list() {
    return this.flows.list();
  }

  @Post()
  @Require('flows.manage')
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(CreateFlowSchema)) body: CreateFlowInput, @ClientIp() ip: string | null) {
    return this.flows.create(body, { userId: user.id, ip });
  }

  @Get(':id')
  @Require('flows.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.flows.get(id);
  }

  @Patch(':id')
  @Require('flows.manage')
  update(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateFlowSchema)) body: UpdateFlowInput, @ClientIp() ip: string | null) {
    return this.flows.update(id, body, { userId: user.id, ip });
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('flows.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null): Promise<void> {
    await this.flows.remove(id, { userId: user.id, ip });
  }

  @Post(':id/duplicate')
  @Require('flows.manage')
  duplicate(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.flows.duplicate(id, { userId: user.id, ip });
  }

  @Put(':id/draft')
  @Require('flows.manage')
  saveDraft(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SaveDraftSchema)) body: SaveDraftInput) {
    return this.flows.saveDraft(id, body, user.id);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Require('flows.manage')
  publish(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.publishing.publish(id, { userId: user.id, ip });
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @Require('flows.manage')
  unpublish(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.publishing.unpublish(id, { userId: user.id, ip });
  }
}
