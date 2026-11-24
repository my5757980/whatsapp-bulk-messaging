import { Module } from '@nestjs/common';
import { AudienceUploadProcessor } from './modules/campaigns/audience-upload.processor.js';
import { CampaignProgressProcessor } from './modules/campaigns/campaign-progress.processor.js';
import { ScheduleReconcilerProcessor } from './modules/campaigns/schedule-reconciler.processor.js';
import { AiDomainModule } from './modules/ai/ai.module.js';
import { KnowledgeQueueProcessor } from './modules/ai/knowledge/knowledge-queue.processor.js';
import { KnowledgeProcessor } from './modules/ai/knowledge/knowledge.processor.js';
import { AiExpiryProcessor } from './modules/ai/turns/expiry.processor.js';
import { TurnProcessor } from './modules/ai/turns/turn.processor.js';
import { AssistantProcessor } from './modules/ai/assistant/assistant.runner.js';
import { AiQueueProcessor } from './modules/ai/turns/ai-queue.processor.js';
import { DomainModule } from './modules/domain.module.js';
import { ImportProcessor } from './modules/imports/import.processor.js';
import { InboundChatHandler } from './modules/inbox/inbound/inbound-chat.handler.js';
import { InboundMediaProcessor } from './modules/inbox/inbound/inbound-media.processor.js';
import { FlowsDomainModule } from './modules/flows/flows.module.js';
import { GrowthDomainModule } from './modules/growth/growth.module.js';
import { IntegrationsDomainModule } from './modules/integrations/integrations.module.js';
import { WebhookDeliveryProcessor } from './modules/integrations/webhooks/webhook-delivery.processor.js';
import { WebhookSweepProcessor } from './modules/integrations/webhooks/webhook-sweep.processor.js';
import { DripTickProcessor } from './modules/growth/drips/drip-tick.processor.js';
import { RetryRoundProcessor } from './modules/growth/retries/retry-round.processor.js';
import { FlowApiProcessor } from './modules/flows/steps/api-step.processor.js';
import { FlowExpiryProcessor } from './modules/flows/steps/expiry.processor.js';
import { FlowsQueueProcessor } from './modules/flows/steps/flows-queue.processor.js';
import { FlowTimerProcessor } from './modules/flows/steps/timer.processor.js';
import { InboxDomainModule } from './modules/inbox/inbox.module.js';
import { InboxQueueProcessor } from './modules/inbox/inbox-queue.processor.js';
import { InboxNotifyProcessor } from './modules/inbox/notifications/inbox-notify.processor.js';
import { PushService } from './modules/inbox/notifications/push.service.js';
import { ReadReceiptProcessor } from './modules/inbox/messages/read-receipt.processor.js';
import { SessionSendProcessor } from './modules/inbox/messages/session-send.processor.js';
import { WindowCloseProcessor } from './modules/inbox/routing/window-close.processor.js';
import { AutoResolveProcessor } from './modules/inbox/routing/auto-resolve.processor.js';
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
  imports: [DomainModule, WebhooksWorkerModule, InboxDomainModule, FlowsDomainModule, AiDomainModule, GrowthDomainModule, IntegrationsDomainModule],
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
    FlowsQueueProcessor,
    FlowTimerProcessor,
    FlowExpiryProcessor,
    FlowApiProcessor,
    // AI agent (feature 004)
    AiQueueProcessor,
    KnowledgeQueueProcessor,
    KnowledgeProcessor,
    TurnProcessor,
    AssistantProcessor,
    AiExpiryProcessor,
    InboxNotifyProcessor,
    PushService,
    SessionSendProcessor,
    WindowCloseProcessor,
    AutoResolveProcessor,
    // Campaign growth (feature 005)
    RetryRoundProcessor,
    DripTickProcessor,
    WebhookDeliveryProcessor,
    WebhookSweepProcessor,
  ],
})
export class WorkerFeaturesModule {}
