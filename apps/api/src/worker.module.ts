import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { MetricsModule } from './common/metrics/metrics.service.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { WorkerRuntimeModule } from './common/queue/processor.registry.js';
import { QueueModule } from './common/queue/queue.module.js';
import { StorageModule } from './common/storage/storage.service.js';
import { AuditModule } from './modules/audit/audit.service.js';
import { MetaModule } from './modules/meta/meta.module.js';
import { NotificationsModule } from './modules/notifications/notifications.service.js';
import { SettingsModule } from './modules/settings/settings.service.js';
import { WorkerFeaturesModule } from './worker-features.module.js';

/** Background worker: BullMQ processors only, no HTTP controllers (ADR-0002). */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    MetricsModule,
    WorkerRuntimeModule,
    AuditModule,
    NotificationsModule,
    SettingsModule,
    MetaModule,
    WorkerFeaturesModule,
  ],
})
export class WorkerModule {}
