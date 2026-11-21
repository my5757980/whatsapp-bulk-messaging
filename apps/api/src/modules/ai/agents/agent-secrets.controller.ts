import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  AgentSecretsService,
  CreateSecretSchema,
  SkillTestSchema,
  UpdateSecretSchema,
  type CreateSecretInput,
  type SkillTestInput,
  type UpdateSecretInput,
} from './agent-secrets.service.js';

/** Secrets for API skill headers and the skill test request (004 T074). */
@Controller('ai-agents')
export class AgentSecretsController {
  constructor(private readonly secrets: AgentSecretsService) {}

  @Post(':id/secrets')
  @Require('ai.manage')
  create(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreateSecretSchema)) body: CreateSecretInput, @ClientIp() ip: string | null) {
    return this.secrets.create(id, body, { userId: user.id, ip });
  }

  @Put(':id/secrets/:secretId')
  @Require('ai.manage')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('secretId', ParseUUIDPipe) secretId: string,
    @Body(new ZodValidationPipe(UpdateSecretSchema)) body: UpdateSecretInput,
    @ClientIp() ip: string | null,
  ) {
    return this.secrets.update(id, secretId, body, { userId: user.id, ip });
  }

  @Delete(':id/secrets/:secretId')
  @HttpCode(204)
  @Require('ai.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('secretId', ParseUUIDPipe) secretId: string, @ClientIp() ip: string | null): Promise<void> {
    await this.secrets.remove(id, secretId, { userId: user.id, ip });
  }

  @Post(':id/skill-test')
  @HttpCode(200)
  @Require('ai.manage')
  test(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SkillTestSchema)) body: SkillTestInput) {
    return this.secrets.test(id, body);
  }
}
