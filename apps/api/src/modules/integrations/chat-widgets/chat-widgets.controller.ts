import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ChatWidgetInputSchema, ChatWidgetStatsQuerySchema, ChatWidgetsService, type ChatWidgetInput } from './chat-widgets.service.js';

/** /chat-widgets (feature 009 US8, contracts/templates-growth-api.openapi.yaml tag chat-widgets). */
@Controller('chat-widgets')
export class ChatWidgetsController {
  constructor(private readonly widgets: ChatWidgetsService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.widgets.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(ChatWidgetInputSchema)) body: ChatWidgetInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.widgets.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.widgets.get(id);
  }

  @Put(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ChatWidgetInputSchema)) body: ChatWidgetInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.widgets.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @Require('campaigns.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.widgets.remove(id, this.actor(user, req));
  }

  @Post(':id/pause')
  @Require('campaigns.manage')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.widgets.setStatus(id, 'PAUSED', this.actor(user, req));
  }

  @Post(':id/resume')
  @Require('campaigns.manage')
  @HttpCode(200)
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.widgets.setStatus(id, 'ACTIVE', this.actor(user, req));
  }

  @Get(':id/stats')
  @Require('campaigns.view')
  stats(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ChatWidgetStatsQuerySchema)) query: { from?: string; to?: string }) {
    return this.widgets.stats(id, query);
  }
}
