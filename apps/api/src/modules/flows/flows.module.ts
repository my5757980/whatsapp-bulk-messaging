import { Global, Module } from '@nestjs/common';
import { InboxApiModule } from '../inbox/inbox.module.js';
import { FlowsController } from './definitions/flows.controller.js';
import { FlowsService } from './definitions/flows.service.js';
import { PublishService } from './definitions/publish.service.js';
import { ApiTestService } from './definitions/api-test.service.js';
import { ReservedKeywords } from './definitions/reserved-keywords.js';
import { FlowSecretsController } from './definitions/secrets.controller.js';
import { FlowSecretsService } from './definitions/secrets.service.js';
import { FlowSecretsVault } from './definitions/secrets-vault.js';
import { FlowVersionsController } from './definitions/versions.controller.js';
import { FlowVersionsService } from './definitions/versions.service.js';
import { FlowRouter } from './engine/flow-router.js';
import { FlowSessionService } from './engine/session.service.js';
import { TriggerMatcher } from './engine/trigger-matcher.js';
import { FlowStartController } from './live-chat/flow-start.controller.js';

// Chatbot flows wiring (feature 003, T011), following the 002 split: shared services in a global
// domain module (used by the 002 inbound handler in the worker and by live chat in the API), HTTP
// controllers in FlowsApiModule, and `flows` queue processors listed in WorkerFeaturesModule.

/** Flow services shared by the HTTP app and the worker. */
@Global()
@Module({
  providers: [FlowSessionService, FlowRouter, TriggerMatcher, FlowSecretsVault],
  exports: [FlowSessionService, FlowRouter, TriggerMatcher, FlowSecretsVault],
})
export class FlowsDomainModule {}

/** Flow builder endpoints (HTTP app only). */
@Module({
  imports: [FlowsDomainModule, InboxApiModule],
  providers: [FlowsService, PublishService, ReservedKeywords, FlowSecretsService, ApiTestService, FlowVersionsService],
  controllers: [FlowsController, FlowStartController, FlowSecretsController, FlowVersionsController],
})
export class FlowsApiModule {}
