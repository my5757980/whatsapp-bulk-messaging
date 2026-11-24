import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ApiCampaignTriggerService, TriggerRequestSchema, type TriggerRequest } from '../integrations/api-campaigns/api-campaign-trigger.service.js';
import { ApiKeyGuard, type ApiRequest } from './api-key.guard.js';
import { RequireScope } from './api-scope.decorator.js';
import { IdempotentResponses } from './idempotent-responses.service.js';
import { answerOnce, keyOf } from './public-contacts.controller.js';
import { RateLimitGuard } from './rate-limit.guard.js';

/** POST /api/v1/api-campaigns/{apiName}/messages (feature 006 US3, FR-019, contracts/public-api-v1.openapi.yaml). */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
@RequireScope('campaigns.trigger')
export class PublicApiCampaignsController {
  constructor(
    private readonly triggers: ApiCampaignTriggerService,
    private readonly idempotent: IdempotentResponses,
  ) {}

  @Post('api-campaigns/:apiName/messages')
  @HttpCode(202)
  trigger(
    @Param('apiName') apiName: string,
    @Body(new ZodValidationPipe(TriggerRequestSchema)) body: TriggerRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, () => this.triggers.trigger(apiName.trim().toLowerCase(), body, keyOf(req)));
  }
}
