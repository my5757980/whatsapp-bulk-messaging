import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { AppError } from '../../../common/errors/app-error.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AnalyticsQuerySchema, FlowAnalyticsService, type AnalyticsQuery } from './flow-analytics.service.js';

const STEP_ID = /^[a-z0-9_-]{1,40}$/;

/** /flows/{id}/analytics (contracts/flows-api.openapi.yaml, flows.manage). */
@Controller('flows')
export class FlowAnalyticsController {
  constructor(private readonly analytics: FlowAnalyticsService) {}

  @Get(':id/analytics')
  @Require('flows.manage')
  get(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(AnalyticsQuerySchema)) query: AnalyticsQuery) {
    return this.analytics.get(id, query);
  }

  @Get(':id/analytics/steps/:stepId/dropped')
  @Require('flows.manage')
  async dropped(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId') stepId: string,
    @Query(new ZodValidationPipe(AnalyticsQuerySchema)) query: AnalyticsQuery,
    @Res() res: Response,
  ): Promise<void> {
    if (!STEP_ID.test(stepId)) throw AppError.notFound('Step not found');
    const csv = await this.analytics.droppedCsv(id, stepId, query);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="flow-${id.slice(0, 8)}-${stepId}-dropped.csv"`);
    res.status(200).send(csv);
  }
}
