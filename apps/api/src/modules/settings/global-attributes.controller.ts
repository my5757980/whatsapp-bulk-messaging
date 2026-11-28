import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  GlobalAttributeCreateSchema,
  GlobalAttributeUpdateSchema,
  GlobalAttributesService,
  type GlobalAttributeCreate,
  type GlobalAttributeUpdate,
} from './global-attributes.service.js';

/** /global-attributes (feature 010 US3, contracts/contacts-settings-api.openapi.yaml tag global-attributes). */
@Controller('global-attributes')
export class GlobalAttributesController {
  constructor(private readonly globals: GlobalAttributesService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('contacts.view')
  list() {
    return this.globals.list();
  }

  @Post()
  @Require('settings.manage')
  create(@Body(new ZodValidationPipe(GlobalAttributeCreateSchema)) body: GlobalAttributeCreate, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.globals.create(body, this.actor(user, req));
  }

  @Put(':id')
  @Require('settings.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(GlobalAttributeUpdateSchema)) body: GlobalAttributeUpdate, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.globals.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @Require('settings.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.globals.remove(id, this.actor(user, req));
  }

  @Get(':id/usage')
  @Require('settings.manage')
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.globals.usageOf(id);
  }
}
