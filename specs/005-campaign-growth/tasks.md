---
description: "Task list for campaign growth (feature 005)"
---

# Tasks: Campaign Growth

**Input**: Design documents from `/specs/005-campaign-growth/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/growth-api.openapi.yaml,
quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- Meta is mocked with nock in integration tests and with mock-meta in e2e.
- mock-meta gains failures by number ending: `…1016` fails once with 131016, `…1049` with 131049,
  and `…0000` already fails with 131026.
- Clicks are simulated with HTTP requests to `/l/:code` with chosen user agents.

**Organization**: by user story (spec.md US1–US6), after the Setup and Foundational phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US6); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: configuration, the queue name, the fake Meta failures and the contract lint that every
story needs.

- [X] T001 Add `PUBLIC_LINK_BASE_URL` (a URL; `https://` required when `NODE_ENV=production`) to the env schema in apps/api/src/common/config/config.ts and to .env.example with a comment (research R1). Set `http://localhost:4000/l` for the e2e job in .github/workflows/ci.yml
- [X] T002 [P] Add `DRIPS: 'drips'` (the drip tick and starting events) to `QUEUES` in apps/api/src/common/queue/queue.constants.ts with a comment (feature 005)
- [X] T003 [P] Add failures by recipient number ending to tools/mock-meta/src/server.ts, next to the existing `…0000` rule: `…1016` fails the first send with 131016 and delivers later sends, and `…1049` fails with 131049 (tasks Tests note)
- [X] T004 [P] Add specs/005-campaign-growth/contracts/growth-api.openapi.yaml to the `lint:contracts` script in package.json

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, the shared pure logic, the module wiring and the audit actions that all
stories use.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [X] T005 Write the Prisma models and the migration apps/api/prisma/migrations/20261128000000_campaign_growth/migration.sql per data-model.md:
  - the 10 tables
  - `campaigns.retry_rounds` and `retry_delays_min`; `messages.retry_round`, `drip_enrolment_id` and `drip_step_id`
  - the new enums `ClickDevice`, `RetryRoundStatus`, `DripStatus`, `DripTriggerKind`, `DripJoinVia`, `EnrolmentStatus`, `DripLeftReason` and `StepOutcome`
  - `MessageOrigin` + `DRIP`; `RetargetStatus` + `CLICKED`, `NOT_CLICKED`, `REPLIED`, `NOT_REPLIED`, `HELD_BACK`; `JourneyEventType` + `DRIP_JOINED`, `DRIP_LEFT`, `LINK_CLICKED`
  - the partial unique index on active enrolments and the indexes of data-model.md §1

  Update apps/api/prisma/schema.prisma and run `prisma generate`.
- [ ] T006 [P] Unit tests packages/shared/src/growth/links.test.ts: a code is 10 characters from `[0-9A-Za-z]`; destinations are only `https://` or `http://` (with an `http` warning flag), at most 2,000 characters, and not on the tracking base; campaign tags are added and existing query parameters are kept
- [ ] T007 [P] Unit tests packages/shared/src/growth/bots.test.ts: these are previews, not clicks: `WhatsApp/2.24.20.72 A`, `facebookexternalhit/1.1`, `Twitterbot`, `Slackbot`, a generic `bot` or `crawler` token, `HEAD`, and `Purpose: prefetch`. Device kind is `MOBILE` for Android and iPhone, `DESKTOP` for Windows Chrome, `OTHER` for no user agent
- [ ] T008 [P] Unit tests packages/shared/src/growth/retries.test.ts: plans have 0–3 rounds, delays only from {30, 60, 120, 240, 480, 720}, and a sum of at most 1,440 minutes (`RETRY_WINDOW_EXCEEDED`); a round's due time is the previous finish plus its delay; a round after launch + 24 hours is skipped
- [ ] T009 [P] Unit tests packages/shared/src/growth/quiet-hours.test.ts: inside and outside a window, windows across midnight, chosen days only, the next time sending may start in `Asia/Dubai` and in a time zone with daylight saving
- [ ] T010 [P] Unit tests packages/shared/src/growth/drips.test.ts: wait limits (0 only at step 1, 10–43,200 minutes otherwise); the next due time is the previous send plus the wait, moved past quiet hours; a removed step moves a waiting contact on to the next live step; leaving-rule decisions per event and setting
- [ ] T011 Implement packages/shared/src/growth/links.ts, bots.ts, retries.ts, quiet-hours.ts and drips.ts (pure) and export them from packages/shared/src/index.ts
- [ ] T012 [P] Add the 005 audit actions of data-model.md §2 to apps/api/src/modules/audit/audit-actions.ts, and list them in `PENDING` in apps/api/test/unit/audit-coverage.spec.ts until their story records them
- [ ] T013 Create apps/api/src/modules/growth/growth.module.ts and wire it into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts:
  - `GrowthDomainModule` (global): the drip event writer, the leaving rules and the link click recorder
  - `GrowthApiModule`: the controllers
  - the worker processors

  Keep apps/api/test/unit/app-module.spec.ts green.
- [ ] T014 [P] Add apps/web/src/lib/growth.ts (types from the contract and query keys) and a **Drips** entry (`campaigns.view`) to the dashboard navigation in apps/web/src/app/(dashboard)/layout.tsx

**Checkpoint**: migration applies, shared logic is green, the module compiles in the HTTP app and
the worker.

---

## Phase 3: User Story 1 - See who clicked the links in a campaign (Priority: P1) 🎯 MVP

**Goal**: per-recipient tracked links in campaigns, a redirect that counts real clicks only, and
click results.

**Independent Test**: a campaign with a tracked button to 3 contacts. After clicks as a phone (one
contact twice) and a WhatsApp preview, the results show 2 clickers, 3 clicks and the Clicked view.

### Tests for User Story 1 (REQUIRED) ⚠️

- [ ] T015 [P] [US1] Unit tests apps/api/test/unit/growth/link-redirect.spec.ts for the redirect controller and click recorder:
  - a `302` with `Location`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
  - a preview is redirected and not recorded
  - an unknown code gets the `404` page without redirecting
  - campaign tags are added when switched on
  - the per-client rate limit returns `429`
  - no IP is stored
- [ ] T016 [P] [US1] Integration test apps/api/test/integration/growth-clicks.int-spec.ts:
  - `GET /tracked-links/config`
  - `trackable` lists a URL button on the tracking prefix and a link body variable, and refuses a button elsewhere (`LINK_NOT_TRACKABLE`)
  - `PUT` tracked links on a draft, then `409 CAMPAIGN_NOT_EDITABLE` after launch
  - at launch each message gets its own code: nock checks the button parameter and the full link in a body variable
  - clicks through `/l/:code` with a phone user agent count; a `WhatsApp/2…` user agent does not
  - summary (clickers, clicks, rate over delivered, per link), the Clicked view with first, last and count (phones masked for agents) and the CSV export
  - a `LINK_CLICKED` journey entry, and the first click on the message's timeline item
  - a destination change mid-campaign sends new clicks to the new address and is audited
- [ ] T017 [P] [US1] Contract cases in apps/api/test/contract/growth.contract-spec.ts for `GET /tracked-links/config`, `GET/PUT /campaigns/{id}/tracked-links`, `PATCH /tracked-link-targets/{id}`, `GET /campaigns/{id}/clicks/summary`, `GET /campaigns/{id}/clicks` and `GET /campaigns/{id}/clicks/export`
- [ ] T018 [P] [US1] Playwright e2e apps/web/e2e/growth-us1-clicks.spec.ts:
  - create a template with **Tracked link button**; mock-meta approves it on sync
  - create a campaign to 3 contacts with the tracked button to `https://shop.example/sale` and send it
  - open two contacts' links as a phone (one twice) and one as WhatsApp, using codes from mock-meta's sent log
  - see 2 clickers and 3 clicks in **Results → Clicked**

### Implementation for User Story 1

- [ ] T019 [US1] Implement apps/api/src/modules/growth/links/tracked-links.service.ts and tracked-links.controller.ts:
  - the config endpoint
  - `trackable` analysis from the template's components (URL buttons with the `${PUBLIC_LINK_BASE_URL}/{{1}}` address, text variables)
  - `GET/PUT` targets for draft or scheduled campaigns (`campaigns.manage`)
  - `PATCH /tracked-link-targets/:id` with audit `tracked_link.destination_changed`
- [ ] T020 [US1] Give each recipient a code when messages are created at launch, in apps/api/src/modules/campaigns/launch.service.ts (`snapshotAndRun`) and apps/api/src/modules/campaigns/variable-resolver.ts:
  - insert `tracked_links` rows in the snapshot batches, retrying on a code collision
  - put the code (URL button variable) or the full short link (text variable) into the message's resolved parameters
  - creating a code twice for a message must not change it
- [ ] T021 [US1] Implement apps/api/src/modules/growth/links/link-redirect.controller.ts (`GET /l/:code` outside the global `api` prefix: add it to the prefix's `exclude` list in apps/api/src/app.setup.ts next to `metrics`; `@Public()` from apps/api/src/common/auth/public.decorator.ts so there is no session or CSRF; rate-limited per client by a salted IP hash with a short Redis time to live) and apps/api/src/modules/growth/links/click-recorder.ts:
  - detection with `packages/shared` bots.ts
  - insert `link_clicks` with the copied campaign or step, the contact and the device kind
  - the `LINK_CLICKED` journey entry through apps/api/src/modules/inbox/journey/journey.service.ts
- [ ] T022 [US1] Implement apps/api/src/modules/growth/links/clicks.service.ts and clicks.controller.ts: summary, the Clicked view paged with phones masked by role as in 001, and the streamed CSV export (`data.export`)
- [ ] T023 [US1] Show the first click on template message items: add `firstClickAt` to message references in apps/api/src/modules/inbox/messages/chat-timeline.service.ts and the item DTO, and a "Link opened" note in apps/web/src/components/inbox/chat-item-view.tsx
- [ ] T024 [P] [US1] Add **Tracked link button** to the URL button form of apps/web/src/app/(dashboard)/templates/new/page.tsx: it fills the address from `GET /tracked-links/config` and an example code, with help text on why it is needed
- [ ] T025 [P] [US1] Add tracked links to the campaign editor in apps/web/src/app/(dashboard)/campaigns/new/ (per trackable variable: destination, campaign tags, the reason when not trackable). Add the Clicked results (cards, per-link table, Clicked view, export, edit destination) to apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx
- [ ] T026 [P] [US1] Add `LINK_CLICKED` wording to apps/web/src/components/inbox/journey-list.tsx with cases in apps/web/tests/journey-list.test.ts

**Checkpoint**: US1 works on its own: tracked campaigns show real clicks per person.

---

## Phase 4: User Story 2 - Retarget clickers, repliers and others in one step (Priority: P1)

**Goal**: the new retarget groups with their sizes, created in one step.

**Independent Test**: after US1, choose **Retarget → Clicked**. The draft names the source, and at
launch its audience is the clickers minus anyone who opted out.

### Tests for User Story 2 (REQUIRED) ⚠️

- [ ] T027 [P] [US2] Integration test apps/api/test/integration/growth-retarget.int-spec.ts:
  - `GET /campaigns/{id}/retarget-groups` counts all nine groups, with `available: false` for empty ones
  - retargeting `CLICKED`, `NOT_CLICKED`, `REPLIED`, `NOT_REPLIED` and `HELD_BACK` creates drafts whose launch snapshot equals the group minus opted-out and deleted contacts
  - a reply within 72 hours of delivery counts and one after does not
  - the 001 groups are unchanged
  - a campaign with purged messages gives `409`
- [ ] T028 [P] [US2] Contract cases in apps/api/test/contract/growth.contract-spec.ts for `GET /campaigns/{id}/retarget-groups` and `POST /campaigns/{id}/retarget` with each new status
- [ ] T029 [P] [US2] Playwright e2e apps/web/e2e/growth-us2-retarget.spec.ts: from the US1-style campaign open **Retarget**, see the sizes, choose **Clicked**, launch the draft, and confirm the recipients are the clickers (mock-meta sent log)

### Implementation for User Story 2

- [ ] T030 [US2] Extend `RetargetSchema` and the group labels in apps/api/src/modules/campaigns/retarget.service.ts, and the snapshot SQL for the new groups in apps/api/src/modules/campaigns/audience-snapshot.service.ts (research R6)
- [ ] T031 [US2] Add `GET /campaigns/:id/retarget-groups` (`campaigns.view`) to apps/api/src/modules/campaigns/campaigns.controller.ts with the counting queries in retarget.service.ts
- [ ] T032 [P] [US2] Add the retarget dialog with group sizes (unavailable groups disabled with the reason) as apps/web/src/components/campaigns/retarget-dialog.tsx, opened from apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx

**Checkpoint**: US1 + US2 are the P1 release.

---

## Phase 5: User Story 3 - Retry failed messages automatically (Priority: P2)

**Goal**: up to 3 retry rounds within 24 hours for failures that may pass, with scheduled retries
views.

**Independent Test**: 20 recipients with 2 rounds. Five temporary failures go into round 1 and are
recovered; 131026 is never retried; 131049 is held back; nobody gets the message twice.

### Tests for User Story 3 (REQUIRED) ⚠️

- [ ] T033 [P] [US3] Unit test apps/api/test/unit/growth/retryable.spec.ts: every `TRANSIENT` code of apps/api/src/modules/meta/meta-error-classifier.ts and an HTTP 5xx without a code are retryable. 131049 is `HELD_BACK`. 131026, 131048, 131050, 132xxx and `BLOCKING` codes are never retried
- [ ] T034 [P] [US3] Integration test apps/api/test/integration/growth-retries.int-spec.ts:
  - **plan:** validation and audit; editable only while draft or scheduled
  - **scheduling:** once the first pass is final, round 1 is scheduled with the retryable failures only
  - **running a round** (the processor invoked directly, Meta with nock):
    - recovered messages are counted
    - round 2 takes the rest
    - an opt-out between rounds is skipped
    - no message is sent twice (attempt records)
  - **outcomes:**
    - a paused campaign holds its rounds, and a cancelled one cancels them
    - rounds are skipped when the template is paused, the number is disconnected, or the round is past 24 hours
  - **jobs:** the reconciler sweep starts a due round whose job was lost
  - **views:** `GET /retry-rounds` across campaigns; one round or all rounds can be cancelled, with audit
- [ ] T035 [P] [US3] Contract cases in apps/api/test/contract/growth.contract-spec.ts for `GET/PUT /campaigns/{id}/retry-plan`, `GET /campaigns/{id}/retry-rounds`, both cancel endpoints and `GET /retry-rounds`
- [ ] T036 [P] [US3] Playwright e2e apps/web/e2e/growth-us3-retries.spec.ts:
  - set 2 rounds on a draft whose contacts end in `1016`, `0000` and `1049`, then launch it
  - **Scheduled retries** shows round 1 with only the `1016` recipients
  - the `1049` one is under **Held back**
  - cancelling the round works

### Implementation for User Story 3

- [ ] T037 [US3] Implement apps/api/src/modules/growth/retries/retry-plan.service.ts and retry-plan.controller.ts (the campaign columns, `campaign.retry_plan_changed` audit), and the retryable classification next to apps/api/src/modules/meta/meta-error-classifier.ts
- [ ] T038 [US3] Implement apps/api/src/modules/growth/retries/retry-rounds.service.ts:
  - schedule round 1 when the first pass is final, from apps/api/src/modules/campaigns/campaign-progress.processor.ts
  - the next round after each finish
  - cancel one round or all; hold while paused and cancel on cancel, from apps/api/src/modules/campaigns/campaign-control.service.ts
  - the skip notes
- [ ] T039 [US3] Implement apps/api/src/modules/growth/retries/retry-round.processor.ts:
  - the `campaign-retry-round` job on `campaign-dispatch`, plus the one-minute sweep in apps/api/src/modules/campaigns/schedule-reconciler.processor.ts
  - running a round:
    - reset the round's `FAILED` retryable messages to `PENDING` with `retry_round`
    - hand them to the 001 dispatcher (apps/api/src/modules/campaigns/dispatch-scheduler.ts)
    - record the recipients
  - fill in `recovered` when the round's messages are final
- [ ] T040 [P] [US3] Add to the web:
  - the retry plan form to the campaign editor's review step in apps/web/src/app/(dashboard)/campaigns/new/
  - the scheduled retries panel and the Held back group to apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx
  - the cross-campaign list apps/web/src/app/(dashboard)/campaigns/retries/page.tsx

**Checkpoint**: retries recover temporary failures without duplicates.

---

## Phase 6: User Story 4 - Build and run a drip campaign (Priority: P2)

**Goal**: drips with steps, waits, quiet hours, leaving rules and manual enrolment, sent by the tick.

**Independent Test**: a 3-step drip with quiet hours and two contacts enrolled by hand. Both get
step 1; the one who replies leaves; a step due in quiet hours waits.

### Tests for User Story 4 (REQUIRED) ⚠️

- [ ] T041 [P] [US4] Integration test apps/api/test/integration/growth-drips.int-spec.ts:
  - **building:** names unique among drips that are not archived; step validation; the activation problems of FR-022
  - **manual enrolment:** preview and enrol, with opted-out contacts and contacts already in the drip counted and skipped
  - **the tick:** it sends step 1 after its wait (move `next_due_at` back); a step due in quiet hours waits
  - **leaving:** on a reply (inbound webhook), an opt-out, a block, a stop tag, deletion or removal, with no step after the event (SC-006)
  - **step outcomes:**
    - a marketing step with no opt-in is skipped and the contact moves on
    - an invalid number (131026 webhook) ends the drip
    - another failure moves on
  - **self-pause:** a paused template or a disconnected number pauses the drip and alerts managers
  - **lifecycle:**
    - editing an active drip reaches only steps not reached; a removed step moves the contact on
    - pause and resume
    - archive (enrolments leave with `ARCHIVED`)
    - the rejoin rule
  - **live chat:** drip messages show in the chat timeline as automatic with the drip label, and `DRIP_JOINED`/`DRIP_LEFT` journey entries are written
- [ ] T042 [P] [US4] Contract cases in apps/api/test/contract/growth.contract-spec.ts for `GET/POST /drips`, `GET/PATCH/DELETE /drips/{id}`, `PUT /drips/{id}/steps`, `POST /drips/{id}/activate`, `/pause`, `/archive`, `GET/POST /drips/{id}/enrolments`, `POST /drips/{id}/enrolments/preview` and `DELETE /drips/{id}/enrolments/{enrolmentId}`
- [ ] T043 [P] [US4] Playwright e2e apps/web/e2e/growth-us4-drips.spec.ts:
  - build a 2-step drip (step 1 right away, step 2 after 10 minutes) and activate it
  - enrol two contacts by hand: both get step 1
  - one replies and shows "Left: replied"; the drip message shows in live chat as automatic

### Implementation for User Story 4

- [ ] T044 [US4] Implement apps/api/src/modules/growth/drips/drips.service.ts and drips.controller.ts:
  - CRUD and settings
  - steps, with tracked links reusing the US1 targets on `drip_step_id`, and soft delete of removed steps
  - starting events stored as `drip_triggers`
  - the activation checks of FR-022 with problems
  - pause, resume, archive and delete
  - the limit of 20 active drips
  - audit
- [ ] T045 [US4] Implement apps/api/src/modules/growth/drips/enrolments.service.ts:
  - manual enrolment by ids or a filter through apps/api/src/modules/contacts/audience-query.builder.ts, in batches of 1,000, with its preview
  - removal, and the rejoin rule
  - `leave(tx, contact, reason, scope)`, used by the leaving hooks
- [ ] T046 [US4] Implement apps/api/src/modules/growth/drips/drip-tick.processor.ts:
  - a repeatable 30-second job on `drips`
  - claim due enrolments of active drips outside quiet hours with `FOR UPDATE SKIP LOCKED` in batches of 500
  - check consent, blocking and state again
  - write the `messages` row (origin `DRIP`, resolved params, tracked codes) and the `drip_step_sends` row, then advance or finish
  - hand the messages to the dispatcher after commit
  - self-pause and alert through apps/api/src/modules/notifications/notifications.service.ts
- [ ] T047 [US4] Add the leaving hooks in the same transaction as each event:
  - a reply: apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
  - an opt-out: apps/api/src/modules/contacts/consent.service.ts
  - a block: apps/api/src/modules/inbox/conversations/chat-contact.service.ts
  - a deletion: apps/api/src/modules/contacts/contact-deletion.service.ts
  - an invalid number on a drip message: apps/api/src/modules/webhooks/handlers/status.handler.ts
- [ ] T048 [US4] Show drip messages in live chat and the journey:
  - `DRIP` → `AUTOMATIC` with the "Drip <name> · step n" label in apps/api/src/modules/inbox/messages/chat-timeline.service.ts
  - `DRIP_JOINED`/`DRIP_LEFT` entries in apps/api/src/modules/inbox/journey/journey.service.ts
  - their wording in apps/web/src/components/inbox/journey-list.tsx, with cases in apps/web/tests/journey-list.test.ts
- [ ] T049 [P] [US4] Add the web pages apps/web/src/app/(dashboard)/drips/page.tsx (list and create) and apps/web/src/app/(dashboard)/drips/[id]/page.tsx:
  - steps with a template picker, the 001 variable mapping component, tracked links and waits
  - quiet hours, the leaving rules and stop tags
  - activate, pause and archive, with the problems listed
  - the enrol dialog with its preview, and the enrolments list with remove

**Checkpoint**: drips run by hand-enrolment with every leaving rule.

---

## Phase 7: User Story 5 - Enrol contacts automatically on starting events (Priority: P2)

**Goal**: drips enrol contacts by themselves on tags, opt-ins, new contacts from import or the API,
and clicks.

**Independent Test**: a drip that starts on the tag "new lead" and on a click in a campaign. A tagged
contact and a clicker join once; a contact already in the drip is not enrolled again.

### Tests for User Story 5 (REQUIRED) ⚠️

- [ ] T050 [P] [US5] Integration test apps/api/test/integration/growth-drip-events.int-spec.ts:
  - a tag added by a member, by bulk tagging, by the 003 flow tags step or by an import enrols once
  - an opt-in enrols
  - a contact new from an import or from the public API enrols; an existing contact does not
  - a click on the chosen campaign's link enrols once, and "any campaign" works
  - a draft or paused drip enrols nobody, and events are not replayed after activation
  - a stop tag added later makes the contact leave; the leave-on-click rule works
  - a rolled-back transaction writes no event
- [ ] T051 [P] [US5] Playwright e2e apps/web/e2e/growth-us5-starting-events.spec.ts: set the tag and click events on a drip, tag one contact and click as another, and both show in the drip's enrolments once

### Implementation for User Story 5

- [ ] T052 [US5] Implement apps/api/src/modules/growth/drips/drip-events.ts:
  - outbox writers `recordTagsAdded`, `recordOptIn`, `recordCreated` and `recordClick`, which write only when an active drip listens to the kind
  - consuming events in the tick before due steps: enrol by matching triggers with `ON CONFLICT DO NOTHING` and the rejoin rule, then delete the event
- [ ] T053 [US5] Call the outbox writers and the stop-tag leaving rule from:
  - apps/api/src/modules/contacts/contacts.service.ts (create, update and bulk tags)
  - apps/api/src/modules/flows/engine/session.service.ts (tags step)
  - apps/api/src/modules/imports/import.processor.ts (new contacts and tags)
  - apps/api/src/modules/public-api/public-api.service.ts (new contacts)
  - apps/api/src/modules/contacts/consent.service.ts (`OPTED_IN`)
  - apps/api/src/modules/growth/links/click-recorder.ts (clicks, and leave on click)
- [ ] T054 [P] [US5] Add the starting events editor (tag picker, opt-in, import, public API, a campaign picker or "any campaign" for clicks) to apps/web/src/app/(dashboard)/drips/[id]/page.tsx

**Checkpoint**: drips enrol automatically and exactly once.

---

## Phase 8: User Story 6 - Drip results (Priority: P3)

**Goal**: per-drip and per-step results with the contacts behind each number.

**Independent Test**: after US4, the results show step 1 sent 2, delivered 2 and replied 1, with 1
left (replied) and 1 still in the drip, matching the listed contacts.

### Tests for User Story 6 (REQUIRED) ⚠️

- [ ] T055 [P] [US6] Integration test apps/api/test/integration/growth-drip-results.int-spec.ts: per-step sent, delivered, read, clicked, replied, failed and skipped, and in, finished and left by reason, all equal the records; the contacts behind each metric; the CSV export
- [ ] T056 [P] [US6] Contract cases in apps/api/test/contract/growth.contract-spec.ts for `GET /drips/{id}/results`, `GET /drips/{id}/results/contacts` and `GET /drips/{id}/results/export`
- [ ] T057 [P] [US6] Playwright e2e apps/web/e2e/growth-us6-drip-results.spec.ts: open a drip's **Results**, select a count, and see its contacts and export

### Implementation for User Story 6

- [ ] T058 [US6] Implement apps/api/src/modules/growth/drips/drip-results.service.ts and its routes in drips.controller.ts (research R11 queries, masked phones by role, streamed CSV with `data.export`)
- [ ] T059 [P] [US6] Add the results tab (summary, per-step table, contacts per count, export) to apps/web/src/app/(dashboard)/drips/[id]/page.tsx

**Checkpoint**: every story works on its own.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T060 [P] Add the metrics `wbm_link_clicks_total{kind}`, `wbm_link_redirect_seconds`, `wbm_campaign_retry_messages_total{outcome}`, `wbm_drip_steps_total{result}`, `wbm_drip_enrolments_total{via}` and `wbm_drip_due_lag_seconds` in apps/api/src/common/metrics/metrics.service.ts with their instrumentation points, and the alert `WbmDripLagging` (due lag p95 over 5 minutes for 15 minutes) in ops/alerts.yml and apps/api/test/unit/alerts.spec.ts
- [ ] T061 [P] Extend retention and erasure, tests first:
  - in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts:
    - `link_clicks` older than 12 months
    - enrolments 12 months after they ended
    - stale `drip_events`
    - tracked links going with purged messages
  - in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts: contact links cleared on clicks, enrolments and tracked links
- [ ] T062 [P] Add tracked-link codes and destinations to the log redaction list in apps/api/src/common/logging/redaction.ts, with cases in apps/api/test/unit/logging-redaction.spec.ts
- [ ] T063 [P] Empty the 005 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [ ] T064 [P] Add contracts/growth-api.openapi.yaml to the contracts read by apps/api/test/integration/rbac.int-spec.ts (skip the public `/l/{code}` operation) and fix any permission mismatch
- [ ] T065 [P] Add the performance check tools/perf/drips-latency.ts (SC-005: 10,000 enrolled contacts with steps falling due; p95 from due to queued, with the api and the worker running) and the root script `perf:drips`
- [ ] T066 [P] Docs:
  - a campaign growth section in README.md (tracked links and `PUBLIC_LINK_BASE_URL`, retarget groups, retries and the held-back rule, drips). Say that when the base address has no `/l` path, the reverse proxy must send `/{code}` to the api's `/l/{code}`
  - update specs/005-campaign-growth/quickstart.md if steps changed
  - mark items 5.5, 5.7, 5.8 and 5.12 in docs/research/aisensy/feature-inventory-2026-11-19.md
- [ ] T067 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/005-campaign-growth/checklists/release.md, with the pre-release items:
  - the public HTTPS link address on the company's own domain
  - Meta approval of a template with a tracked link button
  - the reply window and drip limits confirmed
  - the SC-005 run on staging

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories.
- **US1 (P1)** is the MVP: tracked links and clicks.
- **US2 (P1)** uses US1's clicks for the Clicked groups; the other new groups (Replied, Held back) need only Foundational.
- **US3 (P2)** needs only Foundational (independent of US1 and US2).
- **US4 (P2)** needs Foundational; it reuses US1's tracked links for drip steps when present.
- **US5 (P2)** needs US4. Its click starting event needs US1.
- **US6 (P3)** needs US4.
- **Polish** comes after the stories it touches.

| Story | Priority | Depends on |
|---|---|---|
| US1 | P1 | Foundational |
| US2 | P1 | US1 (Clicked groups) |
| US3 | P2 | Foundational |
| US4 | P2 | Foundational (US1 for tracked links in steps) |
| US5 | P2 | US4 (US1 for click events) |
| US6 | P3 | US4 |

### Within each story

Tests first (they must fail), then services and processors, then hooks into existing modules, then
the web UI.

## Parallel Example: User Story 1

```text
Run together (different files):
  T015 link-redirect.spec    T016 growth-clicks       T017 growth.contract-spec   T018 e2e growth-us1
Then: T019 tracked-links service → T020 codes at launch → T021 redirect and recorder
      → T022 clicks service → T023 timeline note; T024/T025/T026 web (parallel)
```

## Implementation Strategy

1. **MVP**: Setup, Foundational and US1 → tracked links and click results (demo-able with mock-meta).
2. **P1 release**: add US2 → follow up clickers and repliers in one step.
3. **P2**: US3 retries (independent), then US4 drips, then US5 starting events.
4. **P3**: US6 drip results; then Polish and the release checklist.
5. Commit after each story's backend and web parts. CI (draft PR) runs integration, contract and e2e
   tests because the dev machine cannot run Docker.
