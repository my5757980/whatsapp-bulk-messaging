---
description: "Task list for contacts, settings and security (feature 010)"
---

# Tasks: Contacts, Settings and Security

**Input**: Design documents from `/specs/010-contacts-settings-security/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/contacts-settings-api.openapi.yaml, contracts/login-2fa.md,
contracts/meta-business-profile.md, quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- **No real accounts in tests.** Meta is mocked with nock in integration tests (`FakeBusinessGraph`,
  T076) and with mock-meta in e2e (`tools/mock-meta/src/business-profile.ts`). Authenticator codes
  are computed by the tests from the shown secret.
- **Clock.** Date automation and 2FA tests use the existing fake clock helper (`useFakeNow`).

**Organization**: by user story (spec.md US1–US8) after Setup and Foundational, in the plan's
delivery order. Pushes are batched: US1–US2 (the MVP), US3–US6, then US7–US8 with Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US8); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: contract lint, mock-meta routes, a code helper for tests and the perf seed.

- [ ] T001 [P] Register the 010 contract:
  - add specs/010-contacts-settings-security/contracts/contacts-settings-api.openapi.yaml to the `lint:contracts` script in package.json
  - add `'contacts-settings-api.openapi.yaml'` (feature folder `010-contacts-settings-security`) to `ContractFile` and `FEATURE_OF` in apps/api/test/contract/openapi-validator.ts
- [ ] T002 [P] Add tools/mock-meta/src/business-profile.ts, mounted from tools/mock-meta/src/server.ts (contracts/meta-business-profile.md):
  - `GET` and `POST /{phone-number-id}/whatsapp_business_profile` with an in-memory profile per number and Meta-style errors beyond the limits
  - `GET /{phone-number-id}?fields=verified_name,name_status,new_name_status,quality_rating,whatsapp_business_manager_messaging_limit`
  - `POST /mock/name-status { phoneNumberId, nameStatus, newNameStatus }`
- [ ] T003 [P] Add a TOTP helper for tests and the quickstart:
  - apps/web/e2e/totp.ts (RFC 6238 with `node:crypto`, used by e2e)
  - `npm run tool:totp -w @wbm/api -- --secret <base32>` (apps/api/scripts/totp.ts) that prints the current code
- [ ] T004 [P] Add tools/perf/segments-200k.ts and the `perf:segments` script in apps/api/package.json:
  - seeds 200,000 contacts with tags, attributes and campaign messages
  - times the count of a 10-rule segment, printing `EXPLAIN ANALYZE` (SC-001)

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, shared rules and content, the lead source helper, the `bulk` queue, audit
actions, web types and earlier contracts.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [ ] T005 Write the migration apps/api/prisma/migrations/20261217000000_contacts_settings_security/migration.sql per data-model.md, then update apps/api/prisma/schema.prisma and run `prisma generate`. The migration holds:
  - **new enums:** `LeadSourceKind`, `BulkActionKind`, `BulkActionStatus`, `AutoTagEvent`, `DateAutomationTiming`, `DateAutomationStatus` and `OccurrenceStatus`
  - **new enum values:** `AudienceType.SEGMENT`, `MessageOrigin.DATE_AUTOMATION` and `NotificationType.DATE_AUTOMATION_PAUSED`
  - **new columns:** `contacts.lead_source_kind`, `campaigns.segment_id`, and `settings.opt_out_reply`, `opt_in_reply`, `require_2fa`
  - **new tables:** `segments`, `bulk_actions`, `auto_tag_rules`, `global_attributes`, `date_automations`, `date_automation_occurrences`, `user_two_factor`, `user_recovery_codes`, `number_business_profiles` and `oba_checklist`
  - **checks:** `campaigns` segment_id with SEGMENT, `auto_tag_rules` lead source with CONTACT_CREATED, `offset_days` between −30 and 30, `oba_checklist.id = 1`
  - **indexes:** `contacts (lead_source_kind)`, `messages (contact_id, created_at)` and `date_automation_occurrences (automation_id, due_date, status)`
  - **a hand-written SQL tail:** the legacy `lead_source` text → kind mapping of research R5
  - add the new `NotificationType` value to packages/shared/src/enums.ts as well
- [ ] T006 [P] Write packages/shared/src/contacts/segment-rules.ts and its test segment-rules.test.ts (research R1):
  - `SegmentRulesSchema` with every rule kind, 1–5 groups and 1–30 rules in total
  - day windows: 7, 30 or 90 for behaviour; 1–365 for `added` and `last_inbound`
  - tests: valid examples per kind, every limit, the "did not" forms
- [ ] T007 [P] Write packages/shared/src/contacts/lead-source.ts and lead-source.test.ts:
  - `LEAD_SOURCE_LABELS` for the web app
  - `legacyLeadSource(text)` mapping the existing values (R5), tested with 'API', 'Campaign upload', 'STORE', 'Lead form', 'Organic', 'Import', other text (CUSTOM) and empty (UNKNOWN)
- [ ] T008 [P] Write packages/shared/src/contacts/date-automation.ts and date-automation.test.ts: `dueOn(date, timing, offsetDays, today)`, tested for:
  - yearly on the day and month
  - offsets before and after, across month and year ends
  - 29 February on 28 February in other years
  - once on the exact date, past dates never due
- [ ] T009 [P] Write packages/shared/src/settings/business-profile.ts and its test: `BUSINESS_PROFILE_LIMITS`, `BUSINESS_VERTICALS`, `PROFILE_PICTURE_RULES` and `checkBusinessProfile(input)` returning field issues (contracts/meta-business-profile.md §2–§3)
- [ ] T010 [P] Write packages/shared/src/settings/oba-checklist.ts and number-guides.ts in our own words (research R12), and a test: every step has a title, body, at least one link to a Meta page and a `checkedAt` date
- [ ] T011 Export the new shared files from packages/shared/src/index.ts, then run `npm run build -w @wbm/shared`
- [ ] T012 Add the 010 audit actions of research R13 to apps/api/src/modules/audit/audit-actions.ts, and list them in the `PENDING` set of apps/api/test/unit/audit-coverage.spec.ts (each story removes its own)
- [ ] T013 Add apps/api/src/modules/contacts/lead-source.ts:
  - `leadSourceFor(kind, label?)`, which returns the create-branch fields
  - `upgradeFirstMessageSource(tx, contactId, kind, label)`, which changes an `ORGANIC` source only while the contact was created by the current message
- [ ] T014 Add the `bulk` queue:
  - `QUEUES.BULK` in apps/api/src/common/queue/queue.constants.ts
  - its registration in apps/api/src/common/queue/queue.module.ts
  - an empty `BulkProcessor` in apps/api/src/modules/contacts/bulk.processor.ts (concurrency 1), registered in apps/api/src/worker-features.module.ts
- [ ] T015 Add the new modules and providers:
  - automations, global attributes, keyword replies, business profile and the checklist, wired into apps/api/src/domain.module.ts and the api and worker modules
  - exports where other modules use them
- [ ] T016 [P] Add the web types and query keys to apps/web/src/lib/types.ts and apps/web/src/lib/query.ts: Segment, SegmentRules, BulkAction, LeadSourceKind, AutoTagRule, GlobalAttribute, KeywordReplies, DateAutomation, AutomationDay, MyTwoFactor, SecuritySettings, BusinessProfile and ObaChecklist
- [ ] T017 [P] Update the earlier contracts (contacts-settings-api.openapi.yaml header):
  - **001 dashboard-api.openapi.yaml:**
    - `audienceType` gains `SEGMENT`, with `segmentId`
    - the contact list takes `segmentId` and `leadSource`, and `Contact` returns `leadSource` and `leadSourceLabel`
    - `VariableSource` gains `global`
    - `POST /auth/login` may answer `{ next: CODE | SETUP }`
  - **005 growth-api.openapi.yaml:** `EnrolInput` accepts `segmentId`, answered with `202` and a `BulkAction`

**Checkpoint**: the foundation builds; the shared tests pass; story work can start.

---

## Phase 3: User Story 1 - Saved segments as audiences (Priority: P1) 🎯 MVP

**Goal**: managers save segments with tag, attribute, consent, lead source, date and behaviour rules,
see live counts, and use them as campaign audiences and drip enrolments.

**Independent Test**: create a segment with each rule kind; check its counts against seeded contacts;
launch a campaign to it; enrol it in a drip (quickstart US1).

### Tests for User Story 1 ⚠️ (write first, must fail)

- [ ] T018 [P] [US1] Write the unit tests apps/api/test/unit/contacts/segment-query.builder.spec.ts:
  - the SQL and parameters per rule kind (snapshots), and "all of" / "any of" groups
  - values are never put into the SQL text
  - broken references come back as `{ group, rule, issue }`
- [ ] T019 [P] [US1] Write the integration test apps/api/test/integration/segments.int-spec.ts:
  - create, rename, copy, delete; `NAME_TAKEN`
  - `/segments/preview` counts against seeded contacts for every rule kind: tags has and has not, attributes by type, consent, lead source, added, last inbound, blocked, and behaviour (sent, delivered, read, replied, clicked, failed; did and did not; one campaign and 7/30/90 days)
  - the marketable count, and a sample of 20 masked for roles without `phones.full`
  - a deleted tag gives a broken rule
  - `/segments/{id}/count`
  - agents: list and count yes, change no (403)
  - audit entries
- [ ] T020 [P] [US1] Write the integration test apps/api/test/integration/campaign-segment-audience.int-spec.ts:
  - `audienceType: SEGMENT`: the estimate equals the marketable count
  - the launch snapshot holds the members at launch, including a contact added after the campaign was made
  - opted-out and blocked contacts are left out
  - a broken segment refuses the launch (`SEGMENT_BROKEN`)
  - deleting a segment used by a draft gives 409 `SEGMENT_IN_USE`, with the campaign listed
- [ ] T021 [P] [US1] Write the integration test apps/api/test/integration/drip-segment-enrol.int-spec.ts:
  - `POST /drips/{id}/enrolments { segmentId }` answers 202 with a `DRIP_ENROL` bulk action
  - after the bulk processor runs: the 005 counts (enrolled, opted out, already in, not found)
  - a second enrolment skips those already in
  - the action's progress through `GET /contacts/bulk-actions/{id}`
- [ ] T022 [P] [US1] Write the contract cases in apps/api/test/contract/contacts-settings.contract-spec.ts (new file): every `/segments*` route, the 001 campaign with `SEGMENT`, and the 005 enrolment's 202
- [ ] T023 [P] [US1] Write the Playwright e2e apps/web/e2e/contacts-us1-segments.spec.ts:
  - build the quickstart segment and watch the counts change
  - save it and launch a campaign to it
  - enrol it in a drip and see the progress
  - delete a used tag and see the broken rule

### Implementation for User Story 1

- [ ] T024 [US1] Write apps/api/src/modules/contacts/segment-query.builder.ts (research R1):
  - compile `SegmentRules` to a parameterised `WHERE` over `contacts c`
  - reuse the 001 tag and attribute rule SQL from audience-query.builder.ts
  - behaviour rules as `EXISTS` subqueries over `messages`, with the 009 replied fragment and 005 `link_clicks`
  - return the broken references
- [ ] T025 [US1] Write apps/api/src/modules/contacts/segments.service.ts and segments.controller.ts:
  - CRUD, copy, preview (counts and a sample masked by role), count
  - a 10-second Redis count cache per rules hash, and a 10-second statement timeout
  - the unfinished campaigns using a segment (`usedBy`)
  - audit `segment.*`
  - remove the `segment.*` actions from `PENDING`
- [ ] T026 [US1] Add `SEGMENT` audiences to campaigns:
  - in apps/api/src/modules/campaigns/audience-snapshot.service.ts (`assertReady`, the snapshot) and the estimate service, through the segment builder plus the 001 consent, block and duplicate rules
  - `segmentId` in campaigns.service.ts, checked with the audience type
  - the delete guard in segments.service.ts
- [ ] T027 [US1] Write the bulk action base, used by US1 and US2:
  - apps/api/src/modules/contacts/bulk-actions.service.ts: create, progress and result updates, the selection walk in keyset batches of 5,000 over ids, a filter or a segment
  - `GET /contacts/bulk-actions` and `GET /contacts/bulk-actions/{id}` in bulk-actions.controller.ts
  - the `DRIP_ENROL` handler in bulk.processor.ts, calling the 005 enrolment service in batches
- [ ] T028 [US1] Extend the 005 enrolment route (apps/api/src/modules/drips/drip-enrolments.controller.ts and its service): `{ segmentId }` creates a `DRIP_ENROL` bulk action and answers 202
- [ ] T029 [P] [US1] Write the web pages:
  - apps/web/src/app/(dashboard)/contacts/segments/page.tsx (list with lazy counts) and contacts/segments/[id]/page.tsx (rule groups editor with live counts, the sample, broken rules, the unfinished campaigns using it)
  - the segment filter on apps/web/src/app/(dashboard)/contacts/page.tsx
  - the "Segment" audience in the campaign wizard (apps/web/src/components/campaigns/wizard/audience-step.tsx)
  - "Enrol a segment" with progress on the drip page

**Checkpoint**: segments work on their own (quickstart row US1).

---

## Phase 4: User Story 2 - Bulk tags, automatic tags, lead source and export (Priority: P1) 🎯 MVP

**Goal**: tags for many contacts at once, automatic tags on events, a lead source on every new
contact, and a contacts export.

**Independent Test**: bulk add and remove tags; trigger each automatic rule; check each entry point's
lead source; download exports (quickstart US2).

### Tests for User Story 2 ⚠️

- [ ] T030 [P] [US2] Write the integration test apps/api/test/integration/bulk-tags.int-spec.ts:
  - add and remove by chosen ids, by a filter and by a segment
  - 12,000 seeded contacts, so more than two batches run
  - changed counts, and two actions run in order
  - audit `contacts.bulk_tagged` with the counts
  - agents get 403
- [ ] T031 [P] [US2] Write the integration test apps/api/test/integration/auto-tags.int-spec.ts:
  - rule CRUD (`settings.manage`; managers read only)
  - each event adds the tag: a contact created from each lead source, a campaign reply within 72 hours, a link click, opt-in, opt-out
  - contacts from before the rule are not changed
  - a manual removal stays until the event happens again
  - a duplicate rule gives 409; audit entries
- [ ] T032 [P] [US2] Write the integration test apps/api/test/integration/lead-source.int-spec.ts. Each entry point sets its kind:
  - an inbound first message (ORGANIC)
  - the public API and the 006 contacts API (API, with a custom label)
  - an import with a label (IMPORT)
  - a campaign upload (CAMPAIGN_UPLOAD)
  - a first message with a chat link reference (CHAT_LINK, with the link's name)
  - a first message with a website button reference (WEBSITE_BUTTON)
  - a first message with an ad referral (AD)
  - an ad lead form (LEAD_FORM), a WhatsApp Form (FORM) and a store order (STORE)
  - it also checks:
    - a later message with a chat link reference does not change it
    - the contact list filters by kind and returns the source
    - the migration's legacy mapping, by running its SQL on seeded rows
- [ ] T033 [P] [US2] Write the integration test apps/api/test/integration/contacts-export.int-spec.ts:
  - every column, with one column per attribute definition
  - the row count equals the list's count for a filter and for a segment
  - a broken segment gives 422; agents get 403
  - audit `data.exported` with target `contacts` and the row count
  - a unit test of the row writer covers masked phones when `phonesFull` is false
- [ ] T034 [P] [US2] Write the contract cases for `/contacts/bulk-actions*`, `/contacts/export.csv` and `/auto-tag-rules*` in apps/api/test/contract/contacts-settings.contract-spec.ts
- [ ] T035 [P] [US2] Write the Playwright e2e apps/web/e2e/contacts-us2-tags-export.spec.ts:
  - select rows and add a tag; "all matching" and remove a tag, watching the progress
  - an automatic tag rule for the website button source
  - the lead source column and filter
  - the export download

### Implementation for User Story 2

- [ ] T036 [US2] Add the `TAG_ADD` and `TAG_REMOVE` handlers to apps/api/src/modules/contacts/bulk.processor.ts (set-based `INSERT … ON CONFLICT DO NOTHING` and `DELETE` per batch), and `POST /contacts/bulk-actions` to bulk-actions.controller.ts (`contacts.manage`; audit; remove the action from `PENDING`)
- [ ] T037 [US2] Write apps/api/src/modules/contacts/auto-tags.service.ts and auto-tags.controller.ts (rules CRUD; a 30-second rule cache; idempotent `apply`), and call `apply` from:
  - the lead source helper (T013) on creation
  - apps/api/src/modules/contacts/consent.service.ts on opt-in and opt-out
  - the 005 click recorder (apps/api/src/modules/growth/links/link-redirect.service.ts)
  - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts on a campaign reply (a delivered or read campaign message within 72 hours)
- [ ] T038 [US2] Use `leadSourceFor()` in every creation path, and upgrade first-message sources:
  - **creation paths:**
    - apps/api/src/modules/webhooks/handlers/inbound.handler.ts and inbox/inbound/inbound-chat.handler.ts
    - public-api/public-api.service.ts and contacts/contacts.service.ts (API, imports with labels, stores)
    - contacts/consent.service.ts (campaign uploads)
    - ads/leads/ad-lead-forms.service.ts, the 008 form answer contact creation and the 006 store order path
  - **first-message upgrades** (`upgradeFirstMessageSource`):
    - the 006 chat link matcher (CHAT_LINK, or WEBSITE_BUTTON for `source: WIDGET` links)
    - the 007 ad referral matcher (AD)
- [ ] T039 [US2] Extend the contact list and profile:
  - the `leadSource` filter and the `leadSource` and `leadSourceLabel` fields in apps/api/src/modules/contacts/contacts.service.ts and contacts.controller.ts
  - the 002 chat contact panel (`chat-contact.service.ts`) returns the kind and label
- [ ] T040 [US2] Write apps/api/src/modules/contacts/contacts-export.controller.ts (research R6):
  - streamed keyset batches of 2,000, with back-pressure
  - columns from the attribute definitions; masking by `phones.full`
  - audit `data.exported` with target `contacts`
- [ ] T041 [P] [US2] Write the web parts:
  - on apps/web/src/app/(dashboard)/contacts/page.tsx: row selection, "all matching", add/remove tags dialogs with progress, the lead source column and filter, the export button
  - the lead source on the contact profile and the chat contact panel
  - apps/web/src/app/(dashboard)/settings/automatic-tags/page.tsx

**Checkpoint**: US1 and US2 work on their own. Push the MVP batch and fix CI.

---

## Phase 5: User Story 3 - Global attributes (Priority: P2)

**Goal**: company-wide values used in campaign variables, chat replies, flows and AI agent
instructions.

**Independent Test**: use one global attribute in each place, change it, and try to delete it
(quickstart US3).

### Tests for User Story 3 ⚠️

- [ ] T042 [P] [US3] Write the unit tests for `{global:key}`:
  - in apps/api/test/unit/flows/render.spec.ts and apps/api/test/unit/inbox/canned-render.spec.ts
  - the `global` variable source in apps/api/test/unit/campaigns/variable-resolver.spec.ts
  - unknown keys and empty values
- [ ] T043 [P] [US3] Write the integration test apps/api/test/integration/global-attributes.int-spec.ts:
  - CRUD (`settings.manage`); every role can list; `KEY_TAKEN`; the key pattern
  - a campaign variable mapped to a global attribute gets the value at launch
  - an empty value refuses the launch (`GLOBAL_ATTRIBUTE_EMPTY`)
  - a saved reply and a flow message use the current value
  - the AI agent's system prompt holds the value (`FakeClaude` captures it)
  - a change is seen within the cache time
  - deletion is refused while in use, with the users listed by `/usage`
  - audit entries
- [ ] T044 [P] [US3] Write the contract cases for `/global-attributes*`
- [ ] T045 [P] [US3] Write the Playwright e2e apps/web/e2e/settings-us3-global-attributes.spec.ts: create, map in a campaign, insert in a chat reply, change the value, and the deletion refusal

### Implementation for User Story 3

- [ ] T046 [US3] Write apps/api/src/modules/settings/global-attributes.service.ts and global-attributes.controller.ts (research R7):
  - CRUD, a 30-second cache cleared on change, the usage scan
  - audit `global_attribute.*`; remove them from `PENDING`
- [ ] T047 [US3] Add the `global` source to the variable resolver:
  - in apps/api/src/modules/campaigns/variable-resolver.ts (`VariableSourceSchema` gains `global`)
  - resolve it at launch, and refuse empty values in `assertReady` (`GLOBAL_ATTRIBUTE_EMPTY`)
- [ ] T048 [US3] Fill `{global:key}`:
  - in apps/api/src/modules/flows/engine/render.ts and apps/api/src/modules/inbox/canned/canned-render.ts
  - in the 004 prompt builder (apps/api/src/modules/ai/agent/prompt-builder.ts) before the request to Claude
  - a value that is still empty is left out and logged, never sent as a blank
- [ ] T049 [P] [US3] Write the web parts:
  - apps/web/src/app/(dashboard)/settings/global-attributes/page.tsx
  - the "Global attribute" source in the campaign wizard mapping step
  - an "Insert global attribute" menu in the live chat composer and the saved reply editor
  - global attributes in the flow editor's placeholder picker

---

## Phase 6: User Story 4 - Keyword replies for opt-in and opt-out (Priority: P2)

**Goal**: a confirmation reply, text or a utility template, after a consent keyword.

**Independent Test**: set both replies; send STOP and START from the inbound CLI; check consent and
the replies (quickstart US4).

### Tests for User Story 4 ⚠️

- [ ] T050 [P] [US4] Write the integration test apps/api/test/integration/keyword-replies.int-spec.ts:
  - `GET` and `PUT /settings/keyword-replies`: text length, `TEMPLATE_NOT_UTILITY` for a marketing template
  - STOP opts out and sends the text reply, which shows as a chat item
  - START sends the template reply
  - a second STOP within 24 hours sends nothing
  - nothing goes to a blocked contact, or from a number whose sending is off
  - the 001 settings refuse a keyword in both lists
  - audit `keyword_replies.changed`
- [ ] T051 [P] [US4] Write the contract cases for `/settings/keyword-replies`
- [ ] T052 [P] [US4] Write the Playwright e2e apps/web/e2e/settings-us4-keywords.spec.ts: set the replies, send STOP with the inbound CLI, and see the reply in the chat

### Implementation for User Story 4

- [ ] T053 [US4] Write apps/api/src/modules/settings/keyword-replies.ts and its controller (research R8):
  - settings read and write, with template checks on save
  - `sendKeywordReply(contact, kind, numberId)`, with the once-a-day Redis guard
  - text through the 002 session send path; template through the template path
  - call it from the 001 consent handler in apps/api/src/modules/webhooks/handlers/inbound.handler.ts after the consent change
  - refuse a keyword in both lists in apps/api/src/modules/settings/settings.service.ts
  - remove `keyword_replies.changed` from `PENDING`
- [ ] T054 [P] [US4] Write apps/web/src/app/(dashboard)/settings/keywords/page.tsx: the keyword lists (moved from the general settings page) and both replies, with an approved utility template picker and variable mapping

---

## Phase 7: User Story 5 - Birthday and other date automations (Priority: P2)

**Goal**: templates sent on dates stored in contact attributes, once per occurrence, with results.

**Independent Test**: create a yearly and a one-time automation; run days with seeded dates; check
the sends, skips, results and pausing (quickstart US5).

### Tests for User Story 5 ⚠️

- [ ] T055 [P] [US5] Write the unit tests apps/api/test/unit/automations/due-query.spec.ts: the due SQL for yearly, once, offsets and 29 February (snapshots), and the company-day bounds in other time zones
- [ ] T056 [P] [US5] Write the integration test apps/api/test/integration/date-automations.int-spec.ts:
  - **setup:** CRUD with `ATTRIBUTE_NOT_DATE` and `VARIABLES_UNMAPPED`; the 7-day preview; switching on (`campaigns.launch`; `TEMPLATE_NOT_APPROVED`)
  - **the tick, with a fake clock:**
    - contacts due today get one message (origin `DATE_AUTOMATION`), and a second tick sends nothing more
    - tomorrow's contacts wait; 29 February dates go on 28 February in a non-leap year; an offset of −3 days; a one-time date
    - skips with reasons: opted out, blocked, no date, a missing value, and not opted in for a marketing template
    - a global attribute in the mapping
    - at the end of the company day, pending occurrences become `too_late`
  - **pausing:** a rejected template or a disconnected number pauses the automation with one admin notification; resuming never sends past days
  - **results and recipients:** per day, with the 009 replied definition
  - audit entries
- [ ] T057 [P] [US5] Write the contract cases for `/date-automations*`
- [ ] T058 [P] [US5] Write the Playwright e2e apps/web/e2e/automations-us5-dates.spec.ts:
  - create a birthday automation for the next minute; seed contacts through the API
  - see the sends in mock-meta's `/mock/sent`
  - the results and recipients pages

### Implementation for User Story 5

- [ ] T059 [US5] Write apps/api/src/modules/automations/due-query.ts: the due conditions on `attributes ->> key`, using the shared `dueOn` rules and the company time zone
- [ ] T060 [US5] Write apps/api/src/modules/automations/date-automations.service.ts and date-automations.controller.ts:
  - CRUD with validation, the preview, switching with checks, results and recipients (phones masked by role)
  - audit `date_automation.*`; remove them from `PENDING`
- [ ] T061 [US5] Write apps/api/src/modules/automations/date-automation-tick.processor.ts (maintenance job `date-automation-tick` every minute, research R9):
  - insert occurrences, ignoring conflicts
  - batches of 500 messages on the number queue with campaign priority
  - skips with reasons
  - the end-of-day `too_late`
  - pausing, with the `DATE_AUTOMATION_PAUSED` notification
- [ ] T062 [US5] Let apps/api/src/modules/sending/send.processor.ts and the template payload builder send `DATE_AUTOMATION` messages with the automation's mapping, and update occurrences on the send outcome (SENT or FAILED with `send_failed`)
- [ ] T063 [P] [US5] Write the web pages:
  - apps/web/src/app/(dashboard)/automations/page.tsx (list with the last 7 days)
  - automations/[id]/page.tsx (editor with the due preview, results by day, recipients of a day)
  - a nav item 'Automations' (`campaigns.view`)

---

## Phase 8: User Story 6 - Two-factor authentication for team logins (Priority: P2)

**Goal**: an authenticator-app second step with recovery codes, a company requirement, lockout and
admin resets.

**Independent Test**: set up 2FA; sign in with a code, a wrong code and a recovery code; require 2FA;
reset a member (quickstart US6).

### Tests for User Story 6 ⚠️

- [ ] T064 [P] [US6] Write the unit tests apps/api/test/unit/auth/totp.spec.ts:
  - the RFC 6238 SHA-1 vectors (59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000)
  - one step either side accepted, two refused; replay refused through `lastStep`
  - base32 round trip and the `otpauth://` address
  - recovery code normalising (case, spaces, dashes) and hashing
- [ ] T065 [P] [US6] Write the integration test apps/api/test/integration/two-factor.int-spec.ts:
  - **self-service:** setup, confirm (10 recovery codes once), turn off with a code, new codes
  - **sign-in:**
    - with 2FA, `POST /auth/login` answers `{ next: CODE }` and sets only `sid_2fa`, while `GET /auth/me` stays 401
    - a code creates the session; a recovery code works once
    - five wrong codes give 429 `SECOND_STEP_LOCKED` for 15 minutes; the pending sign-in expires after 5 minutes
  - **required:** `next: SETUP`, and setup at sign-in creates the session and returns the codes
  - **admin reset:** ends the member's sessions; resetting oneself gives 409
  - **unaffected:** API keys keep working
  - **records:** audit entries for every event, and no code, secret or recovery code in logs or audit details
- [ ] T066 [P] [US6] Write the contract cases for `/settings/security`, `/users/{id}/2fa/reset`, `/me/2fa*` and `/auth/login/*`
- [ ] T067 [P] [US6] Write the Playwright e2e apps/web/e2e/security-us6-2fa.spec.ts:
  - turn on 2FA, computing codes with apps/web/e2e/totp.ts from the shown secret
  - sign out and in with a code
  - require 2FA, and sign in as a member who must set it up
  - an admin reset

### Implementation for User Story 6

- [ ] T068 [US6] Write apps/api/src/common/auth/totp.ts (RFC 6238 with `node:crypto`, base32, `otpauth://` address) and apps/api/src/modules/auth/recovery-codes.ts (10 codes from the link-code alphabet, HMAC-SHA256 with the server key)
- [ ] T069 [US6] Extend the sign-in (contracts/login-2fa.md):
  - apps/api/src/modules/auth/auth.service.ts and auth.controller.ts: the pending sign-in cookie `sid_2fa` and its Redis record, `POST /auth/login/code`, `POST /auth/login/setup` and `/setup/confirm`
  - the lockout counters in login-throttle.service.ts
  - cookie helpers in auth.cookies.ts
- [ ] T070 [US6] Write apps/api/src/modules/me/two-factor.controller.ts (`/me/2fa*`), the security settings controller (`GET` and `PUT /settings/security`) and `POST /users/{id}/2fa/reset` in the users module (ending sessions); audit `auth.2fa_*` and `security.2fa_required_changed`, and remove them from `PENDING`
- [ ] T071 [US6] Write apps/api/scripts/reset-2fa.ts and the `auth:reset-2fa` script (operator reset, audited with the actor `operator`)
- [ ] T072 [P] [US6] Write the web pages:
  - the code step and the setup step on apps/web/src/app/(auth)/login/page.tsx
  - apps/web/src/app/(dashboard)/account/two-factor/page.tsx (QR code, confirm, recovery codes to save, turn off, new codes)
  - apps/web/src/app/(dashboard)/settings/security/page.tsx (require 2FA, members' status, reset)
  - a banner for members who must set up 2FA

**Checkpoint**: US3–US6 work on their own. Push the second batch and fix CI.

---

## Phase 9: User Story 7 - Business profile, display name status and blue tick checklist (Priority: P3)

**Goal**: edit the WhatsApp Business profile through Meta, see the display name status and limits,
and follow the blue tick checklist.

**Independent Test**: edit each field and the picture; check refusals and the name status badges;
tick checklist steps (quickstart US7).

### Tests for User Story 7 ⚠️

- [ ] T073 [P] [US7] Write apps/api/test/support/fake-business-graph.ts (nock): profile `GET` and `POST`, the number status fields, the Resumable Upload steps, and Meta-style errors on demand
- [ ] T074 [P] [US7] Write the integration test apps/api/test/integration/business-profile.int-spec.ts:
  - `GET` combines the profile and the number status
  - `PUT` sends only changed fields and returns Meta's values
  - our limit checks refuse before calling Meta; `META_REFUSED` keeps Meta's field and message
  - `NUMBER_NOT_CONNECTED` makes no call
  - pictures: a square one is accepted; 3000×2000 and over 5 MB are refused
  - a `DECLINED` name status shows
  - audit with field names only
  - the checklist `GET` and `PUT`
  - managers can read, only admins can change
- [ ] T075 [P] [US7] Write the contract cases for `/numbers/{id}/business-profile*` and `/oba-checklist`
- [ ] T076 [P] [US7] Write the Playwright e2e apps/web/e2e/numbers-us7-profile.spec.ts:
  - edit the profile and upload a picture
  - a refused picture
  - a `DECLINED` name status set through mock-meta
  - tick checklist steps

### Implementation for User Story 7

- [ ] T077 [US7] Write apps/api/src/modules/numbers/business-profile.service.ts and business-profile.controller.ts (contracts/meta-business-profile.md):
  - the Graph calls through the 001 client; a 5-minute status cache; the `number_business_profiles` row
  - the picture through the Resumable Upload flow
  - error mapping; audit `business_profile.changed` with field names; remove it from `PENDING`
- [ ] T078 [US7] Read the messaging limit from `whatsapp_business_manager_messaging_limit` in the 001 number sync (apps/api/src/modules/numbers/number-sync.processor.ts), keeping the `messaging_limit_tier` column
- [ ] T079 [US7] Write apps/api/src/modules/numbers/oba-checklist.service.ts and oba-checklist.controller.ts (shared steps plus the stored progress; audit `oba_checklist.changed`; remove it from `PENDING`)
- [ ] T080 [P] [US7] Write apps/web/src/app/(dashboard)/numbers/[id]/profile/page.tsx:
  - the profile form with the shared limits, and a picture upload with a square check before upload
  - name status, quality and limit badges, with the steps for declined names
  - the blue tick checklist

---

## Phase 10: User Story 8 - Guides for moving a number in and out (Priority: P3)

**Goal**: the two migration guides on the numbers page.

**Independent Test**: open both guides and check every step, warning and link (quickstart US8).

- [ ] T081 [P] [US8] Write the Playwright e2e apps/web/e2e/numbers-us8-guides.spec.ts: both guides from the numbers page, every step from the shared data, and the link to the number removal with its typed confirmation
- [ ] T082 [US8] Write apps/web/src/app/(dashboard)/numbers/guides/[guide]/page.tsx from the shared `NUMBER_GUIDES`, with links from apps/web/src/app/(dashboard)/numbers/page.tsx and the "move back" link to the existing removal dialog

---

## Phase 11: Polish & Cross-Cutting Concerns

- [ ] T083 [P] Add the observability of research R13:
  - **metrics** in apps/api/src/common/metrics/metrics.service.ts, with their instrumentation points: `wbm_segment_query_seconds`, `wbm_bulk_actions_total{kind,result}`, `wbm_contacts_exported_total`, `wbm_keyword_replies_total{kind,result}`, `wbm_date_automation_messages_total{result}` and `wbm_login_second_step_total{result}`
  - **alerts** `WbmDateAutomationBehind` and `WbmSecondStepFailures` in ops/alerts.yml, with cases in apps/api/test/unit/alerts.spec.ts
- [ ] T084 [P] Extend retention and erasure, tests first:
  - **retention**, in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts: bulk actions after 90 days; occurrences with their messages
  - **erasure**, in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts: a contact's occurrences are deleted, and exports never include erased contacts
- [ ] T085 [P] Empty the 010 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [ ] T086 [P] Add contracts/contacts-settings-api.openapi.yaml to apps/api/test/integration/rbac.int-spec.ts (routes without x-permission are skipped by the test)
- [ ] T087 [P] Run `perf:segments` in CI (a manual workflow job or the build-test job) and record SC-001 in the release checklist
- [ ] T088 [P] Update the docs:
  - README.md: a Contacts, settings and security section
  - specs/010-contacts-settings-security/quickstart.md, if steps changed
  - docs/research/aisensy/feature-inventory-2026-11-19.md: mark items 1.3, 1.4, 1.6, 2.3, 3.2, 3.3, 3.5, 3.8, 3.9, 3.10 and 5.11; also mark the 002 and 003 rows built earlier (2.4, 2.5, 3.11, 6.1–6.11, 6.13, 6.14, 7.1, 7.2); update the roadmap
- [ ] T089 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/010-contacts-settings-security/checklists/release.md, with the pre-release items:
  - **2FA:** required for admins, and the operator reset in the runbook
  - **Profile:** the real profile changed once and seen on a phone; picture limits confirmed
  - **Templates:** the birthday and keyword reply templates approved
  - **Guides:** re-checked against Meta's pages (`checkedAt`)

---

## Dependencies & Execution Order

- **Setup (T001–T004)** → **Foundational (T005–T017)** → stories.
- **The MVP batch:**
  - **US1** needs the foundation. T027's bulk action base is also used by US2.
  - **US2** needs the foundation (the lead source helper T013) and T027 (bulk actions).
- **Batch 2:**
  - **US3** needs only the foundation.
  - **US4** needs only the foundation (it can use global attributes in template variables once US3
    lands).
  - **US5** needs US3 (the `global` source in its mapping).
  - **US6** is independent.
- **Batch 3:** **US7** and **US8** are independent; Polish comes last.

### Within each story

Tests (T0xx marked first) → services and controllers → wiring into earlier modules → web pages.

## Parallel Opportunities

- **Setup:** T001–T004 run in parallel.
- **Foundation:** T006–T010 (shared files), T016 and T017 run in parallel after T005.
- **US1:** T018–T023 run in parallel; then T024 → T025 → T026, T027 → T028, with T029 in parallel.
- **US2:** T030–T035 run in parallel; then T036, T037, T038, T039 and T040 touch different files;
  T041 is in parallel.
- **Batch 2:** US3, US4 and US6 can run side by side; US5 follows US3.
- **Batch 3:** US7 and US8 can run side by side with Polish tasks T083–T087.

### Parallel example: User Story 1

```text
Task: "Unit tests apps/api/test/unit/contacts/segment-query.builder.spec.ts" (T018)
Task: "Integration test apps/api/test/integration/segments.int-spec.ts" (T019)
Task: "Integration test apps/api/test/integration/campaign-segment-audience.int-spec.ts" (T020)
Task: "Integration test apps/api/test/integration/drip-segment-enrol.int-spec.ts" (T021)
Task: "Playwright e2e apps/web/e2e/contacts-us1-segments.spec.ts" (T023)
```

## Implementation Strategy

1. **MVP:** Setup, Foundational, US1 and US2, test-first. Push once and fix CI. Segments, bulk tags,
   automatic tags, lead sources and the export are then usable.
2. **Batch 2:** US3–US6 (global attributes, keyword replies, date automations, 2FA). Push and fix CI.
3. **Batch 3:** US7, US8 and Polish. Push, fix CI, write the release checklist, then ask for the
   merge.
4. Tasks are marked [X] only after CI confirms them.

**Totals**: 89 tasks. Setup 4, Foundational 13, US1 12, US2 12, US3 8, US4 5, US5 9, US6 9, US7 8,
US8 2, Polish 7.
