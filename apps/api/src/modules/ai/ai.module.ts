import { Global, Module } from '@nestjs/common';
import { ClaudeClient } from './claude/claude.client.js';
import { AiAgentRouter } from './turns/ai-router.js';
import { AiConversationsService } from './turns/ai-conversations.service.js';

// AI agent wiring (feature 004, T018), following 002 and 003: shared services in a global domain
// module (used by the 002 inbound handler in the worker and by live chat in the API), HTTP
// controllers in AiApiModule, and the `ai` and `ai-knowledge` processors in WorkerFeaturesModule.

/** AI services shared by the HTTP app and the worker. */
@Global()
@Module({
  providers: [ClaudeClient, AiConversationsService, AiAgentRouter],
  exports: [ClaudeClient, AiConversationsService, AiAgentRouter],
})
export class AiDomainModule {}

/** AI agent, knowledge, usage and assistant endpoints (HTTP app only). */
@Module({
  imports: [AiDomainModule],
  providers: [],
  controllers: [],
})
export class AiApiModule {}
