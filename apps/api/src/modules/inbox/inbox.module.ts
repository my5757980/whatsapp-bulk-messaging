import { Global, Module } from '@nestjs/common';
import { AgentRulesLoader } from './conversations/agent-rules.loader.js';
import { ConversationsController } from './conversations/conversations.controller.js';
import { ConversationsService } from './conversations/conversations.service.js';
import { ChatItemsService } from './messages/chat-items.service.js';
import { ChatMediaController } from './messages/chat-media.controller.js';
import { ChatTimelineService } from './messages/chat-timeline.service.js';
import { SessionSendService } from './messages/session-send.service.js';
import { InboxEventsService } from './realtime/inbox-events.service.js';
import { InboxPublisher } from './realtime/inbox-publisher.js';
import { InboxStreamController } from './realtime/inbox-stream.controller.js';
import { DEFAULT_INBOX_STREAM_OPTIONS, INBOX_STREAM_OPTIONS, StreamFanoutService } from './realtime/stream-fanout.service.js';

// Live chat wiring (feature 002, T022), following the 001 split: shared services here, HTTP-only
// endpoints in InboxApiModule, and worker processors listed in WorkerFeaturesModule (they need
// worker providers such as StatusHandler and SendQueueManager).

/** Live chat services shared by the HTTP app and the worker. */
@Global()
@Module({
  providers: [InboxEventsService, AgentRulesLoader, InboxPublisher, ChatTimelineService],
  exports: [InboxEventsService, AgentRulesLoader, InboxPublisher, ChatTimelineService],
})
export class InboxDomainModule {}

/** Live chat endpoints and the live event stream (HTTP app only). */
@Module({
  imports: [InboxDomainModule],
  providers: [
    StreamFanoutService,
    { provide: INBOX_STREAM_OPTIONS, useValue: DEFAULT_INBOX_STREAM_OPTIONS },
    ConversationsService,
    ChatItemsService,
    SessionSendService,
  ],
  controllers: [InboxStreamController, ConversationsController, ChatMediaController],
})
export class InboxApiModule {}
