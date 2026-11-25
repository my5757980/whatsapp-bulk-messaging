import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import {
  ApiCampaignCreateSchema,
  ApiCampaignListQuerySchema,
  ApiCampaignPatchSchema,
  ApiCampaignsService,
  ResultsQuerySchema,
  type ApiCampaignCreate,
  type ApiCampaignPatch,
  type ResultsQuery,
} from './api-campaigns.service.js';

const NEWLINE = '\n';

/** API campaigns in the dashboard (feature 006 US3, contracts/integrations-api.openapi.yaml). */
@Controller('api-campaigns')
export class ApiCampaignsController {
  constructor(
    private readonly campaigns: ApiCampaignsService,
    private readonly audit: AuditService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list(@Query(new ZodValidationPipe(ApiCampaignListQuerySchema)) query: { status?: 'DRAFT' | 'LIVE' | 'PAUSED' | 'STOPPED' }) {
    return this.campaigns.list(query.status);
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(ApiCampaignCreateSchema)) body: ApiCampaignCreate, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ApiCampaignPatchSchema)) body: ApiCampaignPatch,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.campaigns.update(id, body, this.actor(user, req));
  }

  @Post(':id/go-live')
  @HttpCode(200)
  @Require('campaigns.launch')
  goLive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.goLive(id, this.actor(user, req));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Require('campaigns.launch')
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.pause(id, this.actor(user, req));
  }

  @Post(':id/stop')
  @HttpCode(200)
  @Require('campaigns.launch')
  stop(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.campaigns.stop(id, this.actor(user, req));
  }

  @Get(':id/results')
  @Require('campaigns.view')
  results(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ResultsQuerySchema)) query: ResultsQuery) {
    return this.campaigns.results(id, query);
  }

  /** Every trigger with its message status, as CSV; phones are masked without phones.full. */
  @Get(':id/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const campaign = await this.campaigns.assertExists(id);
    await this.audit.record(this.actor(user, req), 'data.exported', { type: 'api_campaign', id }, { view: 'api campaign triggers', format: 'csv' });
    const fullPhones = can(user.role, 'phones.full');
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="api-campaign-${campaign.apiName}.csv"`);
    res.write(`triggered_at,phone,outcome,reason,message_id,status,failure_reason${NEWLINE}`);
    for await (const page of this.campaigns.exportRows(id)) {
      const chunk = page
        .map((r) =>
          [r.createdAt.toISOString(), fullPhones ? (r.phone ?? '') : (maskPhone(r.phone) ?? ''), r.outcome, r.reason ?? '', r.messageId ?? '', r.status ?? '', r.failureReason ?? '']
            .map(csvField)
            .join(','),
        )
        .join(NEWLINE);
      if (!res.write(`${chunk}${NEWLINE}`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }
}
