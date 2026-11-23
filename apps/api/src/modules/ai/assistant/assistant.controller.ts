import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AssistantActionsService } from './assistant-actions.service.js';
import { AssistantRequestSchema, AssistantService, type AssistantRequestInput } from './assistant.service.js';

/** /assistant (contracts/ai-api.openapi.yaml, 004 T100, T102): the team assistant, for `assistant.use`. */
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly actions: AssistantActionsService,
  ) {}

  @Get('requests')
  @Require('assistant.use')
  list(@CurrentUser() user: RequestUser) {
    return this.assistant.list(user.id);
  }

  @Post('requests')
  @HttpCode(202)
  @Require('assistant.use')
  create(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(AssistantRequestSchema)) body: AssistantRequestInput) {
    return this.assistant.create(user.id, body);
  }

  @Get('requests/:id')
  @Require('assistant.use')
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.get(id, user.id);
  }

  @Post('actions/:id/confirm')
  @HttpCode(200)
  @Require('assistant.use')
  confirm(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.actions.confirm(id, { id: user.id, role: user.role }, ip);
  }

  @Post('actions/:id/cancel')
  @HttpCode(200)
  @Require('assistant.use')
  cancel(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.cancel(id, user.id);
  }
}
