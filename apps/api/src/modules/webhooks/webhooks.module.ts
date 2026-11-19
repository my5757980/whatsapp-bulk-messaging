import { Global, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookRouter } from './webhook-router.js';
import { WebhooksProcessor } from './webhooks.processor.js';

/** HTTP side: verification + ingestion only. */
@Module({ controllers: [WebhooksController] })
export class WebhooksApiModule {}

/** Worker side: router + processor. Feature handlers register on WebhookRouter. */
@Global()
@Module({ providers: [WebhookRouter, WebhooksProcessor], exports: [WebhookRouter] })
export class WebhooksWorkerModule {}
