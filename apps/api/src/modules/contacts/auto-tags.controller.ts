import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AutoTagRuleInputSchema, AutoTagService, type AutoTagRuleInput } from './auto-tags.service.js';

const EnabledSchema = z.object({ enabled: z.boolean() }).strict();

/** /auto-tag-rules (feature 010 US2, contracts/contacts-settings-api.openapi.yaml tag auto-tags). */
@Controller('auto-tag-rules')
export class AutoTagsController {
  constructor(private readonly rules: AutoTagService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('settings.view')
  list() {
    return this.rules.list();
  }

  @Post()
  @Require('settings.manage')
  create(@Body(new ZodValidationPipe(AutoTagRuleInputSchema)) body: AutoTagRuleInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.rules.create(body, this.actor(user, req));
  }

  @Put(':id')
  @Require('settings.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EnabledSchema)) body: { enabled: boolean }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.rules.setEnabled(id, body.enabled, this.actor(user, req));
  }

  @Delete(':id')
  @Require('settings.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.rules.remove(id, this.actor(user, req));
  }
}
