import { Global, Module } from '@nestjs/common';
import { AgentRulesLoader } from './conversations/agent-rules.loader.js';
import { InboxEventsService } from './realtime/inbox-events.service.js';
import { InboxStreamController } from './realtime/inbox-stream.controller.js';
import { DEFAULT_INBOX_STREAM_OPTIONS, INBOX_STREAM_OPTIONS, StreamFanoutService } from './realtime/stream-fanout.service.js';

// Live chat wiring (feature 002, T022), following the 001 split: shared services, HTTP-only
// endpoints and worker-only processors.

/** Live chat services shared by the HTTP app and the worker. */
@Global()
@Module({
  providers: [InboxEventsService, AgentRulesLoader],
  exports: [InboxEventsService, AgentRulesLoader],
})
export class InboxDomainModule {}

/** Live chat endpoints and the live event stream (HTTP app only). */
@Module({
  imports: [InboxDomainModule],
  providers: [StreamFanoutService, { provide: INBOX_STREAM_OPTIONS, useValue: DEFAULT_INBOX_STREAM_OPTIONS }],
  controllers: [InboxStreamController],
})
export class InboxApiModule {}

/** Live chat processors and webhook handlers (worker); they arrive with the user stories. */
@Module({
  imports: [InboxDomainModule],
})
export class InboxWorkerModule {}
