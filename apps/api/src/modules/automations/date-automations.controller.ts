import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  DateAutomationInputSchema,
  DateAutomationsService,
  DateRuleSchema,
  RecipientsQuerySchema,
  ResultsQuerySchema,
  SwitchSchema,
  type DateAutomationInput,
  type DateRule,
} from './date-automations.service.js';
import type { z } from 'zod';

/** /date-automations (feature 010 US5, contracts/contacts-settings-api.openapi.yaml tag date-automations). */
@Controller('date-automations')
export class DateAutomationsController {
  constructor(private readonly automations: DateAutomationsService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.automations.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(DateAutomationInputSchema)) body: DateAutomationInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.automations.create(body, this.actor(user, req));
  }

  @Post('preview')
  @Require('campaigns.manage')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(DateRuleSchema)) body: DateRule) {
    return this.automations.preview(body);
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.automations.get(id);
  }

  @Put(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DateAutomationInputSchema)) body: DateAutomationInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.automations.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @Require('campaigns.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.automations.remove(id, this.actor(user, req));
  }

  @Post(':id/switch')
  @Require('campaigns.launch')
  @HttpCode(200)
  switch(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SwitchSchema)) body: { on: boolean }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.automations.switch(id, body.on, this.actor(user, req));
  }

  @Get(':id/results')
  @Require('campaigns.view')
  results(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ResultsQuerySchema)) query: z.infer<typeof ResultsQuerySchema>) {
    return this.automations.results(id, query);
  }

  @Get(':id/recipients')
  @Require('campaigns.view')
  recipients(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(RecipientsQuerySchema)) query: z.infer<typeof RecipientsQuerySchema>) {
    return this.automations.recipients(id, query);
  }
}
