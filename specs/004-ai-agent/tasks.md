---
description: "Task list for the AI agent (feature 004)"
---

# Tasks: AI Agent

**Input**: Design documents from `/specs/004-ai-agent/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (ai-api.openapi.yaml,
agent-config.md, claude-messages.md), quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation. Claude is mocked with nock (`https://api.anthropic.com`) in integration tests and
with mock-meta's fake model (`ANTHROPIC_BASE_URL`) in e2e; Meta and company API endpoints are mocked
with nock and mock-meta. No test calls the real model; answer quality is measured by the manual eval
(T112).

**Organization**: by user story (spec.md US1–US9), after Setup and Foundational phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US9); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: dependencies, permissions, queue names, configuration and the fake model that every
story needs.

- [X] T001 Add `@anthropic-ai/sdk` `1.6.0`, `unpdf` `2.1.0`, `mammoth` `1.13.0`, `cheerio` `1.2.0` and `robots-parser` `3.0.1` (exact versions) to apps/api/package.json, run `npm install`, and confirm `npm audit --audit-level=high` stays clean (research R1, R11)
- [X] T002 [P] Add the permissions `ai.manage` (ADMIN, MANAGER), `ai.usage` (ADMIN) and `assistant.use` (ADMIN, MANAGER) to packages/shared/src/permissions.ts and extend packages/shared/src/permissions.test.ts (agents have none of them)
- [X] T003 [P] Add `AI: 'ai'` (turns, expiry, assistant) and `AI_KNOWLEDGE: 'ai-knowledge'` (file and website processing) to `QUEUES` in apps/api/src/common/queue/queue.constants.ts with comments (feature 004)
- [X] T004 [P] Add `ANTHROPIC_API_KEY` (optional secret), `ANTHROPIC_BASE_URL` (optional URL) and `AI_MODEL` (default `claude-opus-5-5`) to the env schema in apps/api/src/common/config/config.ts and to .env.example with comments; set `ANTHROPIC_BASE_URL` to mock-meta for the e2e job in .github/workflows/ci.yml (contracts/claude-messages.md §1)
- [X] T005 [P] Add specs/004-ai-agent/contracts/ai-api.openapi.yaml to the `lint:contracts` script in package.json
- [X] T006 [P] Add the fake Claude endpoint to mock-meta per contracts/claude-messages.md §7: tools/mock-meta/src/ai.ts (rule matching, default answer from the knowledge in the request, `tool_use` responses, usage numbers) and routes in tools/mock-meta/src/server.ts (`POST /anthropic/v1/messages`, `POST /mock/ai/rules`, `GET /mock/ai/requests`, `DELETE /mock/ai/requests`)

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: schema, shared contracts, the Claude client, the AI module and the inbound hook. No
story can start before this phase is complete.

- [X] T007 Write the Prisma models and the migration apps/api/prisma/migrations/20261127000000_ai_agent/migration.sql per data-model.md: the 14 tables (`ai_agents`, `ai_agent_versions`, `ai_agent_numbers`, `ai_agent_secrets`, `ai_knowledge_sources`, `ai_knowledge_chunks`, `ai_conversations`, `ai_replies`, `ai_unanswered_questions`, `ai_unanswered_asks`, `ai_usage_daily`, `ai_usage_months`, `assistant_requests`, `assistant_actions`); their enums; `settings` columns (`ai_reply_limit`, `ai_assistant_limit`, `ai_prices`, `ai_limit_message`); `ConsentSource` += `AI_AGENT`, `NotificationType` += `AI_USAGE`, `AI_FAILING`, `JourneyActor` += `AI_AGENT`, `JourneyEventType` += `AI_STARTED`, `AI_ENDED`, `FlowSessionResult` += `HANDED_TO_AI`, `FlowStartedBy` += `AI_AGENT`; the generated `tsvector` column with its GIN index; the partial unique index `ai_conversations(conversation_id) WHERE status = 'ACTIVE'`; `cardinality(test_numbers) <= 3`; citext unique name among non-deleted agents; the usage unique index with `coalesce`; update apps/api/prisma/schema.prisma to match (`tsv` as `Unsupported("tsvector")`)
- [X] T008 [P] Unit tests for the agent configuration in packages/shared/src/ai/config.test.ts: the example in contracts/agent-config.md parses; defaults fill `intro` for `en` and `ar`; empty goal, no language, 21 guardrails, an 11th API skill, a bad skill id, `replyCap` 4 or 101 and `maxReplyChars` over 1,000 are rejected
- [X] T009 Implement packages/shared/src/ai/config.ts (`AgentConfigSchema`, exported limits, `defaultAgentConfig()` with our English and Arabic introductions) and export it from packages/shared/src/index.ts
- [X] T010 [P] Unit tests for the reply contract in packages/shared/src/ai/reply.test.ts: the example in contracts/claude-messages.md §4 parses; `sanitiseReply` drops 4th buttons, buttons and list together, titles over the limits, media and flow ids not in the version, unknown attributes, values of the wrong type, values that look like card, bank or ID numbers, unknown `usedSources`, and too-long messages, and reports each drop with a reason
- [X] T011 Implement packages/shared/src/ai/reply.ts (`AgentReplySchema` with every field nullable and required, `AGENT_REPLY_JSON_SCHEMA` from `z.toJSONSchema`, `sanitiseReply(reply, context)`) and export it
- [X] T012 [P] Unit tests for masking in packages/shared/src/ai/masking.test.ts: Luhn-valid card numbers with spaces or dashes are replaced, non-Luhn digit runs and phone numbers stay, Emirates ID numbers (784-YYYY-NNNNNNN-C, with or without dashes) and UAE IBANs are replaced, `looksSensitive(value)` agrees
- [X] T013 Implement packages/shared/src/ai/masking.ts (`maskSensitive(text)`, `looksSensitive(value)`, research R12) and export it
- [X] T014 [P] Unit tests for usage maths in packages/shared/src/ai/usage.test.ts: cost in micros from tokens and prices (input, output, cache read, cache write), the alert level reached when a count crosses 80% and 100% (once each), and the month key of a moment in a time zone (Asia/Dubai around midnight on the 1st)
- [X] T015 Implement packages/shared/src/ai/usage.ts (`costMicros`, `alertLevel`, `monthKey`, `dayKey`) and export it
- [X] T016 [P] Unit tests for the Claude client in apps/api/test/unit/ai/claude-client.spec.ts with nock on `https://api.anthropic.com`: the request carries the model from `AI_MODEL`, the fallback beta and `fallbacks: "default"`, `output_config` with effort and the JSON schema, no `temperature`/`thinking`; usage is summed over tool-loop iterations; a `refusal`, `max_tokens`, invalid JSON, 401 and an expired deadline become typed failures; a 429 is retried once
- [X] T017 Implement apps/api/src/modules/ai/claude/claude.client.ts per contracts/claude-messages.md §1–§2 and §5: one SDK client from env (`timeout: 25_000`, `maxRetries: 1`), `runTurn({system, tools, messages, effort, schema, deadline})` on `client.beta.messages.toolRunner` with `max_iterations`, `AbortSignal` deadline, summed usage, and a `ClaudeFailure` type (`TIMEOUT`, `REFUSAL`, `INVALID_OUTPUT`, `AUTH`, `UNAVAILABLE`); fail closed with `AUTH` when no key and no base URL are set
- [X] T018 Create apps/api/src/modules/ai/ai.module.ts (a global `AiDomainModule` with the Claude client, router, AI conversations and usage services, and `AiApiModule` for controllers), the queue processor skeletons apps/api/src/modules/ai/turns/ai-queue.processor.ts (concurrency 10, routes `ai-turn`, `ai-expiry`, `assistant-request`) and apps/api/src/modules/ai/knowledge/knowledge-queue.processor.ts (concurrency 1), and wire them into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts
- [X] T019 Implement the AI conversation service skeleton apps/api/src/modules/ai/turns/ai-conversations.service.ts (`active(conversationId)`, `start(...)`, `endForConversation(conversationId, result)` with journey `AI_STARTED`/`AI_ENDED` and actor `AI_AGENT`)
- [X] T020 Implement the router skeleton apps/api/src/modules/ai/turns/ai-router.ts (`onCustomerMessage` returns whether a turn was queued) and call it from apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts after the flow router and before `autoReplies.handle`, skipping automatic replies when it returns true (research R5)
- [X] T021 [P] Show the label "Automatic · {agent name}" for items with `payload.ai` in apps/web/src/components/inbox/chat-item-view.tsx (one helper for flow and agent names) and add the `ai` payload type to apps/web/src/lib/inbox-types.ts

**Checkpoint**: migrations apply; shared schema, masking, usage and Claude client tests pass; the
worker boots with the AI module and both queues.

---

## Phase 3: User Story 1 - Set up an agent that answers from the company's knowledge (Priority: P1) 🎯 MVP

**Goal**: managers build an agent with instructions, guardrails and knowledge, publish it for a
number, and customers get answers from that knowledge in WhatsApp, visible in live chat.

**Independent Test**: publish an agent whose knowledge says "Delivery to Sharjah costs AED 50"; ask
in two wordings (both say AED 50), ask a missing price (no price, listed under Unanswered), ask an
unrelated question (declined); live chat shows "Automatic · {agent}".

### Tests for User Story 1 (REQUIRED) ⚠️

- [X] T022 [P] [US1] Unit tests for chunking in packages/shared/src/ai/chunking.test.ts: splits on headings and paragraphs near 1,500 characters with 200 characters of overlap, keeps the heading path and page number, never splits inside a word, a written answer stays one chunk
- [X] T023 [P] [US1] Unit tests for text extraction in apps/api/test/unit/ai/extract.spec.ts with fixtures in apps/api/test/fixtures/ai/ (a text PDF gives pages, a scanned PDF gives `NO_TEXT`, a password PDF gives `PASSWORD_PROTECTED`, over 300 pages gives `TOO_LARGE`, a DOCX keeps its headings, HTML keeps `main`/`article` text and `h1`–`h3` and drops scripts, styles, navigation, headers and footers)
- [X] T024 [P] [US1] Unit tests for the website reader in apps/api/test/unit/ai/crawler.spec.ts with nock: `robots.txt` rules for `WBM-KnowledgeReader` are honoured, `sitemap.xml` is used when present, otherwise only same-host links under the start path are followed, at most 100 pages, same-host redirects up to 3, non-HTML skipped, `http://` and private addresses refused
- [X] T025 [P] [US1] Unit tests for the prompt builder in apps/api/test/unit/ai/prompt.spec.ts: order tools → system (rules, instructions with a breakpoint) → knowledge user turn with a breakpoint → history (at most 20) → customer text → system turn context; knowledge in `<knowledge>` tags with ids, written answers first, then files, then pages; whole mode up to 120,000 characters and search mode above (written answers within 40,000 characters plus retrieved chunks in the turn context); masked customer text; no phone number anywhere in the request
- [X] T026 [P] [US1] Unit tests for search query building in apps/api/test/unit/ai/knowledge-search.spec.ts: terms joined with OR, stop words and punctuation dropped, Arabic words kept for the simple configuration, empty queries return nothing
- [X] T027 [P] [US1] Integration test apps/api/test/integration/ai-agents-build-publish.int-spec.ts: create (defaults), save drafts (409 `DRAFT_CONFLICT` on an old revision), publish refused with problems (422 `PUBLISH_BLOCKED`, `NO_GOAL`), publish creates version 1, rename, duplicate copies knowledge and secrets, delete refused while published (409 `AGENT_PUBLISHED`), numbers assignment (409 `NUMBER_HAS_AGENT`, then `replace: true`), unpublish; audit entries for each
- [X] T028 [P] [US1] Integration test apps/api/test/integration/ai-knowledge.int-spec.ts: written answers (limit 500, edit, delete); a website read through nock becomes `READY` with searchable chunks; PDF and DOCX uploads become `READY`; a scanned PDF becomes `FAILED` with `NO_TEXT`; the same file twice gives 409 `DUPLICATE_FILE`; refresh replaces chunks; a switched-off source leaves search and the prompt; `GET /knowledge` reports totals and `WHOLE` or `SEARCH`; deleting a file source deletes the stored file
- [X] T029 [P] [US1] Integration test apps/api/test/integration/ai-turns.int-spec.ts with nock for Claude: an inbound text queues one debounced turn; the Claude request holds the knowledge and no phone number; the reply becomes a `SESSION_OUT` item with origin `AUTOMATIC` and `payload.ai` (agent, version, sources) on the number's send queue; the first reply starts with the introduction and the second does not; an `ai_replies` row and a daily usage row are written; an `unanswered` reply lists the question; two messages within 2 s give one turn and one reply; a customer message arriving during generation makes the turn run again once; no welcome message is sent
- [X] T030 [P] [US1] Contract tests in apps/api/test/contract/ai.contract-spec.ts for `GET/POST /ai-agents`, `GET/PATCH/DELETE /ai-agents/{id}`, `PUT /ai-agents/{id}/draft`, `POST /ai-agents/{id}/duplicate`, `POST /ai-agents/{id}/publish` (200 and 422), `POST /ai-agents/{id}/unpublish`, `PUT /ai-agents/{id}/numbers`, the knowledge endpoints and the unanswered endpoints against contracts/ai-api.openapi.yaml
- [X] T031 [P] [US1] Playwright e2e apps/web/e2e/ai-us1-knowledge.spec.ts: create an agent in the editor, add a written answer, choose the mock number, publish, send the question with `npm run mock:inbound`, see the fake model's answer in live chat labelled with the agent's name, send a question without an answer and see it under Unanswered

### Implementation for User Story 1

- [X] T032 [US1] Implement packages/shared/src/ai/chunking.ts and export it
- [X] T033 [US1] Implement apps/api/src/modules/ai/agents/agents.service.ts and agents.controller.ts: list (numbers, test numbers, published version, `hasUnpublishedChanges`, 7-day replies and hand-overs), create with `defaultAgentConfig()`, get (with problems and secrets by name), rename, delete only when not published, duplicate (draft, knowledge rows and stored files, secrets), draft save with `draftRevision`, number assignment with `NUMBER_HAS_AGENT` and `replace`; `ai.manage` on every route; audit `ai.agent_created`, `ai.agent_updated`, `ai.agent_duplicated`, `ai.agent_deleted`, `ai.number_agent_changed`
- [X] T034 [US1] Implement apps/api/src/modules/ai/agents/publish.service.ts: shared schema plus server checks (`MEDIA_NOT_FOUND`, `UNKNOWN_ATTRIBUTE`, `FLOW_NOT_PUBLISHED`, `REPLACE_ME_LEFT`, `INTRO_MISSING`), structured so later stories add rules; a numbered version and `published_version_id`; unpublish ends active AI conversations at their next message (`UNPUBLISHED`); audit `ai.agent_published`, `ai.agent_unpublished`
- [X] T035 [P] [US1] Implement the extractors apps/api/src/modules/ai/knowledge/extract/pdf.ts (`unpdf`, pages, `NO_TEXT`, `PASSWORD_PROTECTED`, `TOO_LARGE`), extract/docx.ts (`mammoth` to HTML, then text with headings) and extract/html.ts (`cheerio`, research R11)
- [X] T036 [P] [US1] Implement apps/api/src/modules/ai/knowledge/crawler.ts on the 003 safe HTTPS client (apps/api/src/modules/flows/steps/api-client.ts lookup and limits): `robots-parser`, sitemap first, breadth-first same-host links under the start path, 100 pages, one request at a time with a 500 ms pause, 10 s and 2 MB per page
- [X] T037 [US1] Implement apps/api/src/modules/ai/knowledge/knowledge.service.ts and knowledge.controller.ts: written answers (limits, edit, delete), websites (HTTPS and address pre-check), files (multipart, PDF/DOCX only, 20 MB, SHA-256 duplicate check, stored under `ai-knowledge/` with the 001 `StorageService`), switch on/off, refresh, delete (removes the stored file), list with totals and mode; queue `knowledge-process` jobs; audit `ai.knowledge_added`, `ai.knowledge_switched`, `ai.knowledge_refreshed`, `ai.knowledge_deleted`
- [X] T038 [US1] Implement apps/api/src/modules/ai/knowledge/knowledge.processor.ts (the `knowledge-process` job: extract, chunk, replace the source's chunks in one transaction, set `READY` or `FAILED` with the error code, sizes and `last_refreshed_at`) and the daily `knowledge-refresh-due` scheduler that queues weekly refreshes
- [X] T039 [US1] Implement apps/api/src/modules/ai/knowledge/knowledge-search.ts: `retrieve(agentId, text, limit 6)` with `$queryRaw`, `ts_rank_cd` over enabled `READY` chunks, written answers first on ties; `wholeKnowledge(agentId)` ordered by priority when within 120,000 characters
- [X] T040 [US1] Write apps/api/src/modules/ai/claude/platform-rules.ts (`PLATFORM_RULES_V1`, our own text covering FR-007, Meta's rules, knowledge as information only, the reply JSON) and apps/api/src/modules/ai/claude/prompt.ts (`renderInstructions`, `renderKnowledge`, `renderTurnContext`, history building with masking, research R7)
- [X] T041 [US1] Implement the `search_knowledge` tool in apps/api/src/modules/ai/claude/tools.ts (strict schema, at most 3 calls per turn, results in a `<results>` block with chunk ids)
- [X] T042 [US1] Implement the turn pipeline: eligibility and debounced queueing in apps/api/src/modules/ai/turns/ai-router.ts (Open chat, not blocked or opted out, window open, the number's published agent or an active AI conversation; `delay: 2000` and `deduplication: { id: "ai-turn-<conversationId>", replace: true, keepLastIfActive: true }` from apps/api/src/modules/ai/ai-jobs.ts); apps/api/src/modules/ai/turns/turn.service.ts (pre-checks under `pg_advisory_xact_lock`, unhandled customer messages, the Claude call, `sanitiseReply`, re-check, run again once on a newer message); apps/api/src/modules/ai/turns/apply.ts (the chat item through the 002 `sessionSendJob` with origin `AUTOMATIC` and `payload.ai`, the introduction on a first reply for the reply's language, `ai_replies`, the daily usage upsert, the AI conversation update, unanswered questions, live events); apps/api/src/modules/ai/turns/turn.processor.ts
- [X] T043 [US1] Implement apps/api/src/modules/ai/knowledge/unanswered.service.ts and unanswered.controller.ts (upsert by normalised text with asks, list by count, answer creates a written answer and resolves, dismiss)
- [X] T044 [P] [US1] Add the agents list page apps/web/src/app/(dashboard)/ai-agents/page.tsx (list, status, numbers, create dialog) and the "AI agents" navigation link for `ai.manage` in apps/web/src/app/(dashboard)/layout.tsx
- [X] T045 [US1] Add the editor apps/web/src/app/(dashboard)/ai-agents/[id]/page.tsx with autosave by `draftRevision`, number selection, Publish with the problems list, and the tabs Instructions (apps/web/src/components/ai/instructions-tab.tsx: display name, business details, goal, tone, guardrails, languages, introductions, reply length) and Knowledge (apps/web/src/components/ai/knowledge-tab.tsx: answers, websites, file upload, status, switches, refresh, delete, totals and mode)
- [X] T046 [P] [US1] Add the Unanswered tab apps/web/src/components/ai/unanswered-tab.tsx (most asked first, add an answer, dismiss)

**Checkpoint**: US1 integration, contract and e2e tests pass; an agent answers from its knowledge.

---

## Phase 4: User Story 2 - Hand over to people and follow the live chat and consent rules (Priority: P1)

**Goal**: the agent hands chats to people when asked, on chosen topics, when unsure, on repeats and
at the reply cap, and it never talks over a member, an opt-out, a block, a flow or a closed window.

**Independent Test**: write "can I talk to someone from your team please": Waiting for agent with a
summary note and no more AI replies; after a member closes the chat the agent answers again; STOP
gets no AI reply.

### Tests for User Story 2 (REQUIRED) ⚠️

- [X] T047 [P] [US2] Unit tests for eligibility and hand-over decisions in apps/api/test/unit/ai/eligibility.spec.ts: only Open chats; blocked, opted-out, closed window and running flow are refused; the reply cap and a second `unanswered` in one AI conversation force a hand-over; "when unsure" `hand_over` versus `say_so`
- [X] T048 [P] [US2] Integration test apps/api/test/integration/ai-live-chat.int-spec.ts with nock for Claude: a hand-over sends one closing reply, moves the chat to Waiting for agent with the 002 alert and an `AUTOMATIC` note holding the summary, and ends the AI conversation `HANDED_OVER`; a topic and "when unsure" hand over; outside working hours no off-hours message is added; take, reply, template and starting a flow end the AI conversation (`MEMBER_TOOK`) and drop a reply being prepared; after closing, the agent answers again; STOP gets no AI reply; a clear request in other words opts the contact out with source `AI_AGENT` and sends nothing, an unclear one gets a question; a blocked contact gets nothing; a flow keyword wins; invalid JSON, a refusal, a timeout and a 401 send the fallback message, hand over with "AI agent unavailable" and count nothing; more than 20% failing over at least 10 turns in 15 minutes creates one `AI_FAILING` notification per hour; idle AI conversations expire after 24 h
- [X] T049 [P] [US2] Contract test in apps/api/test/contract/ai.contract-spec.ts for `GET /inbox/conversations/{id}/ai`
- [X] T050 [P] [US2] Playwright e2e apps/web/e2e/ai-us2-handover.spec.ts: ask for a person (fake model rule), see Waiting for agent, the summary note and the AI banner gone; take and close the chat; the next message is answered by the agent; STOP gets no reply

### Implementation for User Story 2

- [X] T051 [US2] Extend apps/api/src/modules/ai/turns/apply.ts and turn.service.ts for hand-over: closing reply (counted, kind `HANDOVER`), move to Waiting for agent through the 002 routing path with its alert, an `AUTOMATIC` note with the summary, end the AI conversation; the reply cap, repeat and "when unsure" rules
- [X] T052 [US2] End the active AI conversation from the existing paths: take and resolve in apps/api/src/modules/inbox/conversations/conversations.service.ts, replies in apps/api/src/modules/inbox/messages/session-send.service.ts, templates in apps/api/src/modules/inbox/messages/template-send.service.ts, member flow starts in apps/api/src/modules/flows/live-chat/flow-start.controller.ts, every move to Waiting for agent in `alertRequesting` of apps/api/src/modules/inbox/routing/chat-routing.service.ts, and blocking in apps/api/src/modules/inbox/conversations/chat-contact.service.ts (`BLOCKED`)
- [X] T053 [US2] Handle `optOut: "clear"` in apply.ts through apps/api/src/modules/contacts/consent.service.ts with source `AI_AGENT` (no reply, AI conversation `OPTED_OUT`); keyword opt-outs stay on the 001 path before the router
- [X] T054 [US2] Implement failure handling in turn.service.ts and apply.ts: the version's fallback message (kind `FALLBACK`, not counted), hand-over with the note "AI agent unavailable", AI conversation `FAILED`; the failure-rate check over the last 15 minutes of `ai_replies` that sends `AI_FAILING` to admins through apps/api/src/modules/notifications/notifications.service.ts at most once an hour
- [X] T055 [US2] Implement the `ai-expiry` scheduler (every 15 minutes) in apps/api/src/modules/ai/turns/expiry.processor.ts: ACTIVE AI conversations without activity for 24 h end `EXPIRED`
- [X] T056 [US2] Implement apps/api/src/modules/ai/live-chat/ai-state.controller.ts (`GET /inbox/conversations/:id/ai`, `inbox.view` with 002 visibility) and add the AI banner apps/web/src/components/inbox/ai-banner.tsx to apps/web/src/components/inbox/chat-view.tsx plus a sources popover on AI items in chat-item-view.tsx (FR-020)

**Checkpoint**: US1 and US2 together are safe to switch on for customers.

---

## Phase 5: User Story 3 - Test the agent before publishing and keep versions (Priority: P2)

**Goal**: managers try the draft in a preview chat and on test numbers, and keep numbered versions
they can restore.

**Independent Test**: change the draft's tone; the preview and a test number get the draft, another
phone gets the published agent; restoring version 1 brings its settings back into the draft.

### Tests for User Story 3 (REQUIRED) ⚠️

- [X] T057 [P] [US3] Integration test apps/api/test/integration/ai-testing.int-spec.ts: the preview returns the reply, sources and "would do" items without sending anything or changing contacts; preview usage is recorded as `PREVIEW` and not counted; the 21st preview in a minute gives 429; test numbers meet the draft (replies marked test, counted as test, left out of conversation results) and other numbers meet the published version; versions list; restore copies a version into the draft while customers keep the published version
- [X] T058 [P] [US3] Contract tests in apps/api/test/contract/ai.contract-spec.ts for `POST /ai-agents/{id}/preview`, `GET /ai-agents/{id}/versions`, `POST /ai-agents/{id}/versions/{versionId}/restore` and `PUT /ai-agents/{id}/test-numbers`
- [X] T059 [P] [US3] Playwright e2e apps/web/e2e/ai-us3-testing.spec.ts: preview a question in the Test tab, add a test number and compare draft and published replies, restore version 1

### Implementation for User Story 3

- [X] T060 [US3] Implement apps/api/src/modules/ai/turns/preview.controller.ts and the dry-run mode of turn.service.ts (no apply; skills that change data simulated; "would do" list; 20 previews per member per minute)
- [X] T061 [US3] Add test numbers: `PUT /ai-agents/{id}/test-numbers` in apps/api/src/modules/ai/agents/agents.service.ts (at most 3, E.164), draft selection for test senders in apps/api/src/modules/ai/turns/ai-router.ts, `test` on AI conversations, replies and usage in apps/api/src/modules/ai/turns/apply.ts; audit `ai.test_numbers_updated`
- [X] T062 [US3] Implement apps/api/src/modules/ai/agents/versions.service.ts and versions.controller.ts (list, restore into the draft; audit `ai.agent_restored`)
- [X] T063 [P] [US3] Add the Test tab apps/web/src/components/ai/test-tab.tsx (preview chat with a sample contact, sources and "would do", test numbers) and the Versions tab apps/web/src/components/ai/versions-tab.tsx

---

## Phase 6: User Story 4 - Rich replies and remembering what the customer said (Priority: P2)

**Goal**: the agent sends buttons, lists and shared media, and saves facts the customer states into
the attributes the manager allowed.

**Independent Test**: ask for the price list (the shared PDF arrives with a caption), say "I live in
Al Ain" (city saved with a journey entry by the agent), later ask for the nearest branch (Al Ain).

### Tests for User Story 4 (REQUIRED) ⚠️

- [X] T064 [P] [US4] Unit tests for building the WhatsApp message from a reply in apps/api/test/unit/ai/reply-message.spec.ts: text; up to 3 buttons as a `BUTTONS` item with `ai:` reply ids; 4–10 options as a `LIST` item; media with the message as caption (at most 1,024 characters); disabled skills fall back to text
- [X] T065 [P] [US4] Integration test apps/api/test/integration/ai-replies-memory.int-spec.ts: a shared file is sent with a caption; buttons and lists are queued with their payload and a tap comes back to the agent as the customer's answer; `remember` sets an allowed attribute with a journey `ATTRIBUTE_CHANGED` entry (actor `AI_AGENT`, the agent's name); other attributes and values of the wrong type are not saved; a card number is masked in the Claude request (nock body) and never saved
- [X] T066 [P] [US4] Playwright e2e apps/web/e2e/ai-us4-rich-replies.spec.ts: share a media file and allow "city", ask for the file, state a city, check the profile panel and journey

### Implementation for User Story 4

- [X] T067 [US4] Build `BUTTONS`, `LIST` and media items from replies in apps/api/src/modules/ai/turns/apply.ts with the 003 interactive content types; agent reply ids use the `ai:<aiConversationId>:<n>` form so the flow router treats taps as ordinary messages and the agent receives the title
- [X] T068 [US4] Move the attribute writer out of `saveAttributes` in apps/api/src/modules/flows/engine/session.service.ts into apps/api/src/modules/inbox/journey/attribute-writer.ts (type checks, journey entries with actor `FLOW` or `AI_AGENT` and the name), keep flows on it, and save `remember` values through it from apps/api/src/modules/ai/turns/apply.ts with the `looksSensitive` refusal
- [X] T069 [P] [US4] Add the Skills tab apps/web/src/components/ai/skills-tab.tsx: buttons and lists switches, media picker from the media library with descriptions, fillable attributes with descriptions

---

## Phase 7: User Story 5 - Look up live data in company systems (Priority: P2)

**Goal**: managers add API skills that the agent calls safely, with secrets kept hidden and a
confirmation step for skills that change data.

**Independent Test**: an "Order status" skill on a test endpoint returning `{"status":"shipped"}`:
the agent asks for the order number, then answers "shipped"; a failing endpoint gets an offer of a
person and no status.

### Tests for User Story 5 (REQUIRED) ⚠️

- [X] T070 [P] [US5] Unit tests for API skill tools in apps/api/test/unit/ai/skill-tools.spec.ts: one strict tool `skill_<id>` per skill from its inputs; only mapped fields go back to the model; a skill with `changesData` returns `confirmation_needed` and stores the pending call, runs on a later turn with the same inputs, asks again with other inputs, and is simulated in preview
- [X] T071 [P] [US5] Integration test apps/api/test/integration/ai-skills.int-spec.ts with nock: inputs are filled with place-aware encoding and the secret only in a header; the next Claude request holds only mapped fields; a timeout and a 500 give `ok: false` and no invented status; `http://` and private addresses are refused at publish; `ai_replies.skills` records the call without values; agent secrets are stored encrypted, returned by name only, audited without values and refused for deletion while used (409 `SECRET_IN_USE`); the skill test request uses the same client
- [X] T072 [P] [US5] Contract tests in apps/api/test/contract/ai.contract-spec.ts for `POST /ai-agents/{id}/secrets`, `PUT/DELETE /ai-agents/{id}/secrets/{secretId}` and `POST /ai-agents/{id}/skill-test`
- [X] T073 [P] [US5] Playwright e2e apps/web/e2e/ai-us5-api-skill.spec.ts: add a skill with a secret header (shown masked), run the test request, ask about an order through the fake model's tool-call rule

### Implementation for User Story 5

- [X] T074 [US5] Implement agent secrets in apps/api/src/modules/ai/agents/agent-secrets.service.ts and a controller (001 cipher, names only, `SECRET_IN_USE` across draft and versions; audit `ai.secret_changed`) and the skill test request in apps/api/src/modules/ai/agents/skill-test.controller.ts on the 003 client
- [X] T075 [US5] Implement API skill tools in apps/api/src/modules/ai/claude/tools.ts on the 003 request builder and client (apps/api/src/modules/flows/steps/api-request.ts, api-client.ts) with the confirmation protocol on `ai_conversations.pending_confirmation`, and add the API skill checks (`NOT_HTTPS`, `UNKNOWN_SECRET`, `SECRET_OUTSIDE_HEADER`, `UNKNOWN_INPUT`, `DUPLICATE_SKILL_ID`) to publish.service.ts
- [X] T076 [P] [US5] Add the API skill editor apps/web/src/components/ai/api-skill-form.tsx (inputs, request, headers with the secrets panel, mapping, "changes data", test request) to the Skills tab

---

## Phase 8: User Story 6 - Work together with chatbot flows (Priority: P2)

**Goal**: flow triggers come first, a flow can hand a chat to an agent, and an agent can start a
flow and continue after it.

**Independent Test**: "menu" starts its flow and the agent answers the free question after it; a
Hand to AI agent step passes the chat to the agent; the agent starts "Book a visit" on request.

### Tests for User Story 6 (REQUIRED) ⚠️

- [ ] T077 [P] [US6] Unit tests for the `aiAgent` step in packages/shared/src/flows/graph.test.ts and validate.test.ts (it needs `agentId`, has no next step, counts as an end for reachability)
- [ ] T078 [P] [US6] Unit tests for the engine in apps/api/test/unit/flows/run-ai-step.spec.ts: an `aiAgent` step sends its opening message, emits a hand-to-AI effect and ends the session `HANDED_TO_AI`
- [ ] T079 [P] [US6] Integration test apps/api/test/integration/ai-flows.int-spec.ts: a flow keyword wins over the agent; after the flow ends the agent answers; an `aiAgent` step hands the chat to an agent that is not the number's agent; `startFlow` starts a flow with `startedBy: AI_AGENT` and the same agent continues after it; publishing a flow whose agent is not published gives `AGENT_NOT_PUBLISHED`; an agent's flow skill on an unpublished flow gives `FLOW_NOT_PUBLISHED`
- [ ] T080 [P] [US6] Playwright e2e apps/web/e2e/ai-us6-flows.spec.ts: add a Hand to AI agent step in the flow editor, run the flow and see the agent continue

### Implementation for User Story 6

- [ ] T081 [US6] Add the `aiAgent` step to packages/shared/src/flows/graph.ts and its rules to packages/shared/src/flows/validate.ts
- [ ] T082 [US6] Run the step in apps/api/src/modules/flows/engine/run.ts and apply it in apps/api/src/modules/flows/engine/session.service.ts (opening message, end `HANDED_TO_AI`, `AiConversationsService.start` with `startedBy: FLOW`); add `AGENT_NOT_PUBLISHED` to apps/api/src/modules/flows/definitions/publish.service.ts
- [ ] T083 [US6] Apply `startFlow` in apps/api/src/modules/ai/turns/apply.ts through `FlowSessionService.start` with `startedBy: AI_AGENT`, keeping the AI conversation active across the flow (research R9)
- [ ] T084 [P] [US6] Add the Hand to AI agent step to the flow editor (palette entry in apps/web/src/lib/flows.ts, form apps/web/src/components/flows/steps/ai-agent-form.tsx, node summary) and the flow skills list to apps/web/src/components/ai/skills-tab.tsx

---

## Phase 9: User Story 7 - Usage, monthly limit and cost (Priority: P2)

**Goal**: every AI reply is counted against a monthly limit with alerts, and admins see usage and
estimated cost.

**Independent Test**: limit 5, six questions from a test phone: five answered and counted, alerts at
4 and 5, the sixth goes to Waiting for agent with "AI reply limit reached"; raising the limit resumes
the agent.

### Tests for User Story 7 (REQUIRED) ⚠️

- [ ] T085 [P] [US7] Integration test apps/api/test/integration/ai-usage.int-spec.ts: replies 1–5 counted and the 6th handed over with the limit note and the admin's limit message without a model call; two concurrent turns at limit − 1 send exactly one reply; `AI_USAGE` alerts at 80% and 100% once per month; raising the limit resumes; the month restarts on the 1st in the company time zone; test replies count and are shown apart; fallback and limit messages are not counted; `GET /ai-usage` totals, per agent, per day, conversation outcomes and cost match the records
- [ ] T086 [P] [US7] Contract tests in apps/api/test/contract/ai.contract-spec.ts for `GET /ai-usage` and `GET/PUT /ai-settings`
- [ ] T087 [P] [US7] Playwright e2e apps/web/e2e/ai-us7-usage.spec.ts: set a limit of 2 in AI usage, send three questions, see the counts, the limit note in live chat, and the alert

### Implementation for User Story 7

- [ ] T088 [US7] Implement apps/api/src/modules/ai/usage/usage.service.ts: the pre-check before the model call, the atomic month increment inside the apply transaction (`UPDATE … WHERE replies < limit`), the limit hand-over (kind `LIMIT`, AI conversation `LIMIT_REACHED`), alert levels with `AI_USAGE` notifications to admins, month and day keys in `settings.defaultTimezone`
- [ ] T089 [US7] Implement apps/api/src/modules/ai/usage/usage.controller.ts and ai-settings.controller.ts (`ai.usage`; audit `ai.limits_changed`)
- [ ] T090 [P] [US7] Add the usage page apps/web/src/app/(dashboard)/ai-usage/page.tsx (month picker, replies against the limit, test replies, cost, per agent and per day tables, conversation outcomes, limits, prices and limit message) and its navigation link for `ai.usage`

---

## Phase 10: User Story 8 - Start from a ready-made agent (Priority: P3)

**Goal**: managers start from one of four starter agents written by us.

**Independent Test**: create from "Lead qualification", accept creating its attributes, replace the
example answers, publish and run a conversation that fills them.

### Tests for User Story 8 (REQUIRED) ⚠️

- [ ] T091 [P] [US8] Unit tests in packages/shared/src/ai/starters/starters.test.ts: each starter parses with `AgentConfigSchema`, has example answers marked "replace me", valid suggested attributes, and only our own text
- [ ] T092 [P] [US8] Integration test apps/api/test/integration/ai-starters.int-spec.ts: `GET /ai-agent-starters` with `exists` flags; creating from a starter gives the draft and the "replace me" answers; publishing is refused with `REPLACE_ME_LEFT` until they are replaced
- [ ] T093 [P] [US8] Playwright e2e apps/web/e2e/ai-us8-starters.spec.ts: create from "Lead qualification", create the offered attributes, replace the examples and publish

### Implementation for User Story 8

- [ ] T094 [US8] Write the starters Sales enquiries, Customer support, Booking requests and Lead qualification in packages/shared/src/ai/starters/ (our own goals, tones, guardrails, example answers, suggested attributes and hand-over topics), serve them from apps/api/src/modules/ai/agents/starters.controller.ts, and create agents from them in agents.service.ts
- [ ] T095 [P] [US8] Add the starter picker and the "create missing attributes" offer to the new-agent dialog in apps/web/src/app/(dashboard)/ai-agents/page.tsx

---

## Phase 11: User Story 9 - AI assistant for the team (Priority: P3)

**Goal**: admins and managers ask the assistant for drafts and report answers; anything that sends,
spends or deletes waits for their confirmation on a preview.

**Independent Test**: a sale template request gives an unsubmitted template draft; a campaign send
request shows a preview with recipients and cost and sends only after Confirm; a manager asking to
raise the AI limit is refused.

### Tests for User Story 9 (REQUIRED) ⚠️

- [ ] T096 [P] [US9] Unit tests for the assistant tools in apps/api/test/unit/ai/assistant-tools.spec.ts: each tool checks the member's permission; `draft_flow` validates with the 003 graph schema and publish rules; propose tools create `PENDING` actions with previews; no tool sends, spends or deletes
- [ ] T097 [P] [US9] Integration test apps/api/test/integration/ai-assistant.int-spec.ts with nock for Claude tool calls: a template draft is not submitted to Meta; a flow draft is unpublished and valid; a campaign draft is not scheduled; a send proposal shows recipients and cost and runs only on confirm, as the member, with an audit entry; cancel; an action older than 30 minutes gives 409 `ACTION_EXPIRED`; a manager asking to change the AI limit is refused; the monthly assistant limit gives 429 `LIMIT_REACHED`; report figures equal the reports service
- [ ] T098 [P] [US9] Contract tests in apps/api/test/contract/ai.contract-spec.ts for `GET/POST /assistant/requests`, `GET /assistant/requests/{id}`, `POST /assistant/actions/{id}/confirm` and `POST /assistant/actions/{id}/cancel`
- [ ] T099 [P] [US9] Playwright e2e apps/web/e2e/ai-us9-assistant.spec.ts: ask for a template draft (fake model tool call), open it, ask for a campaign send, confirm the preview

### Implementation for User Story 9

- [ ] T100 [US9] Implement apps/api/src/modules/ai/assistant/assistant.service.ts and assistant.controller.ts (create and queue, list own, get own) and apps/api/src/modules/ai/assistant/assistant.processor.ts (streamed Claude call with effort `medium`, usage kind `ASSISTANT`, the assistant limit)
- [ ] T101 [US9] Implement apps/api/src/modules/ai/assistant/assistant-tools.ts (`draft_template`, `draft_flow`, `draft_campaign`, `report_summary`, `propose_campaign_send`, `propose_delete`) acting as the member through the existing templates, flows, campaigns and reports services
- [ ] T102 [US9] Implement apps/api/src/modules/ai/assistant/assistant-actions.service.ts (confirm: owner, expiry and permission re-checked, run through the existing services with the member as actor, audit `ai.assistant_action_confirmed`; cancel)
- [ ] T103 [P] [US9] Add the assistant panel apps/web/src/components/ai/assistant-panel.tsx (header button for `assistant.use`, request history with polling, draft links, action previews with Confirm and Cancel)

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T104 [P] Add metrics `wbm_ai_turns_total{result}`, `wbm_ai_turn_duration_seconds`, `wbm_ai_tokens_total{kind}`, `wbm_ai_replies_total{test}`, `wbm_ai_knowledge_jobs_total{kind,outcome}` and `wbm_ai_assistant_requests_total{outcome}` in apps/api/src/common/metrics/metrics.service.ts with their instrumentation points; add the alert `WbmAiFailing` (over 20% of turns failing in 15 minutes, at least 10 turns) to ops/alerts.yml and apps/api/test/unit/alerts.spec.ts
- [ ] T105 [P] Extend retention and erasure, tests first: ended AI conversations, replies, unanswered asks and assistant requests older than 12 months in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts; contact deletion clears AI conversation links, summaries and pending confirmations and removes unanswered asks in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts
- [ ] T106 [P] Add prompt, knowledge, reply, summary and remembered-value fields to the log redaction list in apps/api/src/common/logging/redaction.ts with cases in apps/api/test/unit/logging-redaction.spec.ts
- [ ] T107 [P] Add the AI audit actions to apps/api/src/modules/audit/audit-actions.ts and apps/api/test/unit/audit-coverage.spec.ts
- [ ] T108 [P] Add contracts/ai-api.openapi.yaml to the contracts read by apps/api/test/integration/rbac.int-spec.ts and fix any permission mismatch
- [ ] T109 [P] Add the performance check tools/perf/ai-latency.ts (SC-001: customer message to queued AI reply, p95 with 50 customers, against the fake model) and the root script `perf:ai`
- [ ] T110 [P] Show the journey entries `AI_STARTED` and `AI_ENDED` and changes made by actor `AI_AGENT` (with the agent's name) in apps/web/src/components/inbox/journey-list.tsx, with a unit test in its existing test file or a new apps/web/src/components/inbox/journey-list.test.tsx
- [ ] T111 [P] Docs: an AI agents section in README.md (setup, knowledge, hand-over, skills, usage, assistant, data handling), update specs/004-ai-agent/quickstart.md if steps changed, and mark items 9.1–9.6 in docs/research/aisensy/feature-inventory-2026-11-19.md
- [ ] T112 Add the quality evaluation tools/eval/ai-agent-eval.ts with question sets in tools/eval/sets/ (SC-002 answerable and unanswerable questions, SC-003 rule-breaking attempts, SC-005 requests for a person in English and Arabic, an SC-010 summary review sheet) and the root script `eval:ai`; it uses the real model, so it is run by hand with approval and never in CI
- [ ] T113 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/004-ai-agent/checklists/release.md, with the pre-release items: the company's Anthropic account and key, the data protection review for processing chats abroad, the zero data retention decision, the model and prices, and the eval results

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories.
- **US1 (P1)** is the MVP and the base for the editor, knowledge and the turn pipeline.
- **US2 (P1)** needs US1's pipeline; release US1 and US2 together before customers see the agent.
- **US3, US4, US5, US6, US7** depend on US1 (US6 also on 003 flows); they are independent of each
  other.
- **US8** needs the skill types its starters use (US1, US4).
- **US9** needs only Foundational plus the existing templates, flows, campaigns and reports services.
- **Polish** after the stories it touches.

| Story | Priority | Depends on |
|---|---|---|
| US1 | P1 | Foundational |
| US2 | P1 | US1 |
| US3 | P2 | US1 |
| US4 | P2 | US1 |
| US5 | P2 | US1 |
| US6 | P2 | US1, 003 flows |
| US7 | P2 | US1 |
| US8 | P3 | US1, US4 |
| US9 | P3 | Foundational |

### Within each story

Tests first (they must fail), then shared pure logic, then services and controllers, then the web UI.

## Parallel Example: User Story 1

```text
Run together (different files):
  T022 chunking.test.ts     T023 extract.spec.ts       T024 crawler.spec.ts
  T025 prompt.spec.ts       T026 knowledge-search.spec T027 ai-agents-build-publish
  T028 ai-knowledge         T029 ai-turns              T030 ai.contract-spec   T031 e2e ai-us1
Then: T032 chunking → T033/T034 agents and publishing → T035/T036 extractors and crawler (parallel)
      → T037/T038 knowledge service and processor → T039 search → T040/T041 prompt and tools
      → T042 turn pipeline → T043 unanswered → T044/T046 web (parallel) and T045 editor
```

## Implementation Strategy

1. **MVP**: Setup, Foundational and US1 → an agent answers from its knowledge (demo-able with the
   fake model or a real key).
2. **P1 release**: add US2 (hand-over and live chat rules) → safe to switch on for customers.
3. **P2**: US3 testing, US4 rich replies and memory, US5 API skills, US6 flows, US7 usage and limit
   (any order; US7 before a real launch).
4. **P3**: US8 starters, US9 assistant; then Polish, the eval run (with approval) and the release
   checklist.
5. Commit after each story's backend and web parts; CI (draft PR) runs integration, contract and e2e
   tests because the dev machine cannot run Docker.
