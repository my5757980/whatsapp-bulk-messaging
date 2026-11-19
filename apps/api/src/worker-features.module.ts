import { Module } from '@nestjs/common';
import { AudienceUploadProcessor } from './modules/campaigns/audience-upload.processor.js';
import { CampaignProgressProcessor } from './modules/campaigns/campaign-progress.processor.js';
import { ScheduleReconcilerProcessor } from './modules/campaigns/schedule-reconciler.processor.js';
import { DomainModule } from './modules/domain.module.js';
import { ImportProcessor } from './modules/imports/import.processor.js';
import { InboundChatHandler } from './modules/inbox/inbound/inbound-chat.handler.js';
import { InboundMediaProcessor } from './modules/inbox/inbound/inbound-media.processor.js';
import { InboxDomainModule } from './modules/inbox/inbox.module.js';
import { InboxQueueProcessor } from './modules/inbox/inbox-queue.processor.js';
import { ReadReceiptProcessor } from './modules/inbox/messages/read-receipt.processor.js';
import { SessionSendProcessor } from './modules/inbox/messages/session-send.processor.js';
import { WindowCloseProcessor } from './modules/inbox/routing/window-close.processor.js';
import { RetentionProcessor, RetentionService } from './modules/maintenance/retention.processor.js';
import { NumberRefreshProcessor } from './modules/numbers/number-refresh.processor.js';
import { IdempotencyCleanupProcessor } from './modules/public-api/idempotency-cleanup.processor.js';
import { DispatcherProcessor } from './modules/sending/dispatcher.processor.js';
import { SendQueueManager } from './modules/sending/send-queue.manager.js';
import { SendProcessor } from './modules/sending/send.processor.js';
import { InboundHandler } from './modules/webhooks/handlers/inbound.handler.js';
import { QualityHandler } from './modules/webhooks/handlers/quality.handler.js';
import { StatusHandler } from './modules/webhooks/handlers/status.handler.js';
import { TemplateStatusHandler } from './modules/webhooks/handlers/template-status.handler.js';
import { WebhooksWorkerModule } from './modules/webhooks/webhooks.module.js';

/**
 * Background processors and webhook handlers (ADR-0002). Imported by the worker process and by
 * integration tests, which drive the processors directly with a stub ProcessorRegistry.
 */
@Module({
  imports: [DomainModule, WebhooksWorkerModule, InboxDomainModule],
  providers: [
    StatusHandler,
    InboundHandler,
    TemplateStatusHandler,
    QualityHandler,
    SendProcessor,
    SendQueueManager,
    DispatcherProcessor,
    AudienceUploadProcessor,
    ImportProcessor,
    CampaignProgressProcessor,
    ScheduleReconcilerProcessor,
    NumberRefreshProcessor,
    IdempotencyCleanupProcessor,
    RetentionService,
    RetentionProcessor,
    // Live chat (feature 002)
    InboundChatHandler,
    InboundMediaProcessor,
    ReadReceiptProcessor,
    InboxQueueProcessor,
    SessionSendProcessor,
    WindowCloseProcessor,
  ],
})
export class WorkerFeaturesModule {}
