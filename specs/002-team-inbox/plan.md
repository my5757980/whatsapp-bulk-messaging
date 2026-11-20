# Implementation Plan: Live Chat (Shared Team Inbox)

**Branch**: `002-team-inbox` | **Date**: 2026-11-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-team-inbox/spec.md`

## Summary

Add AiSensy-equivalent live chat to the platform, with our own design and wording:
- one chat per contact per number, holding every message either way
- live states (Active, Requesting, Intervened) and History once the 24-hour window closes
- intervene, resolve, transfer, auto-resolve and agent rules
- free-form replies, templates from History, saved replies and a media library
- blocking, welcome and off-hours messages
- sound and push alerts, the customer journey, and a team view

**Technical approach** (see research.md):
- **Storage:** new `conversations` and `chat_messages` tables. Campaign, API and inbox-template sends
  stay in 001's `messages` table and appear through reference rows.
- **Inbound pipeline:** an extension of the 001 webhook workers. It dedupes on the wamid, applies
  consent and keyword handling, updates the chat, downloads media asynchronously and sends automatic
  replies.
- **Replies:** free-form replies go through each number's existing BullMQ send queue at priority 1,
  so they jump ahead of broadcasts without breaking rate limits.
- **Realtime:** Server-Sent Events through the existing Next.js `/api` proxy, fed by a Redis Stream
  that allows replay after reconnects.
- **Push:** Web Push (VAPID) for alerts while no live chat tab is open.

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, same as 001
**Primary Dependencies**:
- Existing: NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, Next.js 16.4, React 19.3 and
  TanStack Query 5
- **New: `web-push`** (server, VAPID). Pin the newest release that is at least 2 weeks old when it is
  added. No new web libraries: the browser has `EventSource` built in, and the service worker is
  plain JavaScript.

**Storage**:
- PostgreSQL: 9 new tables and 5 altered tables (data-model.md)
- Redis: Stream `wbm:inbox:events`, presence and off-hours keys
- S3/MinIO: inbound and library media

**Testing**:
- Vitest: unit tests for pure rules, integration tests per story with nock for Graph, contract tests
  against `contracts/inbox-api.openapi.yaml`
- Playwright e2e: one spec per story, with mock-meta extended for inbound and free-form traffic

**Target Platform**: the same Docker images as 001 (api/worker and web). SSE must pass through the
Next.js proxy in dev, standalone and Docker.

**Project Type**: web monorepo (`apps/api`, `apps/web`, `packages/shared`, `tools/mock-meta`)

**Performance Goals**:
- SC-001: p95 ≤ 2 s from webhook receipt to the event reaching viewers
- SC-006: list and chat open ≤ 2 s with 10,000 chats and 5,000 messages per chat
- up to 60 concurrent SSE connections (20 members × 3 tabs)

**Constraints**:
- the per-number rate limit is shared with campaigns
- the 24-hour window is enforced on the server twice: at the request and at send time
- no full phone numbers for agents in any payload, push or log
- the dev machine has 3.9 GB of RAM, so heavy test runs go to CI

**Scale/Scope**: 10–20 members, a few thousand inbound messages per day per number, about 12 new
screens and panels, 8 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Result: **PASS** before research and
**PASS** after design.

- [x] **I. Official API & Policy**:
  - Only Cloud API calls are used: messages, media and read receipts (contracts/meta-graph-inbox.md).
  - Free-form messages are allowed only inside the 24-hour window, checked at request and again at
    send time (FR-012–FR-014). Outside it, only templates.
  - Inbox templates follow the opt-in and opt-out rules (FR-017).
  - Automatic messages skip opted-out contacts (FR-036, spec updated for this gate).
  - Human free-form replies inside a customer-opened window stay allowed. They are service replies
    to a customer who just wrote, not business-initiated sends.
  - The broadcast kill switch is unaffected. A number with sending turned off also refuses chat
    sends (FR-018).
- [x] **II. Original Product**: AiSensy is matched in behaviour only. The UI labels are our own:
  Open, Waiting for agent, Taken, Past chats, Take chat, Close chat and Saved replies. So are the
  placeholder syntax (`{first_name}`, `{attr:key}`) and all copy. No screens, text or assets are
  copied; the research used public pages only.
- [x] **III. Security & Privacy**:
  - Session and CSRF are required on every endpoint; the SSE endpoint is a session-authenticated
    GET.
  - New least-privilege permissions are listed in the contract header.
  - The visibility rules are enforced in one predicate for REST, SSE and media.
  - Agents see masked phones in lists, events and push.
  - Webhooks are signature-verified (001), and media is served only through authenticated routes.
  - VAPID private key in env only; audit entries for the actions in FR-040; contact deletion erases
    chat content.
- [x] **IV. Reliable Messaging**:
  - Every chat send is queued on the number's queue with priority. Nothing is sent inline.
  - Rate limits are shared per number; claim-before-send; transient retries with backoff;
    permanent errors are not retried.
  - Inbound dedupe on the wamid and status precedence for chat messages. Failed jobs are kept as
    the dead-letter view.
  - Each message has a status timeline (FR-016).
- [x] **V. Test-First**:
  - Test tasks come first in every story: unit tests for pure rules, an integration test per story
    journey, contract tests and Playwright e2e.
  - Meta is mocked with nock and mock-meta.
  - CI gates are unchanged, plus the redocly lint of the new contract.
- [x] **VI. Observability**:
  - Logs carry `conversationId` and `chatMessageId` correlation, with masked phones and no message
    bodies (the redaction list is extended).
  - New metrics: `wbm_inbox_messages_total{direction,kind}`, `wbm_inbox_event_lag_seconds`,
    `wbm_inbox_sse_connections`, `wbm_inbound_media_failures_total`.
  - A new alert fires when inbound media failures exceed 10% over 15 minutes.
- [x] **VII. Simplicity**: no new service or process. There is one new npm dependency (`web-push`)
  and one new pattern (SSE with a Redis Stream), both justified below.

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker; costs in USD. All are satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/002-team-inbox/
├── spec.md
├── plan.md                    # this file
├── research.md                # Phase 0: R1–R18
├── data-model.md              # Phase 1: tables, state machine, event envelope
├── quickstart.md              # Phase 1: local validation per story
├── contracts/
│   ├── inbox-api.openapi.yaml # dashboard endpoints and new permissions
│   ├── realtime-events.md     # SSE protocol and event types
│   └── meta-graph-inbox.md    # inbound types, free-form send, media, read receipts
├── checklists/requirements.md
└── tasks.md                   # Phase 2 (/sp.tasks)
```

### Source Code (repository root)

```text
apps/api/
├── prisma/migrations/2026112x_live_chat/           # 9 new tables, 5 altered (data-model.md)
├── src/modules/inbox/
│   ├── conversations/   conversations.service.ts, conversations.controller.ts,
│   │                    conversation-state.ts (pure transitions), visibility.ts (one predicate
│   │                    builder for REST/SSE/media), window.ts (pure 24 h helpers)
│   ├── messages/        chat-items.service.ts (timeline, keyset paging, back-fill of references),
│   │                    session-send.service.ts + session-send.processor.ts (priority job on send-{numberId}),
│   │                    template-send.service.ts (messages origin INBOX), read-receipt.processor.ts
│   ├── inbound/         message-parser.ts (pure: webhook entry → chat item), inbound-chat.handler.ts
│   │                    (registered with the 001 WebhookRouter after consent handling),
│   │                    inbound-media.processor.ts
│   ├── realtime/        inbox-events.service.ts (XADD), inbox-stream.controller.ts (SSE GET /inbox/events),
│   │                    stream-fanout.service.ts (XREAD tail per api instance), event-filter.ts
│   ├── routing/         intervene/transfer/resolve in conversations.service.ts; agent-rules.service.ts +
│   │                    controller; window-close.processor.ts; auto-resolve.processor.ts
│   ├── automation/      working-hours.ts (pure), auto-replies.service.ts (welcome/off-hours rules)
│   ├── canned/          canned-messages.service.ts + controller, canned-render.ts (pure variables/params)
│   ├── media-library/   media-library.controller.ts (reuses 001 MediaService validation)
│   ├── settings/        live-chat-settings.service.ts + controller
│   ├── notifications/   push.service.ts (web-push), push-devices.controller.ts, notification-prefs.controller.ts
│   ├── journey/         journey.service.ts
│   └── metrics/         team-metrics.service.ts + controller (openings → medians)
├── src/modules/webhooks/handlers/status.handler.ts   # + chat_messages wamid lookup (R11)
├── src/modules/sending/send-queue.manager.ts         # + session/template jobs, priority 1; campaign jobs priority 10
├── src/modules/maintenance/retention.processor.ts    # + chat data retention (R16)
└── test/
    ├── unit/inbox/        conversation-state, window, visibility, working-hours, auto-replies, canned-render, message-parser
    ├── integration/       inbox-receive-reply, inbox-window-history, inbox-routing, inbox-canned-media,
    │                      inbox-profile-block, inbox-auto-replies, inbox-notifications, inbox-notes-metrics, inbox-realtime
    └── contract/          inbox.contract-spec.ts
apps/web/
├── public/sw.js                                         # push service worker (new public/ folder)
├── src/app/(dashboard)/inbox/page.tsx                   # 3 panes: tabs + list | chat | profile
├── src/app/(dashboard)/inbox/team/page.tsx              # team view
├── src/app/(dashboard)/settings/live-chat/page.tsx      # hours, automatic messages, keywords, auto-close
├── src/app/(dashboard)/settings/saved-replies/page.tsx
├── src/app/(dashboard)/settings/media-library/page.tsx
├── src/app/(dashboard)/settings/team/[id]/rules/        # agent rules (inside the team page)
├── src/app/(dashboard)/account/notifications/page.tsx   # sound + push devices
├── src/components/inbox/                                # conversation-list, chat-view, composer, template-sender,
│                                                        # profile-panel, journey-list, saved-reply-picker, media-picker
└── src/lib/inbox-events.ts                              # EventSource hook + cache updates
packages/shared/src/permissions.ts                       # inbox.view, inbox.reply, inbox.monitor, canned.manage,
                                                         # media.manage, livechat.settings, inbox.metrics
tools/mock-meta/src/                                     # free-form sends, read receipts, media endpoints, inbound CLI types
```

**Structure Decision**: keep 001's monorepo layout. The feature is one NestJS domain module
(`modules/inbox`) wired into `DomainModule` (shared services), `ApiFeaturesModule` (controllers and
SSE) and `WorkerFeaturesModule` (processors and the inbound handler). Feature 001's worker-boot test
checks that the worker graph still compiles. The web side gets the inbox pages plus settings pages
next to 001's.

## Delivery Order (input for /sp.tasks)

| Phase | Scope | Exit check |
|---|---|---|
| Setup and foundation | Migration; permissions; mock-meta extensions; `web-push` dependency; event bus (XADD) and SSE skeleton; visibility predicate; message parser | Unit tests for state, window, visibility and parser are green; the SSE endpoint streams pings through the proxy |
| US1 (P1) | Inbound pipeline, chat creation and back-fill, timeline API, intervene/resolve, free-form text send (priority job), status routing, live list, chat view and composer UI | integration `inbox-receive-reply` and e2e `us1-live-chat` |
| US2 (P1) | Window helpers in the UI, History list, template send from a chat, window-close job and event | `inbox-window-history` and e2e `us2-window-history` |
| US3 (P2) | Talk-to-a-person keywords → Requesting, transfer, auto-resolve job, agent rules API and UI, filters, deactivation hook | `inbox-routing` and e2e `us3-routing` |
| US4 (P2) | Saved replies (CRUD, favourites, render), media library, media sends and limits | `inbox-canned-media` and e2e `us4-saved-replies` |
| US5 (P2) | Profile panel, journey, contact edits from the chat, block/unblock | `inbox-profile-block` and e2e `us5-profile` |
| US6 (P3) | Live chat settings page, working hours, welcome/off-hours rules and sends | `inbox-auto-replies` and e2e `us6-auto-replies` |
| US7 (P3) | Sound preference, push devices, service worker, presence-aware push | `inbox-notifications` and e2e `us7-alerts` (push mocked) |
| US8 (P3) | Notes and mentions, openings and team metrics | `inbox-notes-metrics` and e2e `us8-team-view` |
| Polish | Metrics and alerts, retention and erasure, redaction list, docs (README and quickstart), contract lint in CI, perf check (SC-006 seed script) | All gates green in CI |

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| SSE endpoint with Redis Stream fan-out (new pattern) | FR-009 and SC-001: updates within 2 s and a gap-free catch-up after reconnects | **Polling:** misses 2 s at reasonable load. **Plain Pub/Sub:** loses events during reconnects. **WebSockets:** need a second origin, because Next.js rewrites can't proxy upgrades |
| `web-push` dependency and VAPID keys | FR-037: alerts while no live chat tab is open | **Email:** too slow. **Firebase Cloud Messaging:** adds a vendor account and data flow |
| 9 new tables and 2 join tables | The timeline, journey, metrics openings, read markers, settings, agent rules, saved replies and push devices each have their own lifecycle | **Reusing `messages` for chat items:** breaks 001's campaign invariants (`campaign_id, contact_id` uniqueness, dispatcher, reports) |

## Architectural decisions to record

📋 Architectural decision detected: **Live chat architecture**. Real-time delivery uses SSE with
Redis Stream replay through the first-party proxy, and the chat timeline is stored apart from
campaign messages. This revises ADR-0001's "polling only, no WebSocket/SSE in v1". Document the
reasoning and tradeoffs? Run `/sp.adr live-chat-realtime-and-storage`
