# Implementation Plan: Chatbot Flow Builder

**Branch**: `003-chatbot-flow-builder` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-chatbot-flow-builder/spec.md`

## Summary

Add a no-code chatbot flow builder that matches the market leader's documented behaviour with our
own design and wording:
- a canvas of steps (messages, buttons, lists, questions, tags, attributes, conditions, delays, API
  calls, jumps, hand-over, end) with draft, published versions, revisions and test numbers
- triggers: keywords (exact/contains), patterns, template quick-reply buttons, first-message rules
  (finishing 002's first-message tag) and manual start from live chat
- a session engine that answers customers inside the 24-hour window and gives way to people in live
  chat, consent and blocking rules
- per-step analytics and starter flows

**Technical approach** (see research.md):
- **Storage:** `flows` (with the draft graph), `flow_versions` (published and revisions),
  `flow_triggers` (derived on publish for matching), `flow_sessions`, `flow_session_steps`,
  `flow_secrets`. The graph format is one shared zod schema (contracts/flow-graph.md).
- **Engine:** a pure interpreter returns the next session state and a list of effects; a service
  applies them in one transaction under a per-conversation advisory lock, with a partial unique index
  for one running session per chat.
- **Pipeline:** 002's inbound chat handler calls the flow router after consent and keyword handling
  and before welcome/off-hours messages; 002's take/reply/template paths stop running sessions.
- **Sending:** flow messages are 002 chat messages (origin AUTOMATIC) on the number's send queue
  with chat priority; two new content types for interactive buttons and lists.
- **Timers and API calls:** a new BullMQ queue `flows` (delayed timer jobs with a wait token; API
  calls with an SSRF-safe HTTPS client).
- **Editor:** `@xyflow/react` 12.12.1 canvas with React panels per step type and autosave.

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, same as 001 and 002
**Primary Dependencies**:
- Existing: NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, libphonenumber-js, Next.js
  16.4, React 19.3, TanStack Query 5, Tailwind CSS 4
- **New: `@xyflow/react` 12.12.1** (web canvas; the newest release at least 2 weeks old). No new
  server dependency: the API client uses Node's `fetch` with undici's `Agent` (bundled with Node) and
  `node:vm` for pattern time limits.

**Storage**:
- PostgreSQL: 7 new tables, 3 altered enums (data-model.md)
- Redis: the new `flows` BullMQ queue (delayed timers, API jobs)
- S3/MinIO: no change (message steps use 002 media library files)

**Testing**:
- Vitest unit tests for pure logic: graph schema and publish validator, trigger matcher, answer
  validators, condition evaluator, variable rendering, engine transitions per step type, SSRF guard
- Integration tests per story (nock for Graph and for API-step endpoints), contract tests against
  `contracts/flows-api.openapi.yaml`
- Playwright e2e per story; flows are mostly created through the API, with an editor smoke test that
  adds and connects steps on the canvas

**Target Platform**: the same Docker images (api/worker and web) as 001/002

**Project Type**: web monorepo (`apps/api`, `apps/web`, `packages/shared`, `tools/mock-meta`)

**Performance Goals**:
- SC-001: p95 ≤ 3 s from a customer message reaching the platform to the flow's next message being
  queued for WhatsApp
- SC-006: a 200-step flow opens in ≤ 2 s and publishes in ≤ 5 s
- SC-008: API failures reach the failed branch within timeout + 1 s

**Constraints**:
- the per-number send rate is shared with campaigns and live chat (chat priority as in 002)
- free-form only inside the 24-hour window, checked when planning a send and again at send time
- one running session per chat even with concurrent webhooks
- no answers, API secrets or message bodies in logs; phones masked
- the dev machine has 3.9 GB of RAM, so heavy test runs go to CI

**Scale/Scope**: tens of flows, up to 200 steps each, a few thousand sessions a day; about 6 new
screens and panels; 9 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Result: **PASS** before research and
**PASS** after design.

- [x] **I. Official API & Policy**:
  - Only Cloud API messages (text, media, interactive buttons and lists) are sent
    (contracts/meta-graph-flows.md).
  - Flows send free-form messages only inside the 24-hour window; a send planned after it ends the
    session (FR-028). Flows never send templates in this feature.
  - Opt-out holds on the flow path: the opt-out keyword ends any session with no reply, and opted-out
    contacts cannot be targeted because flows only answer customer-opened chats (FR-027). Blocked
    contacts never meet flows.
  - The kill switch is unaffected: a number with sending turned off refuses flow sends (002 path).
- [x] **II. Original Product**: behaviour only. Step names, labels, starter flows and all texts are
  written by us; no screens, text or assets are copied (research used public pages only).
- [x] **III. Security & Privacy**:
  - Session + CSRF on every endpoint; new least-privilege permission `flows.manage`; starting a flow
    from a chat uses `inbox.reply` within 002 visibility.
  - API-step secrets are encrypted with the 001 cipher, never returned, logged or exported.
  - API calls: HTTPS only, private and internal networks blocked at connect time, no redirects,
    timeouts and size limits.
  - Audit entries for flow changes (FR-039); contact deletion clears session answers (FR-040).
- [x] **IV. Reliable Messaging**:
  - Every flow message is queued on the number's queue (002 path); claim-before-send, retries with
    backoff, permanent errors not retried; statuses and timeline as in 002.
  - Inbound dedupe on the wamid (002) plus the per-conversation lock and unique running session
    prevent double steps; timers carry a wait token so late or duplicate jobs do nothing.
  - Failed jobs on the `flows` queue are kept as the dead-letter view.
- [x] **V. Test-First**: each story starts with failing unit, integration and e2e tests; Meta is
  mocked with nock and mock-meta; API-step endpoints are mocked; CI gates unchanged plus the redocly
  lint of the new contract.
- [x] **VI. Observability**:
  - Logs carry `flowId`, `sessionId` and `conversationId`; answers and secrets are added to the
    redaction list.
  - New metrics: `wbm_flow_sessions_total{result}`, `wbm_flow_steps_total{type}`,
    `wbm_flow_api_calls_total{outcome}`, `wbm_flow_api_duration_seconds`.
  - New alert: more than 20% of API calls failing over 15 minutes (at least 20 calls).
- [x] **VII. Simplicity**: no new service or process. One new web dependency (the canvas library) and
  one new queue, both justified below. The engine is a small interpreter, not a workflow product.

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker; costs in USD. All are satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/003-chatbot-flow-builder/
├── spec.md
├── plan.md                     # this file
├── research.md                 # Phase 0: R1–R17
├── data-model.md               # Phase 1: tables, session state machine, validation, retention
├── quickstart.md               # Phase 1: local validation per story
├── contracts/
│   ├── flows-api.openapi.yaml  # dashboard endpoints and the new permission
│   ├── flow-graph.md           # the graph JSON document (draft, versions)
│   └── meta-graph-flows.md     # interactive sends, inbound replies, mock-meta additions
├── checklists/requirements.md
└── tasks.md                    # Phase 2 (/sp.tasks)
```

### Source Code (repository root)

```text
packages/shared/src/flows/
├── graph.ts              # zod schema + types for flow-graph.md, limits
├── validate.ts           # publish checks (pure): reachability, branches, limits, loops
├── answers.ts            # answer validators and normalisers (pure)
├── conditions.ts         # condition evaluation (pure)
├── triggers.ts           # keyword normalisation, matching order, safe-pattern check (pure)
└── starters/             # 6 starter flows written by us
apps/api/
├── prisma/migrations/20261125000000_flows/          # 7 tables, enum additions (data-model.md)
├── src/modules/flows/
│   ├── definitions/  flows.service.ts + flows.controller.ts (CRUD, draft save, duplicate),
│   │                 publish.service.ts (validate, version, triggers), versions.service.ts,
│   │                 secrets.service.ts, starters.controller.ts
│   ├── engine/       run.ts (pure interpreter), effects.ts, session.service.ts (lock, apply
│   │                 effects, stop/expire), flow-router.ts (inbound routing), trigger-matcher.ts
│   │                 (DB + pattern vm), render.ts (variables via 002 renderer)
│   ├── steps/        api-client.ts (SSRF-safe fetch), api-step.processor.ts, timer.processor.ts,
│   │                 expiry.processor.ts
│   ├── analytics/    flow-analytics.service.ts + controller (counts, dropped CSV)
│   ├── live-chat/    flow-start.controller.ts (start from a chat, running session)
│   └── flows.module.ts
├── src/modules/inbox/inbound/inbound-chat.handler.ts   # + FlowRouter call before auto replies
├── src/modules/inbox/conversations/conversations.service.ts, messages/session-send.service.ts,
│   messages/template-send.service.ts                   # + stop running sessions on member actions
├── src/modules/inbox/messages/session-send.processor.ts # + interactive BUTTONS/LIST payloads
├── src/modules/maintenance/retention.processor.ts, contacts/contact-deletion.service.ts  # + sessions
└── test/
    ├── unit/flows/          graph, validate, answers, conditions, triggers, run (engine), api-client guard
    ├── integration/         flows-build-publish, flows-questions, flows-live-chat, flows-logic,
    │                        flows-api-step, flows-triggers, flows-testing, flows-analytics
    └── contract/            flows.contract-spec.ts
apps/web/
├── src/app/(dashboard)/flows/page.tsx              # list, create, starters
├── src/app/(dashboard)/flows/[id]/page.tsx         # canvas editor, test panel, analytics mode
├── src/components/flows/                           # canvas, node views per step type, step forms,
│                                                   # trigger panel, problems panel, versions, secrets
├── src/components/inbox/                           # + "Start a flow" action, running-flow banner,
│                                                   #   BUTTONS/LIST item views
└── e2e/                                            # flows-us1 … flows-us9
packages/shared/src/permissions.ts                  # + flows.manage
tools/mock-meta/src/                                # + interactive sends, inbound --button-id/--list-id/--context
```

**Structure Decision**: keep the monorepo layout. The feature is one NestJS module (`modules/flows`)
wired like 002: shared services in a global domain module (session service, router, publisher),
HTTP controllers in the API module, and the `flows` queue processors in `WorkerFeaturesModule`. Pure
logic that the editor also needs lives in `packages/shared/src/flows`.

## Delivery Order (input for /sp.tasks)

| Phase | Scope | Exit check |
|---|---|---|
| Setup and foundation | Migration; `flows.manage`; shared graph schema and validator skeleton; `flows` queue; mock-meta interactive sends and CLI flags; `@xyflow/react` dependency; interactive content types in the 002 send processor | Unit tests for the schema are green; mock-meta accepts interactive sends |
| US1 (P1) | Flow CRUD and draft save, publish/unpublish with problems, keyword triggers, engine for message/buttons/end, inbound routing, timeline label, list page and canvas editor with message and buttons steps | `flows-build-publish` and e2e `flows-us1` |
| US2 (P1) | Question and list steps, answers and validation, retries, timeouts (timer jobs), attribute saving, variables | `flows-questions` and e2e `flows-us2` |
| US3 (P1) | Hand-over, stop on member actions, Open-only rule, opt-out/blocked/"talk to a person", skip welcome/off-hours, start a flow from live chat, running-flow banner | `flows-live-chat` and e2e `flows-us3` |
| US4 (P2) | Tags, attributes, conditions (incl. working hours), delay, jump, end; loop checks | `flows-logic` and e2e `flows-us4` |
| US5 (P2) | API step with SSRF-safe client, mapping, secrets, test request | `flows-api-step` and e2e `flows-us5` |
| US6 (P2) | Pattern, template-button and first-message triggers; matching order; reserved and duplicate keyword checks | `flows-triggers` and e2e `flows-us6` |
| US7 (P2) | Test numbers and draft runs, versions, revisions and restore, unpublish ending sessions | `flows-testing` and e2e `flows-us7` |
| US8 (P3) | Step records, analytics endpoint and canvas overlay, dropped CSV | `flows-analytics` and e2e `flows-us8` |
| US9 (P3) | Starter flows and attribute creation offer | unit tests on starters (they validate) and e2e `flows-us9` |
| Polish | Metrics and alert, retention and erasure, redaction, audit coverage, RBAC from all contracts, docs (README, quickstart), perf check (SC-001/SC-006) | All gates green in CI |

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `@xyflow/react` (canvas library) | FR-006: a visual canvas with connected steps, zoom and selection; SC-006 for 200 steps | **A hand-built canvas:** weeks of work on dragging, edges and zoom. **A form-only editor:** the spec asks for a canvas |
| New BullMQ queue `flows` | Delays and question timeouts (FR-009, FR-013) need durable timers; API calls (FR-014) must not block inbound handling | **Polling the sessions table for due timers:** more database load and slower reactions. **Calling APIs in the inbound worker:** stalls message handling for up to 10 s |
| Pattern matching in `node:vm` with a timeout | FR-019 pattern triggers written by managers must not stall the worker | **Native `re2`:** a native build in every image. **No pattern triggers:** loses a documented trigger type |
| 7 new tables | Flows, versions, derived triggers, sessions, step records (analytics), secrets and flow numbers have separate lifecycles | **Storing sessions inside chat rows:** breaks the one-session rule and analytics queries |

## Architectural decisions to record

📋 Architectural decision detected: **Chatbot flow engine**. Flows are versioned JSON graphs run by a
pure session interpreter in the worker, with BullMQ timers, a per-conversation lock and the 002 send
path; the editor uses React Flow. Document the reasoning and tradeoffs? Run
`/sp.adr chatbot-flow-engine`
