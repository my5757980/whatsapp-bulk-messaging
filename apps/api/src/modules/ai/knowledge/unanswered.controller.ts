import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AnswerQuestionSchema, UnansweredQuerySchema, UnansweredService, type AnswerQuestionInput, type UnansweredQuery } from './unanswered.service.js';

/** /ai-agents/{id}/unanswered (contracts/ai-api.openapi.yaml, FR-015): gaps in the knowledge (ai.manage). */
@Controller('ai-agents/:id/unanswered')
export class UnansweredController {
  constructor(private readonly unanswered: UnansweredService) {}

  @Get()
  @Require('ai.manage')
  list(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(UnansweredQuerySchema)) query: UnansweredQuery) {
    return this.unanswered.list(id, query);
  }

  @Post(':questionId/answer')
  @Require('ai.manage')
  answer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body(new ZodValidationPipe(AnswerQuestionSchema)) body: AnswerQuestionInput,
    @ClientIp() ip: string | null,
  ) {
    return this.unanswered.answer(id, questionId, body, { userId: user.id, ip });
  }

  @Post(':questionId/dismiss')
  @HttpCode(204)
  @Require('ai.manage')
  async dismiss(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('questionId', ParseUUIDPipe) questionId: string, @ClientIp() ip: string | null): Promise<void> {
    await this.unanswered.dismiss(id, questionId, { userId: user.id, ip });
  }
}
