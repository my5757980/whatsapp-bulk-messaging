---
description: "Task list for the chatbot flow builder (feature 003)"
---

# Tasks: Chatbot Flow Builder

**Input**: Design documents from `/specs/003-chatbot-flow-builder/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (flows-api.openapi.yaml,
flow-graph.md, meta-graph-flows.md), quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation. Meta is mocked (nock, mock-meta); API-step endpoints are mocked with nock.

**Organization**: by user story (spec.md US1–US9), after Setup and Foundational phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US9); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: dependencies, permission, queue name and mock-meta support that every story needs.

- [X] T001 Add `@xyflow/react` pinned to `12.12.1` to apps/web/package.json, run `npm install`, and confirm `npm audit --audit-level=high` stays clean (research R13)
- [X] T002 [P] Add the permission `flows.manage` (ADMIN, MANAGER) to packages/shared/src/permissions.ts and extend packages/shared/src/permissions.test.ts (agents must not have it)
- [X] T003 [P] Add `FLOWS: 'flows'` to `QUEUES` in apps/api/src/common/queue/queue.constants.ts with a comment (timers and API steps, feature 003)
- [X] T004 [P] Extend mock-meta per contracts/meta-graph-flows.md §5: accept `type: interactive` (`button`, `list`) in tools/mock-meta/src/server.ts, validate the limits (400 with code 131009 when broken), and record them in `/mock/sent`; add `--button-id`, `--list-id` and `--context` to tools/mock-meta/src/inbound-cli.ts and tools/mock-meta/src/webhook-emitter.ts

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: schema, the graph contract, the engine core, sessions and the inbound hook. No story
can start before this phase is complete.

- [X] T005 Write the Prisma models and the migration apps/api/prisma/migrations/20261125000000_flows/migration.sql per data-model.md: tables `flows`, `flow_numbers`, `flow_versions`, `flow_triggers`, `flow_sessions`, `flow_session_steps`, `flow_secrets`; enums `FlowStatus`, `FlowVersionKind`, `FlowTriggerKind`, `KeywordMatch`, `FlowSessionStatus`, `FlowSessionResult`, `FlowWait`, `FlowStartedBy`; `ChatContentType` += `BUTTONS`, `LIST`; `JourneyEventType` += `FLOW_STARTED`, `FLOW_ENDED`; `JourneyActor` += `FLOW`; check constraint `cardinality(test_numbers) <= 3`; partial unique index `flow_sessions(conversation_id) WHERE status = 'RUNNING'`; citext unique name among non-deleted flows; update apps/api/prisma/schema.prisma to match
- [X] T006 [P] Unit tests for the graph schema in packages/shared/src/flows/graph.test.ts: the example in contracts/flow-graph.md parses; unknown fields, bad ids, duplicate step ids, a missing start step, 4 buttons, an 11th list row, titles over the limits and more than 200 steps are rejected
- [X] T007 Implement the graph schema in packages/shared/src/flows/graph.ts (zod 4, every step and trigger type of contracts/flow-graph.md, limits as exported constants) and export it from packages/shared/src/index.ts
- [X] T008 [P] Unit tests for the engine core in apps/api/test/unit/flows/run.spec.ts: starting runs message steps in order until the end; a missing `next` completes the session; 50 steps without customer input end with `FAILED` ("too many steps"); every run returns effects (send, end, step records) and a new `waitToken`
- [X] T009 Implement the pure interpreter and effect types in apps/api/src/modules/flows/engine/run.ts and apps/api/src/modules/flows/engine/effects.ts (inputs: start, customer message, button/list choice, timer, API result; output: next state + effects), covering the `message` and `end` steps for now
- [X] T010 Implement apps/api/src/modules/flows/engine/session.service.ts: start/continue/end inside one transaction with `pg_advisory_xact_lock` on the conversation id; create the session (handle the partial unique index as "already running"); apply effects: flow messages as 002 `chat_messages` (`SESSION_OUT`, origin `AUTOMATIC`, `payload.flow = {flowId, flowName, sessionId, stepId, test}`) queued with `sessionSendJob` and delays of 0 s, 1 s, 2 s… (research R6), step records in `flow_session_steps` (skipped for test sessions), journey `FLOW_STARTED`/`FLOW_ENDED` with actor `FLOW`, 002 live events for new items
- [X] T011 Create apps/api/src/modules/flows/flows.module.ts (a global `FlowsDomainModule` with the session service and router, and `FlowsApiModule` for controllers), register the `flows` queue processor skeleton in apps/api/src/modules/flows/steps/flows-queue.processor.ts (routes jobs by name), and wire the modules into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts
- [X] T012 Implement the router skeleton apps/api/src/modules/flows/engine/flow-router.ts (`onCustomerMessage` returns whether a flow handled the message) and call it from apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts after the message is stored and before `autoReplies.handle`, skipping welcome/off-hours when it returns true (research R5)
- [X] T013 [P] Unit tests for interactive payloads in apps/api/test/unit/inbox/interactive-payload.spec.ts (buttons with header/footer, lists with sections, ids and titles passed through), then build them in apps/api/src/modules/inbox/messages/session-send.processor.ts for the `BUTTONS` and `LIST` content types (contracts/meta-graph-flows.md §1–2)
- [X] T014 [P] Show `BUTTONS` and `LIST` items and the label "Automatic · {flow name}" (from `payload.flow`) in apps/web/src/components/inbox/chat-item-view.tsx, and add the content types to apps/web/src/lib/inbox-types.ts

**Checkpoint**: migrations apply, unit tests for the schema, engine core and interactive payloads pass, the worker boots with the flows module.

---

## Phase 3: User Story 1 - Build, publish and run a keyword flow with buttons (Priority: P1) 🎯 MVP

**Goal**: managers build a flow with a keyword trigger, message and buttons steps, publish it, and
customers get it in WhatsApp, visible in live chat.

**Independent Test**: publish "Opening hours" (keyword "hours", buttons Location/Talk to us), send
"HOURS please" from a test phone: buttons within 3 s, each tap follows its branch, the timeline shows
"Automatic · Opening hours".

### Tests for User Story 1 (REQUIRED) ⚠️

- [X] T015 [P] [US1] Unit tests for publish checks in packages/shared/src/flows/validate.test.ts: unreachable steps, unconnected required branches, a message without text or media, a buttons step without buttons; each problem names its step (`stepId`) and code from the contract
- [X] T016 [P] [US1] Unit tests for keyword matching in packages/shared/src/flows/triggers.test.ts: normalisation (case, spaces), exact beats contains, the longest contains phrase wins, ties by flow priority then age
- [X] T017 [P] [US1] Unit tests for buttons steps in apps/api/test/unit/flows/run-buttons.spec.ts: the session waits for input; a reply id `s:<session>:<token>:<key>` follows that button's branch; a reply with an old token or another session id is a stale tap (no move); a typed answer follows `onInvalid` or ends quietly
- [X] T018 [P] [US1] Integration test apps/api/test/integration/flows-build-publish.int-spec.ts: create a flow, save drafts (409 `DRAFT_CONFLICT` on an old revision), publish refused with problems (422 `PUBLISH_BLOCKED`), publish creates version 1 and `flow_triggers`; an inbound "What are your HOURS?" starts a session and queues a `BUTTONS` chat item with `payload.flow`; an interactive `button_reply` continues to the media message; the session ends `COMPLETED`; a later draft edit does not change what customers get until it is published; unpublish removes the triggers
- [X] T019 [P] [US1] Contract tests in apps/api/test/contract/flows.contract-spec.ts for `GET/POST /flows`, `GET/PATCH/DELETE /flows/{id}`, `POST /flows/{id}/duplicate`, `PUT /flows/{id}/draft`, `POST /flows/{id}/publish` (200 and 422) and `POST /flows/{id}/unpublish` against contracts/flows-api.openapi.yaml
- [X] T020 [P] [US1] Playwright e2e apps/web/e2e/flows-us1-keyword-buttons.spec.ts: build the flow in the editor (add a buttons step, connect both buttons, add a keyword trigger), publish, send the keyword with `npm run mock:inbound`, tap a button with `--button-id`, and check the live chat timeline

### Implementation for User Story 1

- [X] T021 [US1] Implement packages/shared/src/flows/validate.ts (publish checks for the step types so far, structured so later stories add rules) and packages/shared/src/flows/triggers.ts (keyword normalisation and matching order)
- [X] T022 [US1] Implement flow definitions in apps/api/src/modules/flows/definitions/flows.service.ts and flows.controller.ts: list (with `hasUnpublishedChanges`, trigger summaries, 7-day counts), create, get, patch (name, priority, numbers), duplicate, delete only when not published (409 `FLOW_PUBLISHED`), draft save with `draftRevision`; `flows.manage` on every route; audit `flow.created`, `flow.updated`, `flow.duplicated`, `flow.deleted`
- [X] T023 [US1] Implement apps/api/src/modules/flows/definitions/publish.service.ts: validate with the shared validator plus server checks (other published flows' exact keywords on overlapping numbers → `KEYWORD_TAKEN`), write a numbered `PUBLISHED` version, replace `flow_triggers`, set `published_version_id`; unpublish deletes triggers and marks the flow so running sessions end at their next step with `FLOW_UNPUBLISHED`; audit `flow.published`, `flow.unpublished`
- [X] T024 [US1] Implement apps/api/src/modules/flows/engine/trigger-matcher.ts: keyword triggers of published flows serving the message's number, in the shared matching order (no worker cache, research R2)
- [X] T025 [US1] Extend the engine and router for `buttons` steps: reply ids with session and wait token, stale taps treated as new messages, `onInvalid`; start sessions from keyword triggers in apps/api/src/modules/flows/engine/flow-router.ts
- [X] T026 [US1] Add the flows list page apps/web/src/app/(dashboard)/flows/page.tsx (name, status, published version, triggers, last 7 days, create dialog) and the "Flows" navigation item for `flows.manage` in apps/web/src/app/(dashboard)/layout.tsx
- [X] T027 [US1] Build the editor apps/web/src/app/(dashboard)/flows/[id]/page.tsx with apps/web/src/components/flows/flow-canvas.tsx (React Flow: add, move, connect, copy, delete, zoom, 20-step undo), node views and forms for message (002 media picker) and buttons steps in apps/web/src/components/flows/steps/, the keyword trigger panel, autosave 1 s after changes with conflict reload, the problems panel linked to steps, and publish/unpublish buttons

**Checkpoint**: US1 works on its own (MVP).

---

## Phase 4: User Story 2 - Ask questions, validate answers and save them to the contact (Priority: P1)

**Goal**: question and list steps with validation, retries, timeouts and attribute saving.

**Independent Test**: run "Book a visit" answering one question wrongly twice: retries arrive, the
contact's attributes hold the right values, the final message shows them; a 1-minute timeout sends
the timeout message.

### Tests for User Story 2 (REQUIRED) ⚠️

- [X] T028 [P] [US2] Unit tests for answers in packages/shared/src/flows/answers.test.ts: text length; numbers (decimals, integer, min/max); email; phone normalised to E.164 with the default country; dates in several written forms, "today"/"tomorrow", earliest/latest
- [X] T029 [P] [US2] Unit tests for question and list steps in apps/api/test/unit/flows/run-questions.spec.ts: retry prompt up to `retries`, then `onInvalid`; media when text is expected is invalid; valid answers stored under `answerName` and an attribute effect when `saveTo` is set; list choice by row id and `sharedNext`; timeout follows `onTimeout` or ends with `TIMED_OUT`; fallbacks in texts
- [X] T030 [P] [US2] Integration test apps/api/test/integration/flows-questions.int-spec.ts: "Book a visit" end to end through webhooks; invalid date twice; attributes saved on the contact with journey entries by the flow; the timeout timer job (processed directly) runs the timeout branch; a stale timer (old token) does nothing; a session idle for 24 hours is ended `EXPIRED` by the expiry job
- [X] T031 [P] [US2] Playwright e2e apps/web/e2e/flows-us2-questions.spec.ts: build question and list steps in the editor, answer from mock inbound, and check the profile panel's attributes

### Implementation for User Story 2

- [X] T032 [US2] Implement packages/shared/src/flows/answers.ts (validators and normalisers per contracts/flow-graph.md "Answer kinds")
- [X] T033 [US2] Extend the engine for `question` and `list` steps (input waits, retries, `onInvalid`, `onTimeout`, answers, attribute effects with type checks) and add variable rendering in apps/api/src/modules/flows/engine/render.ts (002 saved-reply syntax plus `{answer:name}` and per-step fallbacks)
- [X] T034 [US2] Implement timers: schedule `flow-timer {sessionId, waitToken}` delayed jobs from session effects, process them in apps/api/src/modules/flows/steps/timer.processor.ts (ignore stale tokens), and add apps/api/src/modules/flows/steps/expiry.processor.ts (every 5 minutes, end sessions idle for 24 hours with `EXPIRED`)
- [X] T035 [US2] Add publish rules to packages/shared/src/flows/validate.ts and the server check in publish.service.ts: unique answer names, `saveTo` attributes exist with a compatible type (`UNKNOWN_ATTRIBUTE`, `ATTRIBUTE_TYPE`), list limits
- [X] T036 [US2] Add question and list node views and forms (answer kind options, retries, retry text, timeout, attribute picker, fallbacks editor) in apps/web/src/components/flows/steps/

**Checkpoint**: US1 and US2 work on their own.

---

## Phase 5: User Story 3 - Hand over to people and share the chat with live chat (Priority: P1)

**Goal**: flows and people never talk over each other; consent and blocking rules hold; members can
start a flow from a chat.

**Independent Test**: a flow reaches hand-over (chat under Waiting for agent); an agent takes it and
replies (the flow stays quiet); after closing, the keyword starts the flow again; STOP ends a flow
with no flow reply.

### Tests for User Story 3 (REQUIRED) ⚠️

- [X] T037 [P] [US3] Integration test apps/api/test/integration/flows-live-chat.int-spec.ts: hand-over moves the chat to REQUESTING with the 002 alert and ends `HANDED_OVER`; take, reply and template from a member end the session `STOPPED_BY_MEMBER`; no session starts while REQUESTING or INTERVENED; after resolve the keyword starts it; STOP ends `OPTED_OUT` with nothing sent; a blocked contact starts nothing; the welcome message is not sent when a flow answers a new contact; the "talk to a person" keyword during a flow ends it `HANDED_OVER`; starting a flow from a chat works with the window open and is refused with `WINDOW_CLOSED` otherwise
- [X] T038 [P] [US3] Contract tests in apps/api/test/contract/flows.contract-spec.ts for `GET/POST /inbox/conversations/{id}/flows` and `GET /inbox/conversations/{id}/flow-session`
- [X] T039 [P] [US3] Playwright e2e apps/web/e2e/flows-us3-live-chat.spec.ts: hand-over shows the chat under Waiting for agent with the answers in the timeline; **Start a flow** from a chat; the running-flow banner appears and disappears when the member replies

### Implementation for User Story 3

- [X] T040 [US3] Implement the `handover` step effect (move the chat to REQUESTING through the 002 routing service with its alerts; add the optional note as a 002 NOTE item) in apps/api/src/modules/flows/engine/run.ts and apps/api/src/modules/flows/engine/session.service.ts
- [X] T041 [US3] Complete the routing rules in apps/api/src/modules/flows/engine/flow-router.ts (research R5): Open-only except member-started sessions, opt-out ends with `OPTED_OUT`, "talk to a person" ends with `HANDED_OVER`, blocked contacts ignored, `canInterrupt` triggers end the old session with `INTERRUPTED`
- [X] T042 [US3] Stop running sessions on member actions: call `FlowSessionService.stopForConversation()` from `take` in apps/api/src/modules/inbox/conversations/conversations.service.ts and from apps/api/src/modules/inbox/messages/session-send.service.ts and template-send.service.ts
- [X] T043 [US3] Implement apps/api/src/modules/flows/live-chat/flow-start.controller.ts: `GET /inbox/conversations/{id}/flows` (published flows serving the chat's number), `POST` (start with `started_by = MEMBER`; refuse `WINDOW_CLOSED`, `CHAT_TAKEN_BY_OTHER`, `CONTACT_BLOCKED`, `CONTACT_OPTED_OUT`, `FLOW_NOT_PUBLISHED`), `GET .../flow-session`; `inbox.reply`/`inbox.view` with 002 visibility
- [X] T044 [US3] Add **Start a flow** and the running-flow banner to the chat in apps/web/src/components/inbox/flow-start.tsx and apps/web/src/components/inbox/chat-view.tsx (refresh on 002 live events)

**Checkpoint**: US1–US3 (the P1 release) work together.

---

## Phase 6: User Story 4 - Conditions, tags, attributes, delays and jumps (Priority: P2)

**Goal**: logic steps that change data and route customers.

**Independent Test**: a flow branching on working hours and the tag "VIP" takes the right branch in
each case; a jump continues in "Main menu".

### Tests for User Story 4 (REQUIRED) ⚠️

- [X] T045 [P] [US4] Unit tests for conditions in packages/shared/src/flows/conditions.test.ts: every operator per subject, `all`/`any`, case-insensitive text, numbers and dates, tags, consent, working hours with a time zone
- [X] T046 [P] [US4] Unit tests in apps/api/test/unit/flows/run-logic.spec.ts (tags and attribute effects, condition branches, delay waits with a timer, jump ends with branch `jumped` and starts the target, end) and loop checks in packages/shared/src/flows/validate.test.ts (cycle without a waiting step refused, cycle with a question allowed)
- [X] T047 [P] [US4] Integration test apps/api/test/integration/flows-logic.int-spec.ts: tags and attributes change on the contact with journey entries by the flow; working-hours branch; a 5-second delay processed through its timer; a jump to a published flow; two flows jumping to each other without a question cannot be published (`LOOP_WITHOUT_WAIT`); a jump to an unpublished flow is refused (`JUMP_TARGET_NOT_PUBLISHED`)
- [X] T048 [P] [US4] Playwright e2e apps/web/e2e/flows-us4-logic.spec.ts: build a condition with two rules and a tag step in the editor and verify both branches from mock inbound

### Implementation for User Story 4

- [X] T049 [US4] Implement packages/shared/src/flows/conditions.ts
- [X] T050 [US4] Extend apps/api/src/modules/flows/engine/run.ts and apps/api/src/modules/flows/engine/session.service.ts for `tags`, `attributes`, `condition` (facts: contact fields, attributes, tags, consent, 002 working hours), `delay` (timer) and `jump` (child session with `parent_session_id`, `started_by = JUMP`)
- [X] T051 [US4] Add loop detection (following jumps into published targets) and jump-target checks to packages/shared/src/flows/validate.ts and publish.service.ts
- [X] T052 [US4] Add node views and forms for tags, attributes, condition (rule builder), delay, jump and end in apps/web/src/components/flows/steps/

**Checkpoint**: US1–US4 work on their own.

---

## Phase 7: User Story 5 - Call an external system from a flow (Priority: P2)

**Goal**: API steps with safe HTTPS calls, mapping, secrets and a test request.

**Independent Test**: an API step against an endpoint returning `{"status":"shipped"}` shows
"shipped"; a slow endpoint takes the failed branch within the timeout.

### Tests for User Story 5 (REQUIRED) ⚠️

- [X] T053 [P] [US5] Unit tests in apps/api/test/unit/flows/api-client.spec.ts: private, loopback, link-local, multicast and reserved IPv4/IPv6 addresses are refused; only HTTPS; redirects are not followed; timeout; replies over 100 KB and non-JSON replies fail; dotted path mapping (`order.status`, `items.0.name`)
- [X] T054 [P] [US5] Integration test apps/api/test/integration/flows-api-step.int-spec.ts with nock: variables and `{secret:<id>}` filled in the request; success maps fields into answers and the next message; timeout and 500 take the failed branch; secrets are stored encrypted, never returned and never logged; `POST /flows/{id}/api-test` returns status, body and mapped fields
- [X] T055 [P] [US5] Contract tests in apps/api/test/contract/flows.contract-spec.ts for `/flows/{id}/secrets` (POST, PUT, DELETE) and `/flows/{id}/api-test`
- [X] T056 [P] [US5] Playwright e2e apps/web/e2e/flows-us5-api-step.spec.ts: configure an API step with a secret header (shown masked after saving) and run **Test request** against `https://10.0.0.5`, which reports a blocked address

### Implementation for User Story 5

- [X] T057 [US5] Implement apps/api/src/modules/flows/steps/api-client.ts (Node `fetch` with an undici `Agent` whose lookup refuses non-public addresses, HTTPS only, no redirects, timeout, 100 KB cap, JSON parsing and path mapping)
- [X] T058 [US5] Implement the API step: the engine pauses with `wait = API` and queues `flow-api {sessionId, waitToken}`; apps/api/src/modules/flows/steps/api-step.processor.ts renders the request (variables, secrets), calls, maps and resumes the session on `success` or `failed`
- [X] T059 [US5] Implement secrets and the test request in apps/api/src/modules/flows/definitions/secrets.service.ts and the controller (encrypt with 001 `TokenCipher`; names only in responses; delete refused when used with `SECRET_IN_USE`; audit `flow.secret_changed`) plus `POST /flows/{id}/api-test`
- [X] T060 [US5] Add the API step form (method, URL, headers with a secret picker, query, JSON body, timeout, mapping picked from the test result) and the secrets panel in apps/web/src/components/flows/steps/api-step-form.tsx and apps/web/src/components/flows/secrets-panel.tsx

**Checkpoint**: US1–US5 work on their own.

---

## Phase 8: User Story 6 - More triggers: template buttons, patterns and first messages (Priority: P2)

**Goal**: flows start from template quick-reply buttons, patterns and first-message rules, with a
clear matching order.

**Independent Test**: tapping a campaign template's "Yes, interested" starts "Lead follow-up"; a new
contact's "I saw your ad for the sofa" sets the first-message tag and starts the linked flow.

### Tests for User Story 6 (REQUIRED) ⚠️

- [X] T061 [P] [US6] Unit tests in packages/shared/src/flows/triggers.test.ts and apps/api/test/unit/flows/pattern-match.spec.ts: the safe-pattern check refuses nested quantifiers; a catastrophic pattern returns "no match" within the time limit; pattern after keywords in the order; first-message rules only for a first message; reserved keywords refused
- [X] T062 [P] [US6] Integration test apps/api/test/integration/flows-triggers.int-spec.ts: a template quick-reply reply with `context.id` of a 001 campaign message starts the linked flow; a pattern trigger stores the matched text as an answer; a first-message rule sets the contact's first-message tag (and starts its flow) only on the first message; an exact keyword beats a contains keyword; a `canInterrupt` trigger replaces a running session (`INTERRUPTED`); a duplicate exact keyword on the same number is refused at publish (`KEYWORD_TAKEN`)
- [X] T063 [P] [US6] Playwright e2e apps/web/e2e/flows-us6-triggers.spec.ts: add a first-message rule with a tag in the trigger panel, send a first message from a new number, and check the profile's first-message tag

### Implementation for User Story 6

- [X] T064 [US6] Add pattern triggers: the safe-pattern check in packages/shared/src/flows/triggers.ts and time-limited matching with `node:vm` in apps/api/src/modules/flows/engine/trigger-matcher.ts (research R3)
- [X] T065 [US6] Add template-button triggers (resolve `context.id` → `messages.wa_message_id` → template, match the button text) and first-message rules (detect the contact's first inbound message, set `first_message_tag_id` with a journey entry by the flow, optionally start the flow) in apps/api/src/modules/flows/engine/trigger-matcher.ts and apps/api/src/modules/flows/engine/flow-router.ts
- [X] T066 [US6] Extend the trigger panel for all kinds (template and button pickers from the 001 templates API, tag picker, "can interrupt") in apps/web/src/components/flows/trigger-panel.tsx

**Checkpoint**: US1–US6 work on their own.

---

## Phase 9: User Story 7 - Test drafts before publishing (Priority: P2)

**Goal**: test numbers run the draft; versions, revisions and restore; unpublishing ends sessions.

**Independent Test**: with a test number, the draft text reaches the test phone and the published text
reaches other phones.

### Tests for User Story 7 (REQUIRED) ⚠️

- [X] T067 [P] [US7] Integration test apps/api/test/integration/flows-testing.int-spec.ts: test numbers run the draft (sessions `is_test`, items marked test, no step records); other numbers get the published version or nothing; a 4th test number is refused; unpublish ends running sessions at their next message (`FLOW_UNPUBLISHED`); sessions on version 3 finish on version 3 after version 4 is published; revisions are pruned to 20; restore copies a version into the draft
- [X] T068 [P] [US7] Contract tests in apps/api/test/contract/flows.contract-spec.ts for `GET /flows/{id}/versions` and `POST /flows/{id}/versions/{versionId}/restore`
- [X] T069 [P] [US7] Playwright e2e apps/web/e2e/flows-us7-testing.spec.ts: add a test number, change the draft, and compare what the test number and another number receive

### Implementation for User Story 7

- [X] T070 [US7] Route test numbers to the draft in apps/api/src/modules/flows/engine/flow-router.ts and apps/api/src/modules/flows/engine/trigger-matcher.ts (draft triggers evaluated in memory, research R2); validate test numbers (E.164, at most 3) in apps/api/src/modules/flows/definitions/flows.service.ts; audit `flow.test_numbers_updated`
- [X] T071 [US7] Implement apps/api/src/modules/flows/definitions/versions.service.ts and controller routes: autosave revisions (at most one per minute, keep 20), list versions, restore into the draft; audit `flow.restored`
- [X] T072 [US7] Add the test panel (test numbers, the trail of the last test session) and the versions drawer with restore in apps/web/src/components/flows/test-panel.tsx and apps/web/src/components/flows/versions-drawer.tsx (the trail of the last test session is left for later: test runs show in live chat, marked test)

**Checkpoint**: US1–US7 work on their own.

---

## Phase 10: User Story 8 - Flow analytics (Priority: P3)

**Goal**: results per flow and counts per step and option, with a CSV of drop-offs.

**Independent Test**: 10 sessions with 4 drop-offs at the second question show 10 started, 4 timed
out, 4 dropped at that step, and the CSV lists those 4 contacts.

### Tests for User Story 8 (REQUIRED) ⚠️

- [X] T073 [P] [US8] Integration test apps/api/test/integration/flows-analytics.int-spec.ts: seeded sessions give exact totals per result, entered/continued/dropped per step and counts per option for today, 7 days, 30 days and a custom range in the company time zone; test sessions are excluded; the dropped CSV lists the right contacts
- [X] T074 [P] [US8] Contract tests in apps/api/test/contract/flows.contract-spec.ts for `GET /flows/{id}/analytics` and the dropped CSV
- [X] T075 [P] [US8] Playwright e2e apps/web/e2e/flows-us8-analytics.spec.ts: run sessions, open analytics mode, and check the step badges and the totals bar against the API

### Implementation for User Story 8

- [X] T076 [US8] Implement apps/api/src/modules/flows/analytics/flow-analytics.service.ts and flow-analytics.controller.ts (SQL over `flow_sessions` and `flow_session_steps`, research R12; CSV download)
- [X] T077 [US8] Add analytics mode to the editor (period selector, totals bar, entered/continued/dropped badges, option counts, CSV download) in apps/web/src/components/flows/analytics-overlay.tsx

**Checkpoint**: US1–US8 work on their own.

---

## Phase 11: User Story 9 - Start from a ready-made flow (Priority: P3)

**Goal**: six starter flows written by us.

**Independent Test**: create a flow from "Lead capture", edit, publish and run it from a test phone.

### Tests for User Story 9 (REQUIRED) ⚠️

- [X] T078 [P] [US9] Unit test packages/shared/src/flows/starters/starters.test.ts: every starter parses with the graph schema, passes the publish checks (with its attributes), and has original text
- [X] T079 [P] [US9] Playwright e2e apps/web/e2e/flows-us9-starters.spec.ts: create from "Lead capture", accept the offer to create missing attributes, publish and run it

### Implementation for User Story 9

- [X] T080 [US9] Write the starters in packages/shared/src/flows/starters/ (FAQ menu, lead capture, appointment request, order status lookup, feedback rating, business hours reply), serve them from apps/api/src/modules/flows/definitions/starters.controller.ts (`GET /flow-starters`) and accept `starterKey` in `POST /flows`
- [X] T081 [US9] Add the starter picker to the new-flow dialog and the "create missing attributes" offer in apps/web/src/app/(dashboard)/flows/page.tsx

**Checkpoint**: all stories work on their own.

---

## Phase 12: Polish & Cross-Cutting Concerns

- [X] T082 [P] Add metrics `wbm_flow_sessions_total{result}`, `wbm_flow_steps_total{type}`, `wbm_flow_api_calls_total{outcome}` and `wbm_flow_api_duration_seconds` in apps/api/src/common/metrics/metrics.service.ts with their instrumentation points; add the alert `WbmFlowApiFailing` (over 20% failed API calls in 15 minutes, at least 20 calls) to ops/alerts.yml and apps/api/test/unit/alerts.spec.ts
- [X] T083 [P] Extend retention and erasure, tests first: ended sessions and their step records older than 12 months in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts; contact deletion clears session answers and the contact link in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts
- [X] T084 [P] Add `answers` and API-step secret fields to the log redaction list in apps/api/src/common/logging/redaction.ts with cases in apps/api/test/unit/logging-redaction.spec.ts
- [X] T085 [P] Add the flow audit actions (research R15) to apps/api/src/modules/audit/audit-actions.ts and apps/api/test/unit/audit-coverage.spec.ts
- [X] T086 [P] Add contracts/flows-api.openapi.yaml to the contracts read by apps/api/test/integration/rbac.int-spec.ts and fix any permission mismatch
- [X] T087 [P] Add the performance check tools/perf/flows-latency.ts (SC-001: customer message to queued flow reply, p95 with 20 concurrent customers) and the root script `perf:flows`
- [X] T088 [P] Docs: a Flows section in README.md (steps, triggers, testing, analytics, API-step safety), update specs/003-chatbot-flow-builder/quickstart.md if steps changed, and update the AiSensy inventory's roadmap numbering in docs/research/aisensy/feature-inventory-2026-11-19.md (the flow builder is 003)
- [X] T089 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/003-chatbot-flow-builder/checklists/release.md

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories.
- **US1 (P1)** is the MVP and the base for the editor and publishing. **US2** and **US3** need US1's
  engine and router; they can proceed in parallel after US1.
- **US4, US5, US6, US7** depend on US1 (and US4's delay uses US2's timers). They are independent of
  each other.
- **US8** needs step records from the foundational session service; it can start after US1.
- **US9** needs the step types its starters use (US1–US5).
- **Polish** after the stories it touches.

| Story | Priority | Depends on |
|---|---|---|
| US1 | P1 | Foundational |
| US2 | P1 | US1 |
| US3 | P1 | US1 |
| US4 | P2 | US1, US2 (timers) |
| US5 | P2 | US1 |
| US6 | P2 | US1 |
| US7 | P2 | US1 |
| US8 | P3 | US1 |
| US9 | P3 | US1–US5 |

### Within each story

Tests first (they must fail), then shared pure logic, then services and controllers, then the web UI.

## Parallel Example: User Story 1

```text
Run together (different files):
  T015 validate.test.ts      T016 triggers.test.ts      T017 run-buttons.spec.ts
  T018 flows-build-publish   T019 flows.contract-spec   T020 e2e flows-us1
Then: T021 shared logic → T022/T023/T024 services → T025 engine → T026/T027 web
```

## Implementation Strategy

1. **MVP**: Setup, Foundational and US1 → publish a keyword flow with buttons (demo-able).
2. **P1 release**: add US2 (questions) and US3 (live chat coexistence) → safe to switch on for
   customers.
3. **P2**: US4 logic, US5 API step, US6 triggers, US7 testing (any order).
4. **P3**: US8 analytics, US9 starters; then Polish and the release checklist.
5. Commit after each story's backend and web parts; CI (draft PR) runs integration, contract and e2e
   tests because the dev machine cannot run Docker.
