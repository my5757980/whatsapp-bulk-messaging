import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { MetricsModule } from './common/metrics/metrics.service.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { QueueModule } from './common/queue/queue.module.js';
import { StorageModule } from './common/storage/storage.service.js';
import { AuditModule } from './modules/audit/audit.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ApiFeaturesModule } from './modules/domain.module.js';
import { HealthModule } from './modules/health/health.controller.js';
import { AiApiModule } from './modules/ai/ai.module.js';
import { FlowsApiModule } from './modules/flows/flows.module.js';
import { GrowthApiModule } from './modules/growth/growth.module.js';
import { InboxApiModule } from './modules/inbox/inbox.module.js';
import { MetaModule } from './modules/meta/meta.module.js';
import { NotificationsModule } from './modules/notifications/notifications.service.js';
import { SettingsModule } from './modules/settings/settings.service.js';
import { WebhooksApiModule } from './modules/webhooks/webhooks.module.js';

/** HTTP application (dashboard API, public API v1, Meta webhooks, live chat). */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    MetricsModule,
    AuditModule,
    AuthModule,
    NotificationsModule,
    SettingsModule,
    MetaModule,
    HealthModule,
    WebhooksApiModule,
    ApiFeaturesModule,
    InboxApiModule,
    FlowsApiModule,
    AiApiModule,
    GrowthApiModule,
  ],
})
export class AppModule {}
