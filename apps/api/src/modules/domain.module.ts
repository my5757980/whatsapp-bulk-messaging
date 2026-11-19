import { Global, Module } from '@nestjs/common';
import { ApiKeysController, ApiKeysService } from './api-keys/api-keys.service.js';
import { QueueDepthCollector } from '../common/metrics/queue-depth.collector.js';
import { AuditController } from './audit/audit.controller.js';
import { AudienceSnapshotService } from './campaigns/audience-snapshot.service.js';
import { AudienceUploadService } from './campaigns/audience-upload.service.js';
import { CampaignControlService } from './campaigns/campaign-control.service.js';
import { CampaignMessagesController } from './campaigns/campaign-messages.controller.js';
import { CampaignsController } from './campaigns/campaigns.controller.js';
import { CampaignsService } from './campaigns/campaigns.service.js';
import { DispatchScheduler } from './campaigns/dispatch-scheduler.js';
import { EstimateService } from './campaigns/estimate.service.js';
import { LaunchService } from './campaigns/launch.service.js';
import { RetargetService } from './campaigns/retarget.service.js';
import { ScheduleService } from './campaigns/schedule.service.js';
import { AttributesController } from './contacts/attributes.controller.js';
import { AudienceQueryBuilder } from './contacts/audience-query.builder.js';
import { ConsentService } from './contacts/consent.service.js';
import { ContactsController } from './contacts/contacts.controller.js';
import { ContactsService } from './contacts/contacts.service.js';
import { ContactDeletionController } from './contacts/contact-deletion.controller.js';
import { ContactDeletionService } from './contacts/contact-deletion.service.js';
import { TagsController } from './contacts/tags.controller.js';
import { ImportsController } from './imports/imports.controller.js';
import { ImportsService } from './imports/imports.service.js';
import { MediaController } from './media/media.controller.js';
import { MediaService } from './media/media.service.js';
import { MetaResumableUpload } from './media/meta-resumable-upload.js';
import { NumbersController } from './numbers/numbers.controller.js';
import { NumbersService } from './numbers/numbers.service.js';
import { IdempotencyService } from './public-api/idempotency.service.js';
import { PublicApiService } from './public-api/public-api.service.js';
import { PublicMessagesController } from './public-api/public-messages.controller.js';
import { PublicTemplatesController } from './public-api/public-templates.controller.js';
import { RateCardController, RateCardService } from './rate-card/rate-card.controller.js';
import { ApiMessagesController } from './reports/api-messages.controller.js';
import { ReportsController } from './reports/export.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { TemplatesSyncService } from './templates/templates-sync.service.js';
import { TemplatesController } from './templates/templates.controller.js';
import { TemplatesService } from './templates/templates.service.js';
import { InvitationsService } from './users/invitations.service.js';
import { MailerService } from './users/mailer.service.js';
import { InvitationsController, UsersController, UsersService } from './users/users.controller.js';

/** Domain services shared by the HTTP app and the worker (no controllers, no processors). */
@Global()
@Module({
  providers: [
    NumbersService,
    TemplatesSyncService,
    MediaService,
    ConsentService,
    ContactDeletionService,
    CampaignsService,
    AudienceSnapshotService,
    AudienceUploadService,
    EstimateService,
    LaunchService,
    CampaignControlService,
    DispatchScheduler,
    AudienceQueryBuilder,
    ContactsService,
    ImportsService,
    MetaResumableUpload,
    TemplatesService,
    ScheduleService,
    RateCardService,
    ReportsService,
    RetargetService,
    ApiKeysService,
    IdempotencyService,
    PublicApiService,
    QueueDepthCollector,
  ],
  exports: [
    NumbersService,
    TemplatesSyncService,
    MediaService,
    ConsentService,
    ContactDeletionService,
    CampaignsService,
    AudienceSnapshotService,
    AudienceUploadService,
    EstimateService,
    LaunchService,
    CampaignControlService,
    DispatchScheduler,
    AudienceQueryBuilder,
    ContactsService,
    ImportsService,
    MetaResumableUpload,
    TemplatesService,
    ScheduleService,
    RateCardService,
    ReportsService,
    RetargetService,
    ApiKeysService,
    IdempotencyService,
    PublicApiService,
  ],
})
export class DomainModule {}

/** HTTP endpoints for numbers, templates, media, campaigns, imports and contact deletion (US1). */
@Module({
  imports: [DomainModule],
  // Team management needs AuthService, which only the HTTP app loads; keeping these out of
  // DomainModule lets the worker boot without the auth module.
  providers: [MailerService, InvitationsService, UsersService],
  controllers: [
    NumbersController,
    TemplatesController,
    MediaController,
    CampaignsController,
    CampaignMessagesController,
    ImportsController,
    ContactDeletionController,
    ContactsController,
    TagsController,
    AttributesController,
    RateCardController,
    ReportsController,
    UsersController,
    InvitationsController,
    AuditController,
    ApiKeysController,
    PublicMessagesController,
    PublicTemplatesController,
    ApiMessagesController,
  ],
})
export class ApiFeaturesModule {}
