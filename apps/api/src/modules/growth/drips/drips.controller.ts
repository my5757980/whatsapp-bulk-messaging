import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { CreateDripSchema, DripSettingsSchema, DripStepsSchema, DripsService, type CreateDripInput, type DripSettingsInput, type DripStepsInput } from './drips.service.js';
import { EnrolInputSchema, EnrolmentListQuerySchema, EnrolmentsService, type EnrolInput, type EnrolmentListQuery } from './enrolments.service.js';

const DripListQuerySchema = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional() });

/** Drip campaigns (contracts/growth-api.openapi.yaml, tag drips). */
@Controller('drips')
export class DripsController {
  constructor(
    private readonly drips: DripsService,
    private readonly enrolments: EnrolmentsService,
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
