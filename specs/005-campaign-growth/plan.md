# Implementation Plan: Campaign Growth

**Branch**: `005-campaign-growth` | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-campaign-growth/spec.md`

## Summary

Grow what campaigns achieve, with the market leader's documented behaviour and our own design and
wording:
- per-recipient tracked links in template URL buttons and link variables, with click counts, a
  Clicked view and journey entries, where link previews and robots do not count
- retargeting from a campaign's results by Clicked, Not clicked, Replied, Not replied and Held back,
  as well as 001's groups
- user-set retry rounds (up to 3, within 24 hours) for failures that may pass, with a scheduled
  retries view; Meta's per-person marketing limit is held back, not retried
- drip campaigns: steps with waits, quiet hours, starting events, leaving rules, live chat and
  journey entries, and per-step results

**Technical approach** (see research.md):
- **Links:** the api serves `GET /l/:code` on `PUBLIC_LINK_BASE_URL` (the company's own public
  host). It answers 302 with the click recorded unless the request is a preview or a robot. Codes
  are 10 random characters; a tracked button's template address is
  `${PUBLIC_LINK_BASE_URL}/{{1}}` (R1–R3).
- **Retries:** a plan on the campaign; round rows and delayed jobs on the `maintenance` queue, with a
  reconciler sweep. A round re-sends only `FAILED` messages whose last failure is in the 001
  `TRANSIENT` class (R4, R5).
- **Retarget:** new `RetargetStatus` values in 001's snapshot at launch (R6).
- **Drips:** due times live in Postgres. A 30-second `drip-tick` on a new `drips` queue claims due
  enrolments with `SKIP LOCKED`, checks them again and hands messages to the 001 dispatcher.
  Starting events come through an outbox (`drip_events`) written in the triggering transaction, and
  leaving events update enrolments in their own transaction (R7–R10).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, same as 001–004
**Primary Dependencies**:
- Existing: NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, Next.js 16.4, React 19.3,
  TanStack Query 5, Tailwind CSS 4, the 001 dispatcher, send queues, audience builder and variable
  resolver
- No new runtime dependency. Codes use Node's `crypto.randomInt`; user-agent checks are our own
  rules (R3).

**Storage**:
- PostgreSQL: 10 new tables (`tracked_link_targets`, `tracked_links`, `link_clicks`,
  `campaign_retry_rounds`, `drips`, `drip_steps`, `drip_triggers`, `drip_enrolments`,
  `drip_step_sends`, `drip_events`). Columns are added to `campaigns` and `messages`, and four
  enums are extended (data-model.md).
- Redis: a new BullMQ queue `drips` (tick and events); the job `campaign-retry-round` on
  `maintenance`; a short-lived rate-limit key per client for `/l/:code`.

**Testing**:
- Vitest unit tests for pure logic:
  - codes and their alphabet
  - bot and preview detection, device kind
  - retryable failures, retry windows and due times
  - quiet hours across midnight and days
  - next due times, leaving rules, campaign tags on destinations
- Integration tests per story with nock for Meta: `growth-clicks`, `growth-retarget`,
  `growth-retries`, `growth-drips`, `growth-drip-events`, `growth-drip-results`, plus cases in
  `retention`, `contact-deletion` and `rbac`.
- Contract tests against `contracts/growth-api.openapi.yaml`, which is added to `lint:contracts`.
- Playwright e2e per story against mock-meta, which gains failures by number ending: `…1016` fails
  once with 131016, `…1049` with 131049.

**Target Platform**: the same Docker images (api/worker and web) as 001–004. `/l/:code` must be
reachable from phones on the public host that already receives Meta's webhooks.

**Project Type**: web monorepo (`apps/api`, `apps/web`, `packages/shared`, `tools/mock-meta`)

**Performance Goals**:
- SC-001: 95% of tracked-link redirects within 1 second at 100 clicks a second (one indexed lookup
  and one insert)
- SC-005: 95% of drip steps sent within 5 minutes of falling due with 10,000 enrolled contacts
  (30-second tick, batches of 500)
- SC-004: retry rounds start within 2 minutes of their time (delayed job plus a one-minute sweep)

**Constraints**:
- templates only, with 001's consent rules (marketing needs an opt-in) on every new send path
- each number's send rate is shared with live chat (first), campaigns, flows and AI
- Meta allows one variable at the end of a URL button, with an example, and at most 2 URL buttons
  (R2)
- 131049 must wait 24 hours (R4)
- no IP addresses stored with clicks; codes and destinations are not logged with phone numbers
- the dev machine has 3.9 GB RAM, so heavy runs go to CI

**Scale/Scope**:
- up to 20 active drips with 100,000 contacts each; campaigns of up to 100,000 recipients with
  tracked links
- about 6 new screens or panels: campaign tracked links, Clicked view, retarget groups, retry
  plan and scheduled retries, the drip list, the drip editor and results
- 6 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Result: **PASS** before research and
**PASS** after design.

- [x] **I. Official API & Policy**:
  - Every new send (retry rounds, drip steps) is a Meta-approved template through the 001 Cloud API
    path.
  - Marketing templates need a recorded opt-in, and opt-outs win on every path: rounds check consent
    again, drips leave on opt-out and check consent again before each step.
  - Links stay on the company's own domain (no third-party shortener, R1).
  - Meta's per-person marketing limit is respected (no retry within 24 hours, R4).
  - The kill switch is unaffected: pausing a campaign holds its rounds; turning sending off for a
    number stops drip sends through the 001 path.
- [x] **II. Original Product**: behaviour only; screens and wording are ours. Research used Meta's
  public documentation and vendor help pages, never AiSensy's app.
- [x] **III. Security & Privacy**:
  - Session + CSRF on every dashboard endpoint. The public `/l/:code` route only redirects to stored
    addresses (no open redirect), and it is rate-limited.
  - Codes are random and carry no personal data. Clicks store no IP. Phone numbers are masked for
    agents in the Clicked view and drip lists.
  - Audit entries for retry plans, round cancels, destination changes and drip lifecycle and manual
    enrolment (FR-038). Contact deletion erases enrolment and click links (FR-040).
- [x] **IV. Reliable Messaging**:
  - All new sends go through the persistent 001 dispatcher and the per-number send queues.
  - Retries re-send only never-delivered `FAILED` rows (no duplicates, 001 SC-004); permanent errors
    are never retried.
  - Drip ticks claim with `SKIP LOCKED` and write the message and step record in one transaction, so
    there are no double steps. Leaving events beat sends by row locks (SC-006).
  - Status webhooks update drip and retry messages like any message.
- [x] **V. Test-First**: each story starts with failing unit, integration and e2e tests. Meta is
  mocked with nock and mock-meta; CI gates are unchanged, plus the new contract in `lint:contracts`.
- [x] **VI. Observability**:
  - Logs carry `campaignId`, `dripId` and `enrolmentId`; codes and destinations are on the redaction
    list.
  - New metrics `wbm_link_clicks_total{kind}`, `wbm_link_redirect_seconds`,
    `wbm_campaign_retry_messages_total{outcome}`, `wbm_drip_steps_total{result}`,
    `wbm_drip_enrolments_total{via}`, `wbm_drip_due_lag_seconds`; new alert `WbmDripLagging`.
- [x] **VII. Simplicity**: no new service, process or dependency.
  - One new queue, justified below.
  - The drip engine reuses the 001 dispatcher and message records instead of a second send path.
  - Due times live in Postgres instead of thousands of timers.

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker; costs in USD. All are satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/005-campaign-growth/
├── spec.md
├── plan.md                          # this file
├── research.md                      # Phase 0: R1–R13
├── data-model.md                    # Phase 1: tables, states, validation, retention
├── quickstart.md                    # Phase 1: local validation per story
├── contracts/
│   └── growth-api.openapi.yaml      # dashboard endpoints and the public /l/{code} route
├── checklists/requirements.md
└── tasks.md                         # Phase 2 (/sp.tasks)
```

### Source Code (repository root)

```text
packages/shared/src/growth/
├── links.ts            # code alphabet, campaign tags on destinations, destination checks (pure)
├── bots.ts             # preview/robot detection and device kind from a user agent (pure)
├── retries.ts          # retryable failure codes, retry plan validation, round due times (pure)
├── quiet-hours.ts      # next time sending may start, in a time zone (pure)
└── drips.ts            # step and wait limits, next due time, leaving rule checks (pure)
apps/api/
├── prisma/migrations/20261128000000_campaign_growth/   # 10 tables, columns, enums
├── src/modules/growth/
│   ├── links/      tracked-links.service.ts + controller (targets, destinations),
│   │               link-redirect.controller.ts (GET /l/:code), click-recorder.ts,
│   │               clicks.service.ts + controller (summary, Clicked view, export)
│   ├── retries/    retry-plan.service.ts + controller, retry-rounds.service.ts,
│   │               retry-round.processor.ts (maintenance job + sweep)
│   ├── drips/      drips.service.ts + controller (CRUD, steps, triggers, lifecycle),
│   │               enrolments.service.ts (manual, events, leaving), drip-tick.processor.ts,
│   │               drip-events.ts (outbox writer used by the hooks), drip-results.service.ts
│   └── growth.module.ts
├── src/modules/campaigns/retarget.service.ts, audience-snapshot.service.ts  # + new groups
├── src/modules/campaigns/variable-resolver.ts                               # + per-recipient codes
├── src/modules/sending/*                                                    # + DRIP origin, retry_round
├── src/modules/contacts/contacts.service.ts, consent.service.ts,
│   imports/import.processor.ts, flows/engine/session.service.ts,
│   public-api/*                                                             # + drip event hooks
├── src/modules/inbox/inbound/inbound-chat.handler.ts, inbox/conversations/* # + leave on reply, block
├── src/modules/inbox/messages/chat-timeline.service.ts, inbox/journey/*     # + drip label, journey entries
├── src/modules/maintenance/retention.processor.ts, contacts/contact-deletion.service.ts
├── src/common/metrics/metrics.service.ts, common/logging/redaction.ts, ops/alerts.yml
└── test/
    ├── unit/growth/          links, bots, retries, quiet hours, drips, redirect controller
    ├── integration/          growth-clicks, growth-retarget, growth-retries, growth-drips,
    │                         growth-drip-events, growth-drip-results
    └── contract/             growth.contract-spec.ts
apps/web/
├── src/app/(dashboard)/campaigns/[id]/…         # + tracked links, Clicked view, retarget groups,
│                                                #   retry plan and scheduled retries
├── src/app/(dashboard)/campaigns/retries/page.tsx   # scheduled retries across campaigns
├── src/app/(dashboard)/drips/page.tsx           # list and create
├── src/app/(dashboard)/drips/[id]/page.tsx      # editor: steps, waits, quiet hours, starting
│                                                # events, leaving rules, enrol, results
├── src/app/(dashboard)/templates/new/page.tsx   # + Tracked link button
└── e2e/                                         # growth-us1 … growth-us6
tools/mock-meta/src/server.ts                    # + failures by number ending (1016 once, 1049)
tools/perf/drips-latency.ts                      # SC-005 with 10,000 enrolments
```

**Structure Decision**: keep the monorepo layout, with one new NestJS module (`modules/growth`):
- Its services are shared by the HTTP app and the worker. The drip event writer and the leaving
  rules are used by contacts, consent, imports, flows, public API and inbox code, so they sit in a
  global domain module.
- Controllers go in the API module.
- The `drips` tick and the retry-round processor go in `WorkerFeaturesModule`.
- Pure logic the editor also needs lives in `packages/shared/src/growth`.

## Delivery Order (input for /sp.tasks)

| Phase | Scope | Exit check |
|---|---|---|
| Setup and foundation | Migration; `PUBLIC_LINK_BASE_URL`; shared links, bots, retries, quiet hours and drips logic; `drips` queue; mock-meta failures by number ending; contract added to `lint:contracts` | Unit tests for the shared logic are green; the migration applies |
| US1 (P1) | Tracked link targets on campaigns; per-recipient codes at send; `GET /l/:code` with preview and robot detection; clicks, summary, Clicked view and export; journey entry; Tracked link button in the template editor | `growth-clicks` and e2e `growth-us1` |
| US2 (P1) | Retarget groups (counts) and the new snapshot groups; retarget UI | `growth-retarget` and e2e `growth-us2` |
| US3 (P2) | Retry plan, rounds (job and sweep), skipping rules, Held back group, scheduled retries views, recovered counts | `growth-retries` and e2e `growth-us3` |
| US4 (P2) | Drips (CRUD, steps, quiet hours, leaving rules, lifecycle, self-pause), manual enrolment, the tick, timeline and journey | `growth-drips` and e2e `growth-us4` |
| US5 (P2) | Starting events through the outbox from tags, consent, imports, the public API and clicks | `growth-drip-events` and e2e `growth-us5` |
| US6 (P3) | Drip results, contact lists per count, export | `growth-drip-results` and e2e `growth-us6` |
| Polish | Metrics and alert, retention and erasure, redaction, audit coverage, RBAC from all contracts, perf check (SC-005), docs (README, inventory), release checklist | All gates green in CI |

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Public `/l/:code` route on the api | FR-002–FR-005: per-person clicks need a link the platform serves | **A third-party shortener:** against Meta's guidance and gives click data away. **Serving through the web app:** an extra hop on every click (SC-001) |
| Queue `drips` | FR-020/FR-021: steps fall due all the time and must not wait on campaign dispatch | **Reusing `campaign-dispatch`:** a large campaign would delay due steps (SC-005) |
| `drip_events` outbox | FR-024: enrolment must follow tags, consent, imports, API and clicks without losing events | **Calling the enroller after commit:** events are lost on a crash; **a job per event:** more jobs for the same result |
| 10 new tables | Links, clicks, rounds, drips, steps, triggers, enrolments, step results and events have separate lifecycles and retention | **JSON on campaigns:** no per-recipient codes, no exact counts, no erasure by contact |

## Architectural decisions to record

📋 Architectural decision detected: **tracked links and the drip engine**. Per-recipient redirect
links on the company's own domain served by the api, and drips run from due times in Postgres by a
30-second tick with an outbox for starting events, instead of per-contact timers or an outside
service. Document the reasoning and tradeoffs? Run `/sp.adr campaign-growth-links-and-drips`
