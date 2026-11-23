import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { PreviewSchema, PreviewService, type PreviewInput } from './preview.service.js';

/** The draft's preview chat (T060, FR-034); nothing is sent or changed. */
@Controller('ai-agents')
export class PreviewController {
  constructor(private readonly previews: PreviewService) {}

  @Post(':id/preview')
  @HttpCode(200)
  @Require('ai.manage')
  preview(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PreviewSchema)) body: PreviewInput) {
    return this.previews.preview(id, body, user.id);
  }
}
