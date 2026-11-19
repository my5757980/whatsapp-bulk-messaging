import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { TemplateListQuerySchema, TemplatesSyncService, type TemplateListQuery } from './templates-sync.service.js';
import { TemplateInputSchema, TemplatesService, type TemplateInput } from './templates.service.js';

/** /templates: read and sync (T089), create, duplicate and delete (T140). */
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesSyncService,
    private readonly authoring: TemplatesService,
  ) {}

  @Get()
  @Require('templates.view')
  list(@Query(new ZodValidationPipe(TemplateListQuerySchema)) query: TemplateListQuery) {
    return this.templates.list(query);
  }

  @Post()
  @Require('templates.manage')
  create(@Body(new ZodValidationPipe(TemplateInputSchema)) body: TemplateInput, @CurrentUser() user: RequestUser) {
    return this.authoring.create(body, user.id);
  }

  @Post(':id/duplicate')
  @Require('templates.manage')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.authoring.duplicate(id);
  }

  @Delete(':id')
  @Require('templates.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.authoring.remove(id);
  }

  @Post('sync')
  @Require('templates.view')
  @HttpCode(200)
  sync() {
    return this.templates.syncAll();
  }

  @Get(':id')
  @Require('templates.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(id);
  }
}
