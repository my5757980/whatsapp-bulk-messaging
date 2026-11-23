import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { PageQuerySchema } from '../../common/validation/pagination.js';
import { type UploadedFileData } from '../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AudienceUploadSchema, AudienceUploadService, MAX_UPLOAD_BYTES, type AudienceUploadInput } from './audience-upload.service.js';
import { CampaignControlService } from './campaign-control.service.js';
import {
  CampaignInputSchema,
  CampaignListQuerySchema,
  CampaignsService,
  CreateCampaignSchema,
  type CampaignInput,
} from './campaigns.service.js';
import { EstimateService } from './estimate.service.js';
import { LaunchSchema, LaunchService, type LaunchInput } from './launch.service.js';
import { RetargetSchema, RetargetService, type RetargetInput } from './retarget.service.js';
import { ScheduleService } from './schedule.service.js';

const ListQuerySchema = PageQuerySchema.extend(CampaignListQuerySchema.shape);

/** /campaigns (T091, T093, T095, T096, T105). */
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly uploads: AudienceUploadService,
    private readonly estimates: EstimateService,
    private readonly launches: LaunchService,
    private readonly control: CampaignControlService,
    private readonly schedules: ScheduleService,
    private readonly retargets: RetargetService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list(@Query(new ZodValidationPipe(ListQuerySchema)) query: ReturnType<typeof ListQuerySchema.parse>) {
    return this.campaigns.list(query);
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(CreateCampaignSchema)) body: CampaignInput & { name: string }, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user.id);
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CampaignInputSchema)) body: CampaignInput) {
    return this.campaigns.update(id, body);
  }

  @Delete(':id')
  @Require('campaigns.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.campaigns.remove(id);
  }

  @Post(':id/audience-upload')
  @Require('campaigns.manage')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileData | undefined,
    @Body(new ZodValidationPipe(AudienceUploadSchema)) body: AudienceUploadInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.uploads.start(id, file, body, user.id);
  }

  @Post(':id/estimate')
  @Require('campaigns.manage')
  @HttpCode(200)
  estimate(@Param('id', ParseUUIDPipe) id: string) {
    return this.estimates.estimate(id);
  }

  @Post(':id/launch')
  @Require('campaigns.launch')
  @HttpCode(200)
  launch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(LaunchSchema)) body: LaunchInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    const actor = this.actor(user, req);
    return body.scheduledAt ? this.schedules.schedule(id, { scheduledAt: body.scheduledAt, timezone: body.timezone }, actor) : this.launches.launch(id, body, actor);
  }

  @Post(':id/retarget')
  @Require('campaigns.manage')
  retarget(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RetargetSchema)) body: RetargetInput, @CurrentUser() user: RequestUser) {
    return this.retargets.retarget(id, body, user.id);
  }

  /** Group sizes before a retarget draft is made (feature 005, FR-011). */
  @Get(':id/retarget-groups')
  @Require('campaigns.view')
  retargetGroups(@Param('id', ParseUUIDPipe) id: string) {
    return this.retargets.groups(id);
  }

  @Post(':id/unschedule')
  @Require('campaigns.launch')
  @HttpCode(200)
  unschedule(@Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.unschedule(id);
  }

  @Post(':id/pause')
  @Require('campaigns.launch')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.control.pause(id, this.actor(user, req));
  }

  @Post(':id/resume')
  @Require('campaigns.launch')
  @HttpCode(200)
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.control.resume(id, this.actor(user, req));
  }

  @Post(':id/cancel')
  @Require('campaigns.launch')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.control.cancel(id, this.actor(user, req));
  }
}
