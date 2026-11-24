import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { RetryPlanSchema, RetryPlanService, type RetryPlanInput } from './retry-plan.service.js';
import { RetryRoundsService } from './retry-rounds.service.js';

const RoundListQuerySchema = z.object({ status: z.enum(['SCHEDULED', 'RUNNING', 'DONE', 'CANCELLED', 'SKIPPED']).optional() });

/** Retry plans and rounds (contracts/growth-api.openapi.yaml, tag retries). */
@Controller()
export class RetriesController {
  constructor(
    private readonly plans: RetryPlanService,
    private readonly rounds: RetryRoundsService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get('campaigns/:id/retry-plan')
  @Require('campaigns.view')
  plan(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(id);
  }

  @Put('campaigns/:id/retry-plan')
  @Require('campaigns.manage')
  setPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RetryPlanSchema)) body: RetryPlanInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.plans.set(id, body, this.actor(user, req));
  }

  @Get('campaigns/:id/retry-rounds')
  @Require('campaigns.view')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.rounds.list(id);
  }

  @Post('campaigns/:id/retry-rounds/cancel')
  @HttpCode(200)
  @Require('campaigns.launch')
  cancelAll(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.rounds.cancelAll(id, this.actor(user, req));
  }

  @Post('campaigns/:id/retry-rounds/:round/cancel')
  @HttpCode(200)
  @Require('campaigns.launch')
  cancelOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('round', ParseIntPipe) round: number,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.rounds.cancelOne(id, round, this.actor(user, req));
  }

  @Get('retry-rounds')
  @Require('campaigns.view')
  listAll(@Query(new ZodValidationPipe(RoundListQuerySchema)) query: z.infer<typeof RoundListQuerySchema>) {
    return this.rounds.listAll(query.status);
  }
}
