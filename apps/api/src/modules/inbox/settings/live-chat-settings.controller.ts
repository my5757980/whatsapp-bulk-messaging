import { Body, Controller, Get, Put } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { LiveChatSettingsSchema, LiveChatSettingsService, type LiveChatSettingsInput } from './live-chat-settings.service.js';

/** GET/PUT /live-chat/settings (T048), admins only. */
@Controller('live-chat/settings')
export class LiveChatSettingsController {
  constructor(private readonly settings: LiveChatSettingsService) {}

  @Get()
  @Require('livechat.settings')
  get() {
    return this.settings.get();
  }

  @Put()
  @Require('livechat.settings')
  update(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(LiveChatSettingsSchema)) body: LiveChatSettingsInput, @ClientIp() ip: string | null) {
    return this.settings.update(body, user.id, ip);
  }
}
