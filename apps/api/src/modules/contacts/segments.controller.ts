import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { SegmentCopySchema, SegmentInputSchema, SegmentPreviewSchema, SegmentsService, type SegmentInput } from './segments.service.js';

/** /segments (feature 010 US1, contracts/contacts-settings-api.openapi.yaml tag segments). */
@Controller('segments')
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('contacts.view')
  list() {
    return this.segments.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(SegmentInputSchema)) body: SegmentInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.segments.create(body, this.actor(user, req));
  }

  @Post('preview')
  @Require('campaigns.manage')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(SegmentPreviewSchema)) body: { rules?: unknown }, @CurrentUser() user: RequestUser) {
    return this.segments.preview(body.rules, user.role);
  }

  @Get(':id')
  @Require('contacts.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.segments.get(id);
  }

  @Put(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SegmentInputSchema)) body: SegmentInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.segments.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @Require('campaigns.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.segments.remove(id, this.actor(user, req));
  }

  @Get(':id/count')
  @Require('contacts.view')
  count(@Param('id', ParseUUIDPipe) id: string) {
    return this.segments.count(id);
  }

  @Post(':id/copy')
  @Require('campaigns.manage')
  copy(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SegmentCopySchema)) body: { name: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.segments.copy(id, body.name, this.actor(user, req));
  }
}
