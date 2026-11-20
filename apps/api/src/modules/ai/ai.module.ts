import { Global, Module } from '@nestjs/common';
import { AgentsController } from './agents/agents.controller.js';
import { AgentsService } from './agents/agents.service.js';
import { AgentPublishService } from './agents/publish.service.js';
import { ClaudeClient } from './claude/claude.client.js';
import { KnowledgeSearch } from './knowledge/knowledge-search.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';
import { UnansweredRecorder } from './knowledge/unanswered-recorder.js';
import { UnansweredController } from './knowledge/unanswered.controller.js';
import { UnansweredService } from './knowledge/unanswered.service.js';
import { AgentSelector } from './turns/agent-selector.js';
import { AiAgentRouter } from './turns/ai-router.js';
import { AiConversationsService } from './turns/ai-conversations.service.js';
import { TurnApplier } from './turns/apply.js';
import { TurnService } from './turns/turn.service.js';
import { AiUsageService } from './usage/usage.service.js';

// AI agent wiring (feature 004, T018), following 002 and 003: shared services in a global domain
// module (used by the 002 inbound handler in the worker and by live chat in the API), HTTP
// controllers in AiApiModule, and the `ai` and `ai-knowledge` processors in WorkerFeaturesModule.

const DOMAIN = [ClaudeClient, AiConversationsService, AgentSelector, AiAgentRouter, KnowledgeSearch, AiUsageService, UnansweredRecorder, TurnApplier, TurnService];

/** AI services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class AiDomainModule {}

/** AI agent, knowledge, usage and assistant endpoints (HTTP app only). */
@Module({
  imports: [AiDomainModule],
  providers: [AgentsService, AgentPublishService, KnowledgeService, UnansweredService],
  controllers: [AgentsController, KnowledgeController, UnansweredController],
})
export class AiApiModule {}
