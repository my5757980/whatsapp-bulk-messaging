import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AI_LIMITS } from '@wbm/shared';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import type { UploadedFileData } from '../../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  AddAnswerSchema,
  AddWebsiteSchema,
  KnowledgeService,
  UpdateSourceSchema,
  type AddAnswerInput,
  type AddWebsiteInput,
  type UpdateSourceInput,
} from './knowledge.service.js';

/** /ai-agents/{id}/knowledge (contracts/ai-api.openapi.yaml): what an agent answers from (ai.manage). */
@Controller('ai-agents/:id/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @Require('ai.manage')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.list(id);
  }

  @Post('answers')
  @Require('ai.manage')
  addAnswer(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AddAnswerSchema)) body: AddAnswerInput, @ClientIp() ip: string | null) {
    return this.knowledge.addAnswer(id, body, { userId: user.id, ip });
  }

  @Post('websites')
  @HttpCode(202)
  @Require('ai.manage')
  addWebsite(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AddWebsiteSchema)) body: AddWebsiteInput, @ClientIp() ip: string | null) {
    return this.knowledge.addWebsite(id, body, { userId: user.id, ip });
  }

  @Post('files')
  @HttpCode(202)
  @Require('ai.manage')
  // One byte over the limit lets the service answer 413 TOO_LARGE with the contract's error shape.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AI_LIMITS.fileBytes + 1, files: 1 } }))
  addFile(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileData | undefined, @ClientIp() ip: string | null) {
    return this.knowledge.addFile(id, file, { userId: user.id, ip });
  }

  @Patch(':sourceId')
  @Require('ai.manage')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body(new ZodValidationPipe(UpdateSourceSchema)) body: UpdateSourceInput,
    @ClientIp() ip: string | null,
  ) {
    return this.knowledge.update(id, sourceId, body, { userId: user.id, ip });
  }

  @Delete(':sourceId')
  @HttpCode(204)
  @Require('ai.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('sourceId', ParseUUIDPipe) sourceId: string, @ClientIp() ip: string | null): Promise<void> {
    await this.knowledge.remove(id, sourceId, { userId: user.id, ip });
  }

  @Post(':sourceId/refresh')
  @HttpCode(202)
  @Require('ai.manage')
  refresh(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('sourceId', ParseUUIDPipe) sourceId: string, @ClientIp() ip: string | null) {
    return this.knowledge.refresh(id, sourceId, { userId: user.id, ip });
  }
}
