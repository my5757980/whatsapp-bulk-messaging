import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ApiTestSchema, ApiTestService, type ApiTestInput } from './api-test.service.js';
import { CreateSecretSchema, FlowSecretsService, UpdateSecretSchema, type CreateSecretInput, type UpdateSecretInput } from './secrets.service.js';

/** /flows/{id}/secrets and /flows/{id}/api-test (contracts/flows-api.openapi.yaml, flows.manage). */
@Controller('flows')
export class FlowSecretsController {
  constructor(
    private readonly secrets: FlowSecretsService,
    private readonly apiTest: ApiTestService,
  ) {}

  @Post(':id/secrets')
  @Require('flows.manage')
  create(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreateSecretSchema)) body: CreateSecretInput, @ClientIp() ip: string | null) {
    return this.secrets.create(id, body, { userId: user.id, ip });
  }

  @Put(':id/secrets/:secretId')
  @Require('flows.manage')
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
  @Require('flows.manage')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Param('secretId', ParseUUIDPipe) secretId: string, @ClientIp() ip: string | null): Promise<void> {
    await this.secrets.remove(id, secretId, { userId: user.id, ip });
  }

  @Post(':id/api-test')
  @HttpCode(200)
  @Require('flows.manage')
  test(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ApiTestSchema)) body: ApiTestInput) {
    return this.apiTest.run(id, body);
  }
}
