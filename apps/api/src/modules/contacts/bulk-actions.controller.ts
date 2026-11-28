import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { BulkActionsService, BulkTagInputSchema, type BulkTagInput } from './bulk-actions.service.js';

/** /contacts/bulk-actions (feature 010 US1–US2, contracts/contacts-settings-api.openapi.yaml tag bulk-actions). */
@Controller('contacts/bulk-actions')
export class BulkActionsController {
  constructor(private readonly bulk: BulkActionsService) {}

  @Get()
  @Require('contacts.view')
  list() {
    return this.bulk.list();
  }

  @Post()
  @Require('contacts.manage')
  @HttpCode(202)
  create(@Body(new ZodValidationPipe(BulkTagInputSchema)) body: BulkTagInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.bulk.createTags(body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Get(':id')
  @Require('contacts.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulk.get(id);
  }
}
