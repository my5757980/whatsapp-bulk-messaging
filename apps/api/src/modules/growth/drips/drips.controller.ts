import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { DripResultsService, MetricPageQuerySchema, MetricQuerySchema, type MetricPageQuery, type MetricQuery } from './drip-results.service.js';
import { CreateDripSchema, DripSettingsSchema, DripStepsSchema, DripsService, type CreateDripInput, type DripSettingsInput, type DripStepsInput } from './drips.service.js';
import { EnrolInputSchema, EnrolmentListQuerySchema, EnrolmentsService, type EnrolInput, type EnrolmentListQuery } from './enrolments.service.js';

const DripListQuerySchema = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional() });
const NEWLINE = '\n';

/** Drip campaigns (contracts/growth-api.openapi.yaml, tag drips). */
@Controller('drips')
export class DripsController {
  constructor(
    private readonly drips: DripsService,
    private readonly enrolments: EnrolmentsService,
    private readonly results: DripResultsService,
    private readonly audit: AuditService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list(@Query(new ZodValidationPipe(DripListQuerySchema)) query: z.infer<typeof DripListQuerySchema>) {
    return this.drips.list(query.status);
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(CreateDripSchema)) body: CreateDripInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.drips.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DripSettingsSchema)) body: DripSettingsInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('campaigns.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.drips.remove(id, this.actor(user, req));
  }

  @Put(':id/steps')
  @Require('campaigns.manage')
  steps(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(DripStepsSchema)) body: DripStepsInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.replaceSteps(id, body, this.actor(user, req));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Require('campaigns.launch')
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.activate(id, this.actor(user, req));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Require('campaigns.launch')
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.pause(id, this.actor(user, req));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @Require('campaigns.launch')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.drips.archive(id, this.actor(user, req));
  }

  @Get(':id/enrolments')
  @Require('campaigns.view')
  enrolmentList(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(EnrolmentListQuerySchema)) query: EnrolmentListQuery) {
    return this.enrolments.list(id, query);
  }

  @Post(':id/enrolments')
  @HttpCode(200)
  @Require('campaigns.launch')
  enrol(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EnrolInputSchema)) body: EnrolInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.enrolments.enrol(id, body, this.actor(user, req));
  }

  @Post(':id/enrolments/preview')
  @HttpCode(200)
  @Require('campaigns.launch')
  preview(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EnrolInputSchema)) body: EnrolInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.enrolments.enrol(id, body, this.actor(user, req), true);
  }

  /** Contacts in, finished and left by reason, and each step's counts (feature 005 US6, FR-035). */
  @Get(':id/results')
  @Require('campaigns.view')
  dripResults(@Param('id', ParseUUIDPipe) id: string) {
    return this.results.results(id);
  }

  @Get(':id/results/contacts')
  @Require('campaigns.view')
  resultContacts(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(MetricPageQuerySchema)) query: MetricPageQuery) {
    return this.results.contacts(id, query);
  }

  /** The contacts behind one count as CSV, streamed; audited like 001 exports. */
  @Get(':id/results/export')
  @Require('data.export')
  async resultExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(MetricQuerySchema)) query: MetricQuery,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const drip = await this.results.assertDrip(id);
    const rows = this.results.batches(id, query);
    const first = await rows.next();
    await this.audit.record(this.actor(user, req), 'data.exported', { type: 'drip', id }, { view: `step ${query.metric.toLowerCase()}`, format: 'csv' });
    const fullPhones = can(user.role, 'phones.full');
    const slug = drip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'drip';
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="drip-${slug}-${query.metric.toLowerCase()}.csv"`);
    res.write(`phone,name${NEWLINE}`);
    for (let batch = first; !batch.done; batch = await rows.next()) {
      const chunk = batch.value.map((r) => [fullPhones ? (r.phone ?? '') : (maskPhone(r.phone) ?? ''), r.name ?? ''].map(csvField).join(',')).join(NEWLINE);
      if (!res.write(`${chunk}${NEWLINE}`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }

  @Delete(':id/enrolments/:enrolmentId')
  @HttpCode(204)
  @Require('campaigns.launch')
  async removeContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('enrolmentId', ParseUUIDPipe) enrolmentId: string,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.enrolments.remove(id, enrolmentId, this.actor(user, req));
  }
}
