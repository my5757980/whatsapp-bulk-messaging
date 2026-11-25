---
description: "Task list for Click-to-WhatsApp ads and the ads manager (feature 007)"
---

# Tasks: Click-to-WhatsApp Ads and the Ads Manager

**Input**: Design documents from `/specs/007-ads-manager/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ads-api.openapi.yaml,
contracts/meta-ads-graph.md, quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- Meta is mocked with nock in unit and integration tests, and with mock-meta (`tools/mock-meta/src/ads.ts`)
  in e2e. No real ad account, page, ad, audience or lead is used.
- Graph fields marked *(verify)* in research.md are checked against Meta's reference when the
  client method is written (T013) and pinned in contracts/meta-ads-graph.md.

**Organization**: by user story (spec.md US1–US8) after Setup and Foundational, in the plan's
delivery order. Pushes are batched: US1–US3 (the MVP), US4–US6, then US7–US8 with Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US8); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: configuration, the queue name, contract lint and the mock-meta ads skeleton.

- [X] T001 Add `ADS_FREE_WINDOW_HOURS` (integer 1–168, default 72) to the env schema in apps/api/src/common/config/config.ts and document it in .env.example (research R11)
- [X] T002 [P] Add `ADS: 'ads'` to `QUEUES` in apps/api/src/common/queue/queue.constants.ts, with a comment (feature 007, plan Technical Context)
- [X] T003 [P] Add specs/007-ads-manager/contracts/ads-api.openapi.yaml to the `lint:contracts` script in package.json, and `'ads-api.openapi.yaml'` (feature folder `007-ads-manager`) to `ContractFile` and `FEATURE_OF` in apps/api/test/contract/openapi-validator.ts
- [X] T004 [P] Add tools/mock-meta/src/ads.ts, mounted from tools/mock-meta/src/server.ts before the `mock-token` check, answering for the ads tokens of contracts/meta-ads-graph.md: `debug_token`, `/me/adaccounts`, `/me/accounts` (with page tokens), the ad account `tos_accepted` and the page fields (`leadgen_tos_accepted`, linked WhatsApp numbers). Later stories add their routes to this file

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, the shared pure rules, the Graph client, module wiring, audit actions,
redaction, web types and the referral option of the inbound CLI.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [X] T005 Write the Prisma models and the migration apps/api/prisma/migrations/20261202000000_ads/migration.sql per data-model.md:
  - every table of §1 and the `messages.ad_lead_id` column of §2
  - the new enums `AdsConnectionStatus`, `AdGoal`, `AdCampaignStatus`, `AdSpecialCategory`, `AdMediaKind`, `AdVersionStatus`, `AdAudienceKind`, `AdAudienceStatus`, `AdLeadStatus`
  - the enum values `MessageOrigin.ADS`, `ConsentSource.LEAD_FORM`, `JourneyEventType.AD_CHAT_STARTED` and `LEAD_RECEIVED`, and the four `NotificationType` values
  - in a hand-written SQL tail: the one-row index on `ads_connections`, `ad_result_days` unique with `NULLS NOT DISTINCT`, the daily unique index on `ad_chat_starts`, partial unique names on `ad_campaigns` and `ad_audiences` where not deleted, and check constraints (version position 1–5, lookalike ratio 0.01–0.10, budget > 0)

  Update apps/api/prisma/schema.prisma and run `prisma generate`.
- [X] T006 [P] Unit tests packages/shared/src/ads/targeting.test.ts (R5): at least one location; ages 18–65; genders; up to 25 interests and 10 audiences in and out; automatic or chosen placements; special categories lock ages, gender and interests to Meta's limits; WhatsApp Status only for chat ads with one image or video, with Instagram stories added
- [X] T007 [P] Unit tests packages/shared/src/ads/budgets.test.ts (R5, R7): a budget below the minimum is refused with the minimum; the cap check (spend so far + the active daily budgets with the new one × the days left in the month in the account's time zone); the remaining amount; month boundaries and time zones; no cap
- [X] T008 [P] Unit tests packages/shared/src/ads/statuses.test.ts (R6): Meta's `effective_status` values (ACTIVE, PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, WITH_ISSUES, PENDING_BILLING_INFO, IN_PROCESS, ARCHIVED, DELETED) mapped to campaign and version states, and ENDED after the end date
- [X] T009 [P] Unit tests packages/shared/src/ads/referral.test.ts (R11): parsing a referral (ad source, headline, body, media URL, `ctwa_clid` absent for Status, a referral with only `source_url`, a post source ignored); the free window (first business reply within 24 hours → until reply + the configured hours; a later reply → none)
- [X] T010 [P] Unit tests packages/shared/src/ads/hashing.test.ts and limits.test.ts (R4, R8): phone normalization for `PHONE_SHA256` (digits only, no plus, no leading zeros, country code kept); text hard limits and recommended lengths; the buttons allowed per goal; image and video limits by kind
- [X] T011 [P] Unit tests packages/shared/src/ads/checks.test.ts (R2): the check rules from Graph answers, each with a plain fix: missing permissions named; account statuses with Meta's disable reasons; no payment method; a page without the ADVERTISE task; linked numbers unreadable → WARNING; missing terms → WARNING; ready means no FAILED
- [X] T012 Implement packages/shared/src/ads/targeting.ts, budgets.ts, statuses.ts, referral.ts, hashing.ts, checks.ts and limits.ts (pure) and export them from packages/shared/src/index.ts
- [X] T013 Implement `MetaAdsClient` in apps/api/src/modules/ads/meta-ads.client.ts with every call of contracts/meta-ads-graph.md (connection, search, estimate, minimum budgets, image and video upload with readiness, welcome message sequences, creatives, campaigns, ad sets, ads, reads, status and budget changes, delete, insights, audiences and their users, lookalikes, lead forms, page subscription, leads), the 001 error parsing, and a slowdown when `x-business-use-case-usage` passes 75%. Check each *(verify)* field against Meta's reference and update the contract file. Unit tests in apps/api/test/unit/meta-ads-client.spec.ts (nock) for each group and for errors
- [X] T014 [P] Add the 007 audit actions of data-model.md §5 to apps/api/src/modules/audit/audit-actions.ts, and list them in `PENDING` in apps/api/test/unit/audit-coverage.spec.ts until their story records them
- [X] T015 [P] Add `input_token`, `page_token` and `page_token_enc` to the redaction list in apps/api/src/common/logging/redaction.ts, with cases in apps/api/test/unit/logging-redaction.spec.ts
- [X] T016 Create apps/api/src/modules/ads/ads.module.ts and wire it into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts: `AdsDomainModule` (global: `MetaAdsClient`, and later `AdChatMatcher` and the cap), `AdsApiModule` (controllers), and the worker processors. Keep apps/api/test/unit/app-module.spec.ts green
- [X] T017 [P] Add apps/web/src/lib/ads.ts: types from contracts/ads-api.openapi.yaml, query keys, and labels for goals, states, checks, buttons and special categories
- [X] T018 [P] Add `--referral-ad <ad-id>` (with `--referral-headline` and `--referral-image`) to tools/mock-meta/src/inbound-cli.ts, putting a `referral` object on the customer message (contracts/meta-ads-graph.md)

**Checkpoint**: the foundation is ready; stories can begin.

---

## Phase 3: User Story 1 - Connect the company's ad account and page (Priority: P1) 🎯 MVP

**Goal**: admins connect one ad account and page with checks and fixes; the token is stored
encrypted; a monthly cap can be set.

**Independent Test**: quickstart US1 row: a token without `leads_retrieval` is named with its fix;
the good token lists the account and page; the saved connection shows AED and Asia/Dubai.

### Tests for User Story 1 (write first, must fail)

- [X] T019 [P] [US1] Integration test apps/api/test/integration/ads-connection.int-spec.ts (nock Graph):
  - a token session lists ad accounts and pages (`debug_token` with the app token when `META_APP_ID` is set)
  - checks: a missing permission named, a disabled account with its reason, no payment method, a page without linked numbers (WARNING), missing terms (WARNING)
  - save: one row, the token and page token encrypted and never returned; run checks again with the stored token
  - a failed token check sets ERROR and notifies admins (`ADS_CONNECTION_ERROR`)
  - the cap set and cleared; disconnect; an expired session gives 404
  - managers get 403; audit entries without tokens
- [X] T020 [P] [US1] Contract cases for `/ads/connection*` in apps/api/test/contract/ads.contract-spec.ts
- [X] T021 [P] [US1] Playwright e2e apps/web/e2e/ads-us1-connection.spec.ts: `mock-ads-token-no-leads` names the missing permission; `mock-ads-token-ok-full` lists `act_MOCKADS` and `MOCKPAGE`; save; the connection card shows the currency, the time zone and Run checks

### Implementation for User Story 1

- [X] T022 [US1] Implement apps/api/src/modules/ads/connection/ads-connection.service.ts and ads-connection.controller.ts: the Redis session (encrypted token, 30-minute TTL), checks with the shared rules, save (one row with the page token), get (with checks, linked numbers and month spend), run checks, the cap, disconnect, the ERROR state with admin alerts, audit entries
- [X] T023 [P] [US1] Add apps/web/src/app/(dashboard)/ads/connect/page.tsx (token → account and page → checks with fixes → save; then the connection card with Run checks, Replace token, the cap and Disconnect) and an **Ads** item in the dashboard navigation

**Checkpoint**: US1 runs alone.

---

## Phase 4: User Story 2 - Launch a Click-to-WhatsApp ad (Priority: P1) 🎯 MVP

**Goal**: managers build a campaign with up to five versions, submit it, and follow Meta's review.

**Independent Test**: quickstart US2 row: a chat ad goes from In review to Active; a `reject-me`
version shows Rejected with the reason and can be resubmitted; a low budget is refused.

### Tests for User Story 2 (write first, must fail)

- [X] T024 [P] [US2] Integration test apps/api/test/integration/ads-launch.int-spec.ts (nock Graph):
  - drafts: create, change, delete; validation per goal (number and message for chats); the 1–5 versions
  - targeting search, the estimate and the minimum budget; a budget below it gives 422
  - submit for chats: image upload, the welcome message sequence, creatives, the campaign (`OUTCOME_ENGAGEMENT`, special categories), the ad set (`destination_type: WHATSAPP`, `optimization_goal: CONVERSATIONS`, `promoted_object` with page and number, budget, dates, targeting) and the ads → IN_REVIEW
  - a failure at the ad set deletes what was made and sets ERROR with Meta's message; a retry starts clean
  - the status job: PENDING_REVIEW → ACTIVE; a DISAPPROVED version → REJECTED with the feedback; an edited rejected version is resubmitted on the same ad; a campaign paused in Meta's tools shows PAUSED
  - a connection in ERROR gives 409 on submit; agents get 403; submitting needs `campaigns.launch`; audit entries
- [X] T025 [P] [US2] Contract cases for `/ads/campaigns`, `/ads/campaigns/{id}`, `/submit`, `/versions/{versionId}` and `/ads/targeting/*` in apps/api/test/contract/ads.contract-spec.ts
- [X] T026 [P] [US2] Add the building routes to tools/mock-meta/src/ads.ts: search, `delivery_estimate`, `minimum_budgets`, `adimages`, `advideos`, `welcome_message_sequences`, `adcreatives`, campaigns, ad sets, ads, reads, status updates and delete; new ads in review for 3 seconds, then ACTIVE; text with `reject-me` → DISAPPROVED with a reason
- [X] T027 [P] [US2] Playwright e2e apps/web/e2e/ads-us2-launch.spec.ts: build a chat ad (mock number, pre-filled message, UAE, ages 25–45, automatic placements, AED 50, one image), submit, see In review then Active; a `reject-me` version shows the reason; fix and resubmit

### Implementation for User Story 2

- [X] T028 [US2] Implement apps/api/src/modules/ads/campaigns/ad-campaigns.service.ts and ad-campaigns.controller.ts (drafts with the shared rules, get with versions and states) and apps/api/src/modules/ads/campaigns/ad-targeting.controller.ts (locations, interests, estimate with the minimum budget)
- [X] T029 [US2] Implement apps/api/src/modules/ads/campaigns/ad-launcher.ts: the SUBMITTING lock; media from the 001 library to Meta (waiting for video processing); the welcome message sequence for chats; creatives; campaign; ad set; ads; rollback on failure; resubmitting edited rejected versions; audit entries
- [X] T030 [US2] Implement apps/api/src/modules/ads/sync/ads-status.processor.ts: a job scheduler every 5 minutes on the `ads` queue for campaigns in review, active or paused; states from the shared mapping; version feedback; `AD_REJECTED` and `AD_NOT_DELIVERING` notifications; Meta-side changes read, never undone
- [X] T031 [P] [US2] Add the web pages: apps/web/src/app/(dashboard)/ads/page.tsx (campaigns list), apps/web/src/app/(dashboard)/ads/new/page.tsx (the guided builder: goal, chat number and message, audience with search and estimate, placements, budget and dates with the minimum, versions with media from the library and text counters, review and submit; also edits drafts) and apps/web/src/app/(dashboard)/ads/[id]/page.tsx (state, versions with review feedback, edit and resubmit)

**Checkpoint**: US2 runs alone (with US1's connection).

---

## Phase 5: User Story 3 - Handle chats that come from ads (Priority: P1) 🎯 MVP

**Goal**: chats from ads show the ad in live chat and the journey, get the campaign's tag and flow,
and show the free ad window.

**Independent Test**: quickstart US3 row: a message with the ad's referral shows the ad, adds
`from-ad`, starts the flow; an unknown ad goes under Other ads.

### Tests for User Story 3 (write first, must fail)

- [X] T032 [P] [US3] Integration test apps/api/test/integration/ads-chats.int-spec.ts:
  - an inbound message with a referral: the chat item keeps it, an `ad_chat_starts` row links the version and campaign by `meta_ad_id` (an unknown ad → Other ads), the journey gets `AD_CHAT_STARTED`, the tag is added, the flow starts before keyword flows
  - never over a running flow or a member's chat; once per contact per ad per day; new contacts from the 001 handler's flag
  - the free window: a first business reply within 24 hours gives "until reply + 72 hours"; a later reply gives none
  - the outbound event `ad.chat_started`; `GET /ads/campaigns/{id}/chats` with masked phones for agents; `GET /ads/other-chats`
- [X] T033 [P] [US3] Contract cases for `/ads/campaigns/{id}/chats` and `/ads/other-chats` in apps/api/test/contract/ads.contract-spec.ts, and `ad.chat_started` and `ad.lead_received` in the event type enum of specs/006-integrations-platform/contracts/integrations-api.openapi.yaml
- [X] T034 [P] [US3] Playwright e2e apps/web/e2e/ads-us3-ad-chats.spec.ts: set the flow "Welcome" and the tag on an active campaign; `mock:inbound --referral-ad` shows the ad card in live chat, the flow reply and the tag; an unknown ad id is listed under Other ads

### Implementation for User Story 3

- [X] T035 [US3] Implement `AdChatMatcher` in apps/api/src/modules/ads/chats/ad-chat-matcher.ts and call it from apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts before the 006 chat link matcher (the message parser keeps `referral` in the item payload): the chat start row, the tag, the journey entry, the flow start with the 006 rules, and the free window computed at read time from the first business message after the start
- [X] T036 [US3] Add `ad.chat_started` and `ad.lead_received` to the event catalog in packages/shared/src/integrations/events.ts (with labels and payload builders) and `adChatStarted` to apps/api/src/modules/integrations/webhooks/platform-events.ts
- [X] T037 [P] [US3] Add the web parts: an ad card in live chat (apps/web/src/components/inbox/ad-referral-card.tsx, in the chat header and on the first item) with the free window badge; journey labels for `AD_CHAT_STARTED`; the Chats tab on the campaign page; an Other ads section on the list page; and the flow builder's **Ads** trigger card (apps/web/src/components/flows/ads-trigger-card.tsx) that sets `flowId` on chosen campaigns

**Checkpoint**: the MVP (US1–US3) is complete; push and check CI.

---

## Phase 6: User Story 4 - See ad results (Priority: P2)

**Goal**: Meta's numbers per day and version with the platform's own counts and cost per chat.

**Independent Test**: quickstart US4 row: Meta's numbers per day, chats started 1, new contacts 1,
cost per chat = spend ÷ chats; the export lists days and versions.

### Tests for User Story 4 (write first, must fail)

- [X] T038 [P] [US4] Integration test apps/api/test/integration/ads-results.int-spec.ts: the hourly insights job stores rows per version per day and the campaign's reach rows; conversations and leads from `actions`; the daily 28-day refresh updates earlier days; the results API (totals, days, versions, our chats, new contacts, replied, leads, visits, cost per chat and lead) in the account's time zone and currency; the CSV export with masking, `data.export` and an audit entry; the list's spend and chats
- [X] T039 [P] [US4] Contract cases for `/results` and `/results/export` and the list summary in apps/api/test/contract/ads.contract-spec.ts
- [X] T040 [P] [US4] Make insights grow in tools/mock-meta/src/ads.ts while an ad is active (contracts/meta-ads-graph.md)
- [X] T041 [P] [US4] Playwright e2e apps/web/e2e/ads-us4-results.spec.ts: after an ad chat, the results show Meta's numbers, chats started 1 and the cost per chat; the export downloads

### Implementation for User Story 4

- [X] T042 [US4] Implement apps/api/src/modules/ads/sync/ads-insights.processor.ts (hourly for active campaigns, daily for the last 28 days of campaigns that ran) and apps/api/src/modules/ads/results/ad-results.service.ts with the `/results` and `/results/export` routes and the list summary fields
- [X] T043 [P] [US4] Add the Results tab to apps/web/src/app/(dashboard)/ads/[id]/page.tsx (tiles, per-day and per-version tables, last updated, export) and spend and chats to the list

**Checkpoint**: US4 runs alone.

---

## Phase 7: User Story 5 - Manage running ads and spending (Priority: P2)

**Goal**: pause, resume, end, budget and date changes, duplicates, and a monthly spending cap.

**Independent Test**: quickstart US5 row: pause and resume follow at Meta; a budget change over the
cap is refused with the remaining amount; reaching the cap pauses the platform's campaigns.

### Tests for User Story 5 (write first, must fail)

- [X] T044 [P] [US5] Integration test apps/api/test/integration/ads-manage.int-spec.ts: pause, resume and end at Meta; pausing and resuming one version; budget and end date changes on the ad set; duplicate as a draft; the cap refuses submit, resume and budget increases (409 `SPEND_CAP` with the remaining amount); reaching the cap pauses every platform campaign once a month and alerts (`ADS_SPEND_CAP_REACHED`); payment problems from the status job alert admins and the manager; audit entries
- [X] T045 [P] [US5] Contract cases for `/pause`, `/resume`, `/end`, `/duplicate`, version pause and resume, and `/ads/connection/spend-cap` in apps/api/test/contract/ads.contract-spec.ts
- [X] T046 [P] [US5] Playwright e2e apps/web/e2e/ads-us5-manage.spec.ts: pause and resume; raise the budget; set a low cap and see the refusal; duplicate

### Implementation for User Story 5

- [X] T047 [US5] Add the actions to apps/api/src/modules/ads/campaigns/ad-campaigns.service.ts and implement the cap in apps/api/src/modules/ads/sync/ads-cap.ts, used by submit, resume and budget changes, and by the insights job (pause once per month with `capped_month`)
- [X] T048 [P] [US5] Add the manage controls to apps/web/src/app/(dashboard)/ads/[id]/page.tsx (pause, resume, end, duplicate, budget and end date, version pause) and the month's spend against the cap on the connection page

**Checkpoint**: US5 runs alone.

---

## Phase 8: User Story 6 - Target ads at the company's own contacts (Priority: P2)

**Goal**: saved audiences from tags, filters and campaign groups, kept up to date, with lookalikes.

**Independent Test**: quickstart US6 row: 145 hashed numbers sent from a tag of 150 with 5 opted out;
10 removed after an update; a lookalike can be chosen; 50 contacts are too small.

### Tests for User Story 6 (write first, must fail)

- [X] T049 [P] [US6] Integration test apps/api/test/integration/ads-audiences.int-spec.ts: audiences from a tag, a filter and a campaign group (normalized `PHONE_SHA256` hashes, opted-out and blocked contacts left out, batches of 10,000); the members table; the daily diff adds and removes; a deleted contact is removed at the next sync; under 100 people → TOO_SMALL and not offered; lookalikes with country and ratio; delete refused while a running campaign uses it; missing terms → 409; sync now → 202
- [X] T050 [P] [US6] Contract cases for `/ads/audiences*` in apps/api/test/contract/ads.contract-spec.ts
- [X] T051 [P] [US6] Add the audience routes to tools/mock-meta/src/ads.ts: custom audiences, users add and remove (counting hashes), lookalikes, size, delete
- [X] T052 [P] [US6] Playwright e2e apps/web/e2e/ads-us6-audiences.spec.ts: make an audience from a tag, see its size, make a lookalike, choose it in the builder

### Implementation for User Story 6

- [X] T053 [US6] Implement apps/api/src/modules/ads/audiences/ad-audiences.service.ts, ad-audiences.controller.ts and ads-audiences.processor.ts (daily diffs, sync now, lookalikes, deletes at Meta)
- [X] T054 [P] [US6] Add apps/web/src/app/(dashboard)/ads/audiences/page.tsx and the include and exclude audience picker in the builder (READY audiences only)

**Checkpoint**: US6 runs alone.

---

## Phase 9: User Story 7 - Collect leads with lead-form ads (Priority: P3)

**Goal**: lead forms whose leads become tagged contacts, opted in only with consent, with a welcome
template.

**Independent Test**: quickstart US7 row: two leads become `spring` contacts; only the consenting one
is opted in and gets the welcome template once; a repeated lead is recorded once.

### Tests for User Story 7 (write first, must fail)

- [X] T055 [P] [US7] Integration test apps/api/test/integration/ads-leads.int-spec.ts:
  - creating a form at Meta with the page token (a consent question without "WhatsApp" gives 422); the page subscribed to `leadgen`
  - a signed `leadgen` page webhook stored by the 001 receiver and processed: the lead fetched, the contact made or updated, the tag added, opted in with `LEAD_FORM` only when the checkbox was ticked, the welcome template sent once through the 001 rules (never to an opted-out contact)
  - a repeated webhook → one lead; the catch-up job finds a missed lead; no phone and invalid phone statuses
  - the leads list with masked phones; the export audited; the outbound event `ad.lead_received`
  - a lead ad (goal LEADS) uses the form (`OUTCOME_LEADS`, `destination_type: ON_AD`)
- [X] T056 [P] [US7] Contract cases for `/ads/lead-forms*` in apps/api/test/contract/ads.contract-spec.ts
- [X] T057 [P] [US7] Add the lead routes to tools/mock-meta/src/ads.ts: `leadgen_forms`, `subscribed_apps`, a lead, a form's leads, and `POST /mock/ads/lead` sending a signed page webhook
- [X] T058 [P] [US7] Playwright e2e apps/web/e2e/ads-us7-leads.spec.ts: create "Spring offer" with tag and welcome template; send two mock leads; the contacts, consent and the one welcome message

### Implementation for User Story 7

- [X] T059 [US7] Implement apps/api/src/modules/ads/leads/ad-lead-forms.service.ts and ad-lead-forms.controller.ts; extend apps/api/src/modules/webhooks/webhook-router.ts to dispatch `page` objects by field, with apps/api/src/modules/ads/leads/leadgen.handler.ts for `leadgen`; and apps/api/src/modules/ads/leads/ad-leads.processor.ts (one lead, and the catch-up every 15 minutes)
- [X] T060 [P] [US7] Add apps/web/src/app/(dashboard)/ads/lead-forms/page.tsx and [id]/page.tsx (create with questions, consent text, privacy link, tag and welcome template; leads with export) and the LEADS goal in the builder

**Checkpoint**: US7 runs alone.

---

## Phase 10: User Story 8 - Website ads and AI-drafted texts (Priority: P3)

**Goal**: website ads with a counted link, and AI drafts of the ad texts.

**Independent Test**: quickstart US8 row: the AI fills the texts within limits; the counted link shows
1 visit after two opens (one a preview).

### Tests for User Story 8 (write first, must fail)

- [X] T061 [P] [US8] Integration test apps/api/test/integration/ads-website-ai.int-spec.ts: a website ad (`OUTCOME_TRAFFIC`, `destination_type: WEBSITE`) with its link code; `/l/a/:code` answers 302 with the utm values, previews and robots are not counted, the rate limit applies, an ended campaign shows the 404 page; visits in the results; AI texts within limits through the 004 service (nock), counted against the AI limit (429 when reached), never submitted
- [X] T062 [P] [US8] Contract cases for `/ads/ai-text` and `/l/a/{code}` in apps/api/test/contract/ads.contract-spec.ts
- [X] T063 [P] [US8] Playwright e2e apps/web/e2e/ads-us8-website-ai.spec.ts: Write with AI fills the texts (mock-meta's fake model); a website ad's link counts one visit after a preview and a real open

### Implementation for User Story 8

- [X] T064 [US8] Implement apps/api/src/modules/ads/links/ad-link-redirect.controller.ts at `GET /l/a/:code` (exclude `l/a/:code` from the api prefix in apps/api/src/app.setup.ts; reuse the 005 preview, robot and rate rules; count opens in `ad_link_opens`)
- [X] T065 [US8] Implement apps/api/src/modules/ads/campaigns/ad-ai-text.service.ts and the `/ads/ai-text` route with the 004 AI service, its monthly limit and content rules
- [X] T066 [P] [US8] Add the WEBSITE goal (URL and the counted link) and the **Write with AI** dialog to apps/web/src/app/(dashboard)/ads/new/page.tsx

**Checkpoint**: all stories are done.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T067 [P] Add the R13 metrics to apps/api/src/common/metrics/metrics.service.ts with their instrumentation points (`wbm_ads_sync_total{job,result}`, `wbm_ad_chat_starts_total{matched}`, `wbm_ad_leads_total{result}`, `wbm_ads_spend_cap_pauses_total`), and the alert `WbmAdsSyncFailing` to ops/alerts.yml with a case in apps/api/test/unit/alerts.spec.ts
- [X] T068 [P] Extend retention and erasure, tests first: in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts (`ad_result_days` after 25 months; `ad_leads`, `ad_chat_starts` and `ad_link_opens` after 12 months), and in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts (leads cleared, chat starts without the contact, audience removal at the next sync)
- [X] T069 [P] Empty the 007 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [X] T070 [P] Add contracts/ads-api.openapi.yaml to apps/api/test/integration/rbac.int-spec.ts, skipping `/l/a/{code}`
- [X] T071 [P] Docs: an Ads section in README.md (the Meta app, permissions and token, the connection, the builder, ad chats and the free window, results and the cap, audiences, lead forms, website links); update specs/007-ads-manager/quickstart.md if steps changed; mark items 9.7 (texts) and 10.1–10.4 in docs/research/aisensy/feature-inventory-2026-11-19.md and update its roadmap
- [X] T072 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/007-ads-manager/checklists/release.md, with the pre-release items: the Meta app permissions and any app review (`leads_retrieval`), the system user token, the page subscription to leads, the ad account payment method, the page linked to the numbers, the terms for audiences and leads, and a small real test campaign with a real chat and a real lead

---

## Dependencies & Execution Order

- **Setup (T001–T004)** → **Foundational (T005–T018)** → stories.
- **US1** first (every story needs the connection). **US2** needs US1. **US3** needs US2 (campaigns
  to match). **US4** and **US5** need US2; **US6** needs US1 (and the builder of US2 for the picker).
  **US7** needs US1 and the builder; **US8** needs the builder.
- Within a story: tests → mock-meta routes → services → processors → web.
- **Polish** after the stories it touches.

## Parallel examples

- Foundational: T006–T011 (shared tests), T014, T015, T017 and T018 at once; then T012 and T013.
- US2: T024, T025, T026 and T027 at once; then T028 → T029 → T030; T031 beside T029–T030.
- US6: T049–T052 at once; then T053 with T054 beside it.

## Implementation strategy

1. **MVP**: Setup, Foundational, US1–US3; push once and fix CI.
2. **Batch 2**: US4–US6; push once.
3. **Batch 3**: US7, US8 and Polish; push, then the release checklist.
4. Each story is independently testable through its quickstart row; tasks are marked done only after
   CI confirms them.
