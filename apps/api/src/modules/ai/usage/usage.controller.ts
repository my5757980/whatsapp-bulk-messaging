import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AiSettingsSchema, AiUsageReportService, UsageQuerySchema, type AiSettingsInput, type UsageQuery } from './usage-report.service.js';

/** The AI usage page (004 T089, FR-037). */
@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly reports: AiUsageReportService) {}

  @Get()
  @Require('ai.usage')
  report(@Query(new ZodValidationPipe(UsageQuerySchema)) query: UsageQuery) {
    return this.reports.report(query);
  }
}

/** Monthly limits, prices and the limit message (004 T089, FR-038, FR-039). */
@Controller('ai-settings')
export class AiSettingsController {
  constructor(private readonly reports: AiUsageReportService) {}

  @Get()
  @Require('ai.usage')
  get() {
    return this.reports.settings();
  }

  @Put()
  @Require('ai.usage')
  update(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(AiSettingsSchema)) body: AiSettingsInput, @ClientIp() ip: string | null) {
    return this.reports.updateSettings(body, { userId: user.id, ip });
  }
}
