# Tasks: Live Chat (Shared Team Inbox)

**Input**: Design documents from `/specs/002-team-inbox/`
**Prerequisites**: plan.md, spec.md, research.md (R1–R18), data-model.md, contracts/ (inbox-api.openapi.yaml, realtime-events.md, meta-graph-inbox.md), quickstart.md

**Tests**: REQUIRED. Constitution Principle V (Test-First) makes tests mandatory for every user story. Write them first and confirm they fail before implementing.

**Organization**: Tasks are grouped by user story, so each story can be built and tested on its own. UI wording is our own (plan.md, Principle II):

| Spec term | UI label |
|---|---|
| Active | Open |
| Requesting | Waiting for agent |
| Intervened | Taken |
| History | Past chats |
| Intervene | Take chat |
| Resolve | Close chat |
| Canned messages | Saved replies |

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1–US8 from spec.md

## Path Conventions

| Area | Path |
|---|---|
| API and worker | `apps/api/src/…`, tests in `apps/api/test/{unit,integration,contract}/…` |
| Web | `apps/web/src/…`, Playwright in `apps/web/e2e/…` |
| Shared | `packages/shared/src/…` |
| Simulator | `tools/mock-meta/src/…` |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependencies, configuration, permissions and simulator support used by every story.

- [X] T001 Add the `web-push` dependency to apps/api/package.json and update package-lock.json:
  - pin the newest release at least 2 weeks old, plus its types if separate (done: web-push ^3.6.7, since 4.0.0 is only 13 days old; @types/web-push ^3.6.4)
  - add optional `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` to apps/api/src/common/config/config.ts (all three or none, otherwise a ConfigError)
  - document all three in .env.example
- [X] T002 [P] Write failing unit tests for the new permissions in packages/shared/src/permissions.test.ts:
  - inbox.view, inbox.reply, inbox.monitor, canned.manage, media.manage, livechat.settings and inbox.metrics
  - role matrix per spec FR-041 and the header of contracts/inbox-api.openapi.yaml
  - then add the permissions to packages/shared/src/permissions.ts and rebuild `@wbm/shared`
- [X] T003 [P] Extend tools/mock-meta/src/server.ts (contracts/meta-graph-inbox.md §2–§4, §6):
  - accept free-form text/image/video/audio/document sends and emit sent/delivered/read webhooks like templates (numbers ending in 0000 fail with 131026)
  - answer `{status:"read"}` calls with `{success:true}`
  - serve `GET /{media-id}` (url, mime_type, file_size) and the download URL for test files
- [X] T004 [P] Extend the inbound CLI in tools/mock-meta/src/inbound-cli.ts:
  - flags `--name`, `--text`, `--image`, `--video`, `--audio --voice`, `--document`, `--sticker`, `--location lat,lng --label`, `--contact-card`, `--button-reply`, `--list-reply`, `--reaction --to-wamid`, `--unsupported`, `--at <offset>`
  - signed payloads per meta-graph-inbox.md §1
  - add sample media under samples/media/ (small jpg, pdf, ogg)
- [X] T005 [P] Add specs/002-team-inbox/contracts/inbox-api.openapi.yaml to the root `lint:contracts` script in package.json, and confirm `npm run lint:contracts` passes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema, pure rules, the realtime bus and queue priority. All stories depend on them.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for the foundation (write first, must fail) ⚠️

- [X] T006 [P] Unit tests for state transitions (data-model.md §4) in apps/api/test/unit/inbox/conversation-state.spec.ts:
  - first inbound → ACTIVE
  - keyword → REQUESTING (not from INTERVENED)
  - intervene from ACTIVE/REQUESTING only
  - transfer keeps INTERVENED with the new owner
  - resolve/auto-resolve → ACTIVE
  - a message arriving while in History keeps an INTERVENED owner, otherwise ACTIVE
- [X] T007 [P] Unit tests for the 24-hour helpers in apps/api/test/unit/inbox/window.spec.ts:
  - `windowEndsAt`, `isLive`, `inHistory`, `startsOpening` (null or >24 h → new opening)
  - boundaries exactly at 24 h, and time-zone independence
- [X] T008 [P] Unit tests for the visibility predicate (FR-026–FR-028, research R7) in apps/api/test/unit/inbox/visibility.spec.ts:
  - admins and managers see all
  - agents see ACTIVE/REQUESTING plus their own INTERVENED
  - tag and attribute rules match with OR; no rules = unrestricted
  - blocked contacts hidden from live lists
  - the in-memory checker used for SSE agrees with the SQL predicate on a table of cases (shared cases in apps/api/test/support/inbox-visibility-cases.ts; the SQL side runs in apps/api/test/integration/inbox-visibility.int-spec.ts)
- [X] T009 [P] Unit tests for inbound parsing in apps/api/test/unit/inbox/message-parser.spec.ts:
  - every type in meta-graph-inbox.md §1: text, image, video, audio/voice, document, sticker, location, contacts, button, interactive button/list/nfm, reaction, unsupported with `errors[]`, unknown type
  - context.id and contact profile names
- [X] T010 [P] Unit tests for SSE filtering and masking (realtime-events.md rules 1–2) in apps/api/test/unit/inbox/event-filter.spec.ts:
  - agents never get other agents' intervened chats or full phones
  - a `visible:false` upsert is sent when a chat leaves a user's view
- [X] T011 [P] Integration test for the realtime stream in apps/api/test/integration/inbox-realtime.int-spec.ts:
  - `GET /api/inbox/events` streams published events in order
  - a `: ping` arrives within 15 s
  - `Last-Event-ID` replays missed events and an expired ID gets `resync`
  - an agent receives only visible events
  - the presence key is set while connected and expires after disconnect
- [X] T012 [P] Integration test for send priority in apps/api/test/integration/inbox-send-priority.int-spec.ts: with 200 campaign send jobs queued on a number, a priority-1 session job is processed before the remaining campaign jobs and the rate limit still holds

### Implementation for the foundation

- [X] T013 Create the Prisma schema changes and migration (data-model.md §1–§2) in apps/api/prisma/schema.prisma and apps/api/prisma/migrations/20261120000000_live_chat/migration.sql:
  - new tables: conversations, chat_messages, conversation_openings, conversation_events, chat_read_markers, live_chat_settings (seed row id=1), agent_rules, canned_messages, canned_message_favorites, notification_preferences, push_devices
  - altered tables:
    - contacts: blocked_at, blocked_by_id, lead_source (back-filled), first_message_tag_id
    - messages: origin INBOX, sent_by_user_id, automatic
    - media_assets: purposes LIBRARY/INBOUND, display_name, uploaded_by_id
    - notification types: INBOX_REQUESTING, INBOX_TRANSFERRED, INBOX_MENTION
  - indexes and check constraints as listed
  - run `npm run db:generate -w @wbm/api`
- [X] T014 [P] Implement the pure transitions in apps/api/src/modules/inbox/conversations/conversation-state.ts (makes T006 pass)
- [X] T015 [P] Implement the 24-hour helpers in apps/api/src/modules/inbox/conversations/window.ts (makes T007 pass)
- [X] T016 [P] Implement the visibility predicate builder in apps/api/src/modules/inbox/conversations/visibility.ts (makes T008 pass):
  - `whereVisible(user, rules)` returning a Prisma `where` plus a raw SQL fragment
  - `canSee(user, rules, chatFacts)` for single-chat checks and SSE
  - an agent-rule loader with a 30 s cache (apps/api/src/modules/inbox/conversations/agent-rules.loader.ts)
  - done as a SQL fragment (`visibleSql`) plus the in-memory check; no Prisma `where`, because attribute rules compare text like `->>`, which Prisma JSON filters cannot express
- [X] T017 [P] Implement the inbound parser in apps/api/src/modules/inbox/inbound/message-parser.ts (makes T009 pass)
- [X] T018 Implement the event bus in apps/api/src/modules/inbox/realtime/inbox-events.service.ts:
  - `publish(envelope)` does XADD to `wbm:inbox:events` with `MAXLEN ~ 20000`
  - envelope types per data-model.md §5
- [X] T019 Implement fan-out and filtering in apps/api/src/modules/inbox/realtime/stream-fanout.service.ts and apps/api/src/modules/inbox/realtime/event-filter.ts (makes T010 pass):
  - one XREAD BLOCK tail per api instance, dispatched to connections
  - a contact facts cache invalidated by `contact.updated`
- [X] T020 Implement the SSE endpoint in apps/api/src/modules/inbox/realtime/inbox-stream.controller.ts (makes T011 pass):
  - `GET /inbox/events` with permission inbox.view
  - headers `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`, no compression
  - Last-Event-ID replay with XRANGE, `resync` when the ID is trimmed
  - 15 s ping, presence key `wbm:presence:{userId}` with a 45 s TTL
- [X] T021 Add job priorities to the send queues in apps/api/src/modules/sending/send-queue.manager.ts (makes T012 pass, research R3):
  - campaign `send` jobs explicitly priority 10 in apps/api/src/modules/sending/dispatcher.processor.ts
  - in apps/api/src/modules/sending/send-queue.manager.ts, route jobs named `session` to the session processor (registered in US1) and inbox `send` jobs (template) at priority 1
- [X] T022 Create the inbox module wiring in apps/api/src/modules/inbox/inbox.module.ts:
  - services into apps/api/src/modules/domain.module.ts (DomainModule)
  - controllers into ApiFeaturesModule
  - processors into apps/api/src/worker-features.module.ts
  - keep apps/api/test/integration/worker-boot.int-spec.ts green
- [X] T023 [P] Web realtime and navigation in apps/web/src/lib/inbox-events.ts and apps/web/src/lib/query.tsx:
  - an EventSource hook with reconnect/backoff and `resync`, applying events to TanStack Query caches
  - query keys for inbox lists, chat, items and unread
  - a "Live chat" entry with an unread badge in the dashboard sidebar (apps/web/src/components/layout/)

**Checkpoint**: Schema migrated, pure rules green, events stream through the proxy, priority works. User stories can start.

---

## Phase 3: User Story 1 - Receive and answer customers in live chat (Priority: P1) 🎯 MVP

**Goal**:
- Customers' messages appear live in Open.
- A member takes the chat, replies with text and closes it.
- The chat holds the full timeline: inbound types, campaign messages and ticks.

**Independent Test**: The mock-meta CLI sends "Is this available?". The chat appears in Open within 2 s. Take chat, reply "Yes" and the phone receives it with ticks. After Close chat, it is back in Open.

### Tests for User Story 1 (REQUIRED - Constitution Principle V) ⚠️

- [X] T024 [P] [US1] Integration test for the main journey in apps/api/test/integration/inbox-receive-reply.int-spec.ts:
  - inbound text creates the contact (source Organic) and an ACTIVE conversation, and back-fills earlier campaign/API messages as MESSAGE_REF
  - a repeated webhook adds nothing
  - an image enqueues the download, which ends READY (nock for Graph media)
  - two concurrent intervene calls have exactly one winner (409 ALREADY_TAKEN for the other)
  - a text reply queues a session job → Graph called once → status webhooks move it to READ
  - resolve → ACTIVE
  - a failed send shows its reason
  - a second agent cannot open the intervened chat (404)
  - `POST /read` clears unread and enqueues the read receipt
- [X] T025 [P] [US1] Contract tests in apps/api/test/contract/inbox.contract-spec.ts for:
  - GET /inbox/conversations, GET /inbox/conversations/{id}, GET /inbox/conversations/{id}/items
  - POST intervene, resolve and messages (text)
  - POST read, GET /inbox/unread
  - all checked against contracts/inbox-api.openapi.yaml
- [ ] T026 [P] [US1] Playwright e2e for the quickstart US1 row in apps/web/e2e/inbox-us1-live-chat.spec.ts, using the mock-meta CLI for the inbound message

### Implementation for User Story 1

- [X] T027 [US1] Implement the inbound chat pipeline in apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts, registered on the 001 WebhookRouter after the consent handler:
  - upsert the contact (name from the profile, lead_source Organic)
  - create or update the conversation (state per T014, last_customer_message_at, last_inbound_at, preview)
  - start an opening when T015 says so
  - insert chat_messages with `ON CONFLICT (wa_message_id) DO NOTHING`
  - publish `message.created` and `conversation.upserted`
- [X] T028 [P] [US1] Implement the inbound media download in apps/api/src/modules/inbox/inbound/inbound-media.processor.ts (research R4):
  - add MetaGraphClient methods `getMedia(token, mediaId)` and `downloadMedia(token, url)` in apps/api/src/modules/meta/meta-graph.client.ts
  - stream the file to S3 `media/inbound/{uuid}` and create a media_assets row (INBOUND)
  - 3 attempts, then media_state FAILED
  - publish `message.status`
- [X] T029 [US1] Implement the timeline in apps/api/src/modules/inbox/messages/chat-items.service.ts:
  - keyset paging `(occurred_at, id)`, newest first
  - MESSAGE_REF back-fill on conversation creation
  - DTO mapping per the ChatItem schema: campaign and template info joined from messages; media DTO
  - hook apps/api/src/modules/sending/send.processor.ts so successful campaign/API/inbox template sends append a MESSAGE_REF row when a conversation exists, and publish `message.created` (done in apps/api/src/modules/inbox/messages/chat-timeline.service.ts; only chat templates move a chat up the list)
- [X] T030 [US1] Implement the live list and detail in apps/api/src/modules/inbox/conversations/conversations.service.ts:
  - `list(view=live, state, mine, numberId, q, cursor)` with counts per tab
  - `getDetail` with basic fields, unread from chat_read_markers
  - `intervene` and `resolve` as atomic conditional updates (research R6), writing conversation_events and publishing `conversation.upserted`
- [X] T031 [US1] Implement free-form text sending in apps/api/src/modules/inbox/messages/session-send.service.ts and session-send.processor.ts (research R3):
  - in apps/api/src/modules/inbox/messages/session-send.service.ts:
    - validate the request
    - auto-intervene (FR-020)
    - check the window and the number (FR-013, FR-018)
    - insert a SESSION_OUT row (QUEUED)
    - enqueue `session` priority 1 on `send-{numberId}`
  - in apps/api/src/modules/inbox/messages/session-send.processor.ts:
    - claim QUEUED→SENDING
    - re-check the window (131047 or a closed window → FAILED, draft kept client-side)
    - add `sendSessionMessage` to MetaGraphClient
    - classify errors with the 001 classifier
    - store the wamid and publish `message.status`
- [X] T032 [US1] Route status webhooks for free-form messages in apps/api/src/modules/webhooks/handlers/status.handler.ts (research R11):
  - look up `messages.wa_message_id` first, then `chat_messages.wa_message_id`
  - shared precedence rules and timestamps
  - publish `message.status`
- [X] T033 [P] [US1] Implement read markers and receipts in apps/api/src/modules/inbox/messages/read-receipt.processor.ts and conversations.service.ts:
  - `POST /inbox/conversations/{id}/read` upserts the marker
  - enqueue `mark-read` at most once per chat per 10 s; it calls Graph `{status:"read"}`
  - `GET /inbox/unread` with a 10 s per-user cache
- [X] T034 [US1] Implement the controllers in apps/api/src/modules/inbox/conversations/conversations.controller.ts and apps/api/src/modules/inbox/messages/chat-media.controller.ts:
  - US1 endpoints of inbox-api.openapi.yaml: list, detail, items, intervene, resolve, messages (text), read, unread
  - `GET /inbox/media/{id}` streaming with visibility checks
  - permissions and phone masking (`@PhoneField`)
- [ ] T035 [US1] Build the Live chat page in apps/web/src/app/(dashboard)/inbox/page.tsx with apps/web/src/components/inbox/conversation-list.tsx and apps/web/src/components/inbox/chat-view.tsx:
  - three panes
  - Open, Waiting for agent and Taken tabs with counts; search; unread badges
  - a timeline renderer for every content type (picture preview, video/audio player, document download, map link, contact card, sticker, reaction on its message, chosen option, unsupported note)
  - campaign messages with names, and ticks
  - Take chat and Close chat
  - live updates from the T023 hook
- [ ] T036 [US1] Build the reply box in apps/web/src/components/inbox/composer.tsx:
  - text with native emoji input, up to 4096 characters
  - send shows the queued item at once and updates the ticks from events
  - an error toast with the reason; the draft kept on failure

**Checkpoint**: US1 works on its own (MVP).

---

## Phase 4: User Story 2 - The 24-hour window, History and restarting with a template (Priority: P1)

**Goal**:
- Every chat shows the time left in its window.
- Quiet chats move to Past chats.
- Templates restart conversations, with opt-in rules enforced.

**Independent Test**: A chat older than 24 hours is in Past chats with free text locked. Send template `order_confirmation` with params and it is delivered. The customer replies and the chat is live again.

### Tests for User Story 2 (REQUIRED - Constitution Principle V) ⚠️

- [X] T037 [P] [US2] Integration test in apps/api/test/integration/inbox-window-history.int-spec.ts:
  - `windowEndsAt` is shown
  - `view=history` lists only chats past 24 h
  - free-form text after 24 h gets 422 WINDOW_CLOSED at the request
  - a reply queued at 23:59:59 is not sent when the processor runs after 24 h (FAILED, reason shown)
  - a template from History creates a `messages` row (origin INBOX, sent_by_user_id) plus a MESSAGE_REF row and reaches READ
  - opted-out → 422 CONTACT_OPTED_OUT; marketing without opt-in → 422 NO_OPT_IN
  - a customer reply returns the chat to live as ACTIVE
  - the window-close job publishes `conversation.window_closed` within 60 s
  - `POST /inbox/conversations` opens or creates a chat for a contact
- [X] T038 [P] [US2] Add contract tests for POST /inbox/conversations, POST /inbox/conversations/{id}/template and `view=history` to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T039 [P] [US2] Playwright e2e for the quickstart US2 row in apps/web/e2e/inbox-us2-window-history.spec.ts

### Implementation for User Story 2

- [X] T040 [US2] Move the template consent and validation checks into apps/api/src/modules/sending/template-send-rules.ts:
  - extract them from apps/api/src/modules/public-api/public-api.service.ts into `assertTemplateSendable(contact, template, params, headerMedia)` in apps/api/src/modules/sending/template-send-rules.ts
  - reuse it from the public API (no behaviour change; the 001 public-api tests stay green)
- [X] T041 [US2] Implement template sends from a chat in apps/api/src/modules/inbox/messages/template-send.service.ts:
  - create a `messages` row (origin INBOX, sent_by_user_id), resolved params and header media through the 001 builders
  - enqueue the inbox `send` job at priority 1
  - add a MESSAGE_REF row and publish
- [X] T042 [US2] Implement History and starting chats in apps/api/src/modules/inbox/conversations/conversations.service.ts and conversations.controller.ts:
  - `view=history` in `list`
  - `POST /inbox/conversations` (open or create with back-fill)
  - `POST /inbox/conversations/{id}/template`
  - `canReply` and `windowEndsAt` in the DTOs
- [X] T043 [P] [US2] Implement the window-close notifier in apps/api/src/modules/inbox/routing/window-close.processor.ts: a maintenance scheduler every 60 s that publishes `conversation.window_closed` for chats whose 24-hour mark fell in the last minute
- [ ] T044 [US2] Build the History and template UI in apps/web/src/components/inbox/template-sender.tsx, conversation-list.tsx and composer.tsx:
  - a Past chats tab
  - a window countdown in the reply box; a lock with the explanation and "Send template" when closed
  - a template dialog: approved templates for the chat's number, inputs for variables and header media, preview, send
  - a "Message on WhatsApp" action on the contact page (apps/web/src/app/(dashboard)/contacts/[id]/page.tsx) that opens or creates the chat

**Checkpoint**: US1 and US2 both work on their own.

---

## Phase 5: User Story 3 - Team routing: requesting, transfer, auto-resolve, agent rules and filters (Priority: P2)

**Goal**:
- Customers can ask for a person.
- Chats can be transferred.
- Quiet chats close on their own when the setting is on.
- Agents can be limited by tags and attributes.
- Lists can be filtered.

**Independent Test**:
1. Send "agent": the chat is Waiting for agent and an alert appears.
2. A takes it and transfers it to B: B sees it and A does not.
3. With auto-close on, an aged chat closes.
4. Agent C with the rule tag Demo sees only Demo chats.

### Tests for User Story 3 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T045 [P] [US3] Integration test in apps/api/test/integration/inbox-routing.int-spec.ts:
  - **Keywords:**
    - a configured "talk to a person" keyword → REQUESTING, unresolved_requests +1, INBOX_REQUESTING notifications to members who can see the chat
    - a keyword while INTERVENED changes nothing except the counter
  - **Transfer:** owner → B works; a non-owner agent gets 409; a manager can transfer any chat; TARGET_CANNOT_SEE is refused; B gets an INBOX_TRANSFERRED notification
  - **Auto-resolve:** the job resolves INTERVENED chats idle for 24 h only when enabled, and logs AUTO_RESOLVED in the journey
  - **Agent rules:** with mixed tags and attributes on 100 chats, the agent sees exactly the matching ones (SC-008)
  - **Filters:** tagId, attribute and campaignId filters combine
  - **Deactivation:** deactivating a member resolves their chats to ACTIVE
- [ ] T046 [P] [US3] Add contract tests for transfer, `GET`/`PUT /users/{id}/agent-rules` and `GET`/`PUT /live-chat/settings` (keywords and auto-resolve fields) to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T047 [P] [US3] Playwright e2e for the quickstart US3 row in apps/web/e2e/inbox-us3-routing.spec.ts

### Implementation for User Story 3

- [ ] T048 [US3] Implement the live chat settings core in apps/api/src/modules/inbox/settings/live-chat-settings.service.ts and live-chat-settings.controller.ts:
  - get and put the singleton
  - validate `humanKeywords` (at most 5, normalised, unique) and `autoResolve`
  - working hours and automatic content are accepted and validated here but used in US6
  - audit the changes
- [ ] T049 [US3] Add "talk to a person" handling to apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts (research R13):
  - order: consent (001) → human keywords → rest
  - REQUESTING transition and counter, journey REQUESTED
  - in-app notifications through the 001 NotificationsService (types INBOX_REQUESTING)
  - publish
- [ ] T050 [US3] Implement transfer in apps/api/src/modules/inbox/conversations/conversations.service.ts and the controller:
  - guards: owner, or inbox.monitor; target active and can see the chat
  - journey TRANSFERRED, INBOX_TRANSFERRED notification, audit
- [ ] T051 [P] [US3] Implement auto-resolve in apps/api/src/modules/inbox/routing/auto-resolve.processor.ts: a maintenance scheduler every 5 min; when the setting is on, resolve INTERVENED chats with last_activity_at older than 24 h, close the opening and publish
- [ ] T052 [P] [US3] Implement agent rules in apps/api/src/modules/inbox/routing/agent-rules.service.ts and agent-rules.controller.ts:
  - replace-all PUT, validated: the user must be an AGENT, the tag exists, the attribute key is defined
  - invalidate the visibility cache, audit
- [ ] T053 [US3] Implement list filters and the deactivation hook in apps/api/src/modules/inbox/conversations/conversations.service.ts and apps/api/src/modules/users/users.controller.ts:
  - tagId, attribute (`key:value` → `attributes @>`) and campaignId (recipient of the campaign) filters in conversations.service.ts
  - in apps/api/src/modules/users/users.controller.ts (UsersService.update), deactivation resolves the member's INTERVENED chats
- [ ] T054 [P] [US3] Add the dev helper apps/api/scripts/inbox-age.ts with a root script `inbox:age` that shifts a chat's timestamps back by N hours (quickstart US3); it refuses to run when NODE_ENV=production
- [ ] T055 [US3] Build the routing UI in apps/web/src/components/inbox/chat-view.tsx and apps/web/src/app/(dashboard)/settings/live-chat/page.tsx:
  - a transfer menu in the chat header (apps/web/src/components/inbox/chat-view.tsx)
  - filter controls in conversation-list.tsx
  - keywords and auto-close settings in apps/web/src/app/(dashboard)/settings/live-chat/page.tsx (first section)
  - an agent rules editor on the team member row in apps/web/src/app/(dashboard)/settings/team/page.tsx

**Checkpoint**: US1–US3 work on their own.

---

## Phase 6: User Story 4 - Canned messages, media and the media library (Priority: P2)

**Goal**:
- Saved replies with variables, parameters, media and personal favourites; at most 200.
- A media library; media sends with limits.

**Independent Test**:
1. "/open" inserts "Hi Sara, we open at 9" and sends it.
2. A PDF from the library arrives.
3. A 20 MB video is refused before sending.

### Tests for User Story 4 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T056 [P] [US4] Unit tests for saved-reply rendering in apps/api/test/unit/inbox/canned-render.spec.ts:
  - `{first_name}`, `{name}`, `{last_name}`, `{phone}` and `{attr:key}` with fallbacks, or blank when there is none
  - `{{n}}` parameters required, and counted
  - WhatsApp formatting characters kept as is
  - unknown placeholders left untouched
- [ ] T057 [P] [US4] Unit tests for chat media limits (FR-015 table) in packages/shared/src/chat-media-limits.test.ts:
  - formats and sizes per type
  - error messages naming the type and the limit
- [ ] T058 [P] [US4] Integration test in apps/api/test/integration/inbox-canned-media.int-spec.ts:
  - CRUD; the 201st saved reply → 422 LIMIT_REACHED
  - favourites are per user and listed first
  - an agent gets 403 on create/update/delete
  - sending a saved text with params fills the variables
  - media library upload accepts and refuses per the limits
  - sending library media uploads to Meta once per number, then reuses the media ID (nock), with a session media payload carrying caption and filename
  - removing a library item keeps already-sent messages intact
- [ ] T059 [P] [US4] Add contract tests for /canned-messages (CRUD and favourite), /media-library (list, upload, delete) and messages of type media and canned to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T060 [P] [US4] Playwright e2e for the quickstart US4 row in apps/web/e2e/inbox-us4-saved-replies.spec.ts

### Implementation for User Story 4

- [ ] T061 [P] [US4] Implement saved-reply rendering in apps/api/src/modules/inbox/canned/canned-render.ts (makes T056 pass)
- [ ] T062 [P] [US4] Implement the chat media limits in packages/shared/src/chat-media-limits.ts, exported from packages/shared/src/index.ts (makes T057 pass)
- [ ] T063 [US4] Implement saved replies in apps/api/src/modules/inbox/canned/canned-messages.service.ts and canned-messages.controller.ts:
  - CRUD with the 200 limit (advisory-lock transaction) and unique names
  - favourites
  - list with favourites first and `parameterCount`
  - audit changes
- [ ] T064 [US4] Implement the media library in apps/api/src/modules/inbox/media-library/media-library.controller.ts:
  - upload (multipart, chat limits, media_assets LIBRARY with display_name and uploaded_by_id)
  - paged list by kind
  - delete (media.manage, audited)
- [ ] T065 [US4] Extend free-form sending for media and saved replies in apps/api/src/modules/inbox/messages/session-send.service.ts and session-send.processor.ts:
  - `type: media` (library asset → `ensureMetaMediaId` per number; or an https link) with caption and filename
  - `type: canned` renders with T061 and sends text or media
  - audio is sent without a caption
- [ ] T066 [US4] Build the saved replies and media UI in apps/web/src/app/(dashboard)/settings/saved-replies/page.tsx and apps/web/src/components/inbox/composer.tsx:
  - apps/web/src/app/(dashboard)/settings/saved-replies/page.tsx (list, create/edit with preview, delete)
  - apps/web/src/app/(dashboard)/settings/media-library/page.tsx
  - in the reply box (composer.tsx): a "/" picker (apps/web/src/components/inbox/saved-reply-picker.tsx) with favourites and parameter inputs
  - an attach button: from the computer (uploads to the library first, client-side limit pre-check with `@wbm/shared`) or from the library (apps/web/src/components/inbox/media-picker.tsx)

**Checkpoint**: US1–US4 work on their own.

---

## Phase 7: User Story 5 - Chat profile, customer journey and blocking (Priority: P2)

**Goal**:
- A profile panel with counters, source, first-message tag, campaigns, attributes and tags.
- An editable journey log.
- Blocking that filters incoming messages.

**Independent Test**:
1. The profile shows a masked phone for agents, the counts and the journey.
2. Blocking hides new messages.
3. Unblocking restores them.

### Tests for User Story 5 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T067 [P] [US5] Integration test in apps/api/test/integration/inbox-profile-block.int-spec.ts:
  - detail returns template/session counts, unresolved_requests, lead source, first-message tag, and at most 10 recent campaigns with status; phone masked for agents
  - PATCH from the chat (name, attributes, tags, first-message tag) needs contacts.manage, updates the contact and writes journey events
  - the journey merges events and campaign references, newest first, with actor types
  - block: a new inbound message is stored, with no SSE event, push or automatic reply, and the chat is hidden from live lists
  - a campaign still reaches a blocked (non-opted-out) contact
  - unblock restores live behaviour; blocking and unblocking are audited
- [ ] T068 [P] [US5] Add contract tests for GET journey, PATCH contact and POST/DELETE /contacts/{id}/block to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T069 [P] [US5] Playwright e2e for the quickstart US5 row in apps/web/e2e/inbox-us5-profile.spec.ts

### Implementation for User Story 5

- [ ] T070 [US5] Implement the journey in apps/api/src/modules/inbox/journey/journey.service.ts:
  - merge conversation_events with CAMPAIGN/API reference rows
  - write CONSENT_CHANGED events when the 001 keyword handler changes consent (hook in apps/api/src/modules/webhooks/handlers/inbound.handler.ts)
  - `GET /inbox/conversations/{id}/journey`
- [ ] T071 [US5] Complete the profile data in apps/api/src/modules/inbox/conversations/conversations.service.ts `getDetail`:
  - template and session message counts
  - lead source, first-message tag, consent fields
  - up to 10 recent campaigns
  - set lead_source on 001 contact-creation paths: public API → API, upload → "Campaign upload", import → "Import" (apps/api/src/modules/public-api/public-api.service.ts, apps/api/src/modules/contacts/consent.service.ts, apps/api/src/modules/imports/import.processor.ts)
- [ ] T072 [US5] Implement contact edits from a chat in apps/api/src/modules/inbox/conversations/conversations.controller.ts:
  - `PATCH /inbox/conversations/{id}/contact`, reusing the 001 ContactsService and tag services
  - journey TAG_ADDED, TAG_REMOVED, ATTRIBUTE_CHANGED and FIRST_MESSAGE_TAG_CHANGED
  - publish `contact.updated`
- [ ] T073 [US5] Implement blocking in apps/api/src/modules/inbox/conversations/block.controller.ts and inbound-chat.handler.ts:
  - endpoints in apps/api/src/modules/inbox/conversations/block.controller.ts: `POST`/`DELETE /contacts/{id}/block`, audited, journey events
  - in inbound-chat.handler.ts, a blocked contact stops after storing (no event, push or automatic reply)
  - blocked chats are excluded from live lists through the T016 predicate
- [ ] T074 [US5] Build the profile and journey UI in apps/web/src/components/inbox/profile-panel.tsx and apps/web/src/components/inbox/journey-list.tsx:
  - counters, source, first-message tag selector
  - campaigns with read ticks
  - attribute editing and tag add/create (permission-gated)
  - the journey list, and block/unblock with confirmation

**Checkpoint**: US1–US5 work on their own.

---

## Phase 8: User Story 6 - Working hours, welcome and off-hours messages (Priority: P3)

**Goal**: Automatic welcome and off-hours replies, sent exactly once, that respect keywords, blocking and opt-out.

**Independent Test**:
1. Hours that exclude now plus an away text: one off-hours reply only.
2. Hours that include now plus a welcome message: the welcome is sent once to a new number.

### Tests for User Story 6 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T075 [P] [US6] Unit tests for working hours in apps/api/test/unit/inbox/working-hours.spec.ts:
  - IANA time zones including DST zones
  - several ranges per day, closed days, range boundaries
  - validation rejects overlaps and start ≥ end
- [ ] T076 [P] [US6] Unit tests for the automatic-reply decision table (FR-035, FR-036) in apps/api/test/unit/inbox/auto-replies.spec.ts:
  - welcome only within hours on a new opening, once
  - off-hours outside hours, once per contact per 12 h
  - none for keywords, blocked or opted-out contacts
  - both off → nothing
- [ ] T077 [P] [US6] Integration test in apps/api/test/integration/inbox-auto-replies.int-spec.ts:
  - text/image/file content goes through the session path, and template content through the template path with variable fallbacks
  - each is sent exactly once under repeated inbound webhooks
  - items are labelled AUTOMATIC
  - `first_human_reply_at` is untouched
  - settings validation rejects an unapproved template
- [ ] T078 [P] [US6] Playwright e2e for the quickstart US6 row in apps/web/e2e/inbox-us6-auto-replies.spec.ts

### Implementation for User Story 6

- [ ] T079 [P] [US6] Implement working hours in apps/api/src/modules/inbox/automation/working-hours.ts (makes T075 pass)
- [ ] T080 [US6] Implement automatic replies in apps/api/src/modules/inbox/automation/auto-replies.service.ts (makes T076 pass, research R10):
  - called from inbound-chat.handler.ts after keywords
  - welcome guard: conditional update of `conversation_openings.welcome_sent_at`
  - off-hours guard: `SET NX EX 43200`
  - sends through session-send or template-send with `automatic: true`
- [ ] T081 [US6] Complete settings validation in apps/api/src/modules/inbox/settings/live-chat-settings.service.ts:
  - working hours shape and time zone
  - welcome/off-hours content: an approved template with variable mapping, or text, or a library image/file
  - "required when enabled"
- [ ] T082 [US6] Build the working hours and automatic message sections of apps/web/src/app/(dashboard)/settings/live-chat/page.tsx:
  - a weekday hours editor with time-zone select
  - welcome and off-hours editors: a template picker with variable mapping, or text, image or file from the library, with a preview
  - on/off switches

**Checkpoint**: US1–US6 work on their own.

---

## Phase 9: User Story 7 - Notifications: sound and push (Priority: P3)

**Goal**:
- A per-member sound preference.
- Up to 5 push devices that can be paused.
- Push only while the member is not connected.

**Independent Test**:
1. A chime plays with the sound on.
2. A push alert arrives with the tab closed.
3. A paused device gets nothing.

### Tests for User Story 7 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T083 [P] [US7] Integration test in apps/api/test/integration/inbox-notifications.int-spec.ts (web-push sender replaced by a fake):
  - preferences get/put
  - device registration; the 6th device → 422 DEVICE_LIMIT
  - pause and remove
  - push is sent only when the user has no presence key, for: an inbound message in a visible chat, REQUESTING, a transfer to them, a mention
  - payload phone masked for agents, preview at most 80 characters
  - a push-service 410 deletes the device
  - `GET /push/vapid-public-key` returns null when not configured
- [ ] T084 [P] [US7] Add contract tests for /me/notification-preferences, /me/push-devices and /push/vapid-public-key to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T085 [P] [US7] Playwright e2e for the quickstart US7 row in apps/web/e2e/inbox-us7-alerts.spec.ts:
  - grant the notification permission in the browser context
  - the sound toggle persists
  - device registration appears in the list, and pause/remove work
  - the push send itself is covered by T083

### Implementation for User Story 7

- [ ] T086 [US7] Implement the preferences and devices API in apps/api/src/modules/inbox/notifications/push-devices.controller.ts and notification-prefs.controller.ts:
  - apps/api/src/modules/inbox/notifications/notification-prefs.controller.ts
  - apps/api/src/modules/inbox/notifications/push-devices.controller.ts (limit 5, unique endpoint)
  - `GET /push/vapid-public-key`
- [ ] T087 [US7] Implement push sending in apps/api/src/modules/inbox/notifications/push.service.ts and inbox-notify.processor.ts:
  - `web-push` with VAPID from config, TTL 60
  - presence check (`wbm:presence:{userId}`), visibility check and masking
  - 404/410 → delete the device
  - triggered by an `inbox-notify` job from the inbound handler, REQUESTING, transfer and mentions
- [ ] T088 [US7] Build the notifications UI in apps/web/public/sw.js and apps/web/src/app/(dashboard)/account/notifications/page.tsx:
  - apps/web/public/sw.js: show the notification; on click, focus or open `/inbox?c={id}`
  - apps/web/src/app/(dashboard)/account/notifications/page.tsx: sound toggle; "Turn on alerts for this browser" (service worker registration + `PushManager.subscribe` with the VAPID key); device list with pause/remove
  - sound playback on inbound events in apps/web/src/lib/inbox-events.ts

**Checkpoint**: US1–US7 work on their own.

---

## Phase 10: User Story 8 - Internal notes and team monitoring (Priority: P3)

**Goal**:
- Team-only notes with mentions.
- Managers can monitor every chat.
- A team view with medians per member.

**Independent Test**:
1. A note with a mention is never sent to the customer, and the teammate is alerted.
2. The 7-day team view matches a manual count.

### Tests for User Story 8 (REQUIRED - Constitution Principle V) ⚠️

- [ ] T089 [P] [US8] Integration test in apps/api/test/integration/inbox-notes-metrics.int-spec.ts:
  - a note creates a NOTE item visible to the team; no Graph call (nock has no interceptor); mentions → INBOX_MENTION notification
  - openings: `first_human_reply_at` is set by the first member reply or template, not by automatic messages; intervene and resolve times are recorded
  - team metrics for today, 7d and 30d give counts and medians that match a fixture computed by hand
  - an agent gets 403 on the team view
  - a manager can open any intervened chat
- [ ] T090 [P] [US8] Add contract tests for POST notes and GET /inbox/team-metrics to apps/api/test/contract/inbox.contract-spec.ts
- [ ] T091 [P] [US8] Playwright e2e for the quickstart US8 row in apps/web/e2e/inbox-us8-team-view.spec.ts

### Implementation for User Story 8

- [ ] T092 [US8] Implement notes in apps/api/src/modules/inbox/messages/notes.service.ts and the controller:
  - `POST /inbox/conversations/{id}/notes`
  - mentions validated against active members who can see the chat
  - notifications and push (T087), publish `note.created`
- [ ] T093 [US8] Keep openings up to date in apps/api/src/modules/inbox/messages/session-send.service.ts, template-send.service.ts and conversations.service.ts:
  - set `first_human_reply_at` and `first_responder_id` in session-send.service.ts and template-send.service.ts for non-automatic sends
  - set intervened and resolved times in conversations.service.ts
- [ ] T094 [US8] Implement the team view in apps/api/src/modules/inbox/metrics/team-metrics.service.ts and team-metrics.controller.ts:
  - live counts by state, and the oldest REQUESTING time
  - per member: intervened, resolved, and `percentile_cont(0.5)` of first response and resolution over the openings in the period, in the company time zone
- [ ] T095 [US8] Build the notes and team view UI in apps/web/src/components/inbox/composer.tsx and apps/web/src/app/(dashboard)/inbox/team/page.tsx:
  - a note mode in composer.tsx with an @-mention picker; notes styled distinctly in chat-view.tsx
  - apps/web/src/app/(dashboard)/inbox/team/page.tsx with a period selector and a member table

**Checkpoint**: All stories work on their own.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: observability, retention, RBAC and audit coverage, performance, docs and CI.

- [ ] T096 [P] Extend retention and erasure, tests first, in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts:
  - apps/api/test/integration/retention.int-spec.ts: chat_messages, conversation_events and openings older than 12 months are purged; unreferenced INBOUND media and their S3 objects are deleted
  - apps/api/test/integration/contact-deletion.int-spec.ts: chat text, payload and media are erased; previews nulled; counts kept
  - then implement both in apps/api/src/modules/maintenance/retention.processor.ts and apps/api/src/modules/contacts/contact-deletion.service.ts
- [ ] T097 [P] Make apps/api/test/integration/rbac.int-spec.ts read x-permission from both contract files (001 dashboard and 002 inbox) and check every inbox operation for each role (FR-041). Fix any mismatch.
- [ ] T098 [P] Add the new audit actions to apps/api/src/modules/audit/audit-actions.ts and confirm apps/api/test/unit/audit-coverage.spec.ts passes:
  - inbox.intervened, inbox.transferred, inbox.resolved
  - contact.blocked, contact.unblocked
  - canned.created, canned.updated, canned.deleted
  - media.removed
  - livechat.settings_updated, agent_rules.updated
- [ ] T099 [P] Add the inbox metrics to apps/api/src/common/metrics/metrics.service.ts:
  - `wbm_inbox_messages_total{direction,kind}`, `wbm_inbox_event_lag_seconds`, `wbm_inbox_sse_connections`, `wbm_inbound_media_failures_total`
  - update the instrumentation points
  - add the alert "inbound media failures above 10% over 15 min" to ops/alerts.yml, and pass apps/api/test/unit/alerts.spec.ts and promtool
- [ ] T100 [P] Extend the log redaction list in apps/api/src/common/logging/redaction.ts to cover chat text, captions, notes and push endpoints, with a unit test in apps/api/test/unit/logging-redaction.spec.ts
- [ ] T101 [P] Add the performance seed and check in tools/perf/inbox-seed.ts and tools/perf/inbox-latency.ts:
  - seed 10,000 chats and one chat with 5,000 messages
  - measure list and chat-open times (SC-006) and webhook→SSE latency p95 (SC-001)
  - add root scripts `perf:inbox-seed` and `perf:inbox`
- [ ] T102 [P] Add a CI smoke step in .github/workflows/ci.yml: start the standalone web image and the api in the docker-images job, and assert that `GET /api/inbox/events` delivers a `: ping` through the proxy within 20 s
- [ ] T103 [P] Docs in README.md and specs/002-team-inbox/quickstart.md:
  - a Live chat section in README.md (UI terms, settings, push setup)
  - update specs/002-team-inbox/quickstart.md if steps changed
  - add an inbox section to specs/001-whatsapp-bulk-messaging/checklists/release.md
- [ ] T104 Run every quickstart.md row end to end (locally where memory allows, otherwise in CI), fix gaps, and record the results in specs/002-team-inbox/checklists/release.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. It blocks all user stories. T013 (migration) comes before the services, and T018–T020 (bus and SSE) come before any UI live updates.
- **User stories (Phases 3–10)**: depend on Foundational. In priority order:

  | Story | Priority | Depends on |
  |---|---|---|
  | US1 | P1 | the foundation |
  | US2 | P1 | US1's send and timeline |
  | US3 | P2 | US1's intervene |
  | US4 | P2 | US1's session send |
  | US5 | P2 | US1's inbound pipeline and detail |
  | US6 | P3 | US1's inbound pipeline, US2's template send, US3's settings core |
  | US7 | P3 | the SSE presence (T020) and US3 notifications |
  | US8 | P3 | US1's send and US3 transfer |

- **Polish (Phase 11)**: depends on the stories being complete.

### User Story Dependencies

- US2, US3, US4 and US5 each extend the US1 code paths. After US1 they can proceed in parallel by
  different developers, because they mostly touch different files.
- US6 depends on US2 (template send) and US3 (the settings core). US7 and US8 depend on US3's
  notification hooks.

### Within Each User Story

- Tests (unit, integration, contract, e2e) are written first and must fail.
- Pure rules come before services, services before controllers, and controllers before the UI.
- Commit after each task or logical group. The story checkpoint must pass before the next priority.

### Parallel Opportunities

- **Setup:** T002–T005 in parallel after T001.
- **Foundation:** tests T006–T012 in parallel, and pure modules T014–T017 in parallel.
- **Stories:** each story's test tasks in parallel. Within a story, [P] implementation tasks touch
  separate files.

---

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "T024 Integration test inbox-receive-reply.int-spec.ts"
Task: "T025 Contract tests for the US1 endpoints in inbox.contract-spec.ts"
Task: "T026 Playwright e2e inbox-us1-live-chat.spec.ts"

# Then independent implementation pieces:
Task: "T028 Inbound media download processor"
Task: "T033 Read markers and read receipts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup, then Phase 2 Foundation: migration, rules, SSE and priority.
2. Phase 3 US1: customers' messages appear live, and members take, reply and close.
3. **Stop and validate** with T024–T026 and the quickstart US1 row. This is already useful: replies
   to broadcasts are no longer lost.

### Incremental Delivery

1. Add US2 (window and History) next. It completes WhatsApp compliance for live chat.
2. Then US3 (routing), US4 (saved replies and media) and US5 (profile and block).
3. Then US6 (automatic replies), US7 (alerts) and US8 (notes and team view).
4. Polish last: retention, RBAC and audit coverage, metrics and alerts, performance, docs and CI.

Each story is tested and demoable on its own, and checkpoints follow every phase.

### Notes

- Mock Meta everywhere: nock in integration tests, mock-meta in e2e. No real WhatsApp sends.
- The local machine has 3.9 GB of RAM. Run integration tests in small batches; e2e and perf run in
  CI (feature 001 lessons).
- Keep feature 001 green. After touching shared code (send queue manager, status handler, public
  API rules, consent), re-run the 001 suites.
