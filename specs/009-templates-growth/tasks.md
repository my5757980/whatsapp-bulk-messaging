---
description: "Task list for more template types, campaign reports and the website chat button (feature 009)"
---

# Tasks: More Template Types, Campaign Reports and the Website Chat Button

**Input**: Design documents from `/specs/009-templates-growth/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/templates-growth-api.openapi.yaml, contracts/public-otp-v1.openapi.yaml,
contracts/meta-templates.md, contracts/website-button.md, quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- **No real accounts in tests.** Meta is mocked with nock in unit and integration tests
  (`FakeTemplatesGraph`, T014) and with mock-meta in e2e (`tools/mock-meta/src/templates.ts` and
  `src/site.ts`). No real template, code, phone or website is used.
- **Unconfirmed fields.** Fields marked *(verify)* in research.md and contracts/meta-templates.md are
  checked against Meta's live pages in the first task of the story that uses them, then pinned in the
  contract.

**Organization**: by user story (spec.md US1–US8) after Setup and Foundational, in the plan's
delivery order. Pushes are batched: US1–US3 (the MVP), US4–US5, then US6–US8 with Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US8); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: contract lint, and the mock-meta skeletons for template kinds, delivery hold, the test
site and card replies.

- [ ] T001 [P] Register the two 009 contract files:
  - add specs/009-templates-growth/contracts/templates-growth-api.openapi.yaml and public-otp-v1.openapi.yaml to the `lint:contracts` script in package.json
  - add `'templates-growth-api.openapi.yaml'` and `'public-otp-v1.openapi.yaml'` (feature folder `009-templates-growth`) to `ContractFile` and `FEATURE_OF` in apps/api/test/contract/openapi-validator.ts
- [ ] T002 [P] Add tools/mock-meta/src/templates.ts, mounted from tools/mock-meta/src/server.ts (contracts/meta-templates.md §5). Later stories add their rules to this file. It starts with:
  - template create and edit that keep `kind`-specific components and `message_send_ttl_seconds`, approved after 30 seconds like other mock templates
  - `POST /{phone-number-id}/media` returning `media-<n>` ids
  - the send route accepting authentication, carousel and offer payloads, recorded in `/mock/sent`
- [ ] T003 [P] Add `POST /mock/hold-delivery { phoneNumberId, on }` to tools/mock-meta/src/webhook-emitter.ts (no `delivered` webhooks while on), and add tools/mock-meta/src/site.ts serving `GET /mock/site/{page}?key=…`: a plain HTML page with the website button snippet pointing at the api's public link base (contracts/website-button.md)
- [ ] T004 [P] Add `--button-payload <payload> --button-text <text>` to tools/mock-meta/src/inbound-cli.ts: an inbound `button` message, for carousel card quick replies

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, shared template kinds and launch rules, status ranking with `EXPIRED`,
permissions, scope and event lists, error meanings, the Meta fake, module wiring, redaction, web
types and earlier contracts.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [ ] T005 Write the Prisma models and the migration apps/api/prisma/migrations/20261210000000_templates_growth/migration.sql per data-model.md, then update apps/api/prisma/schema.prisma and run `prisma generate`. The migration holds:
  - **new enums:** `TemplateKind`, `TtlAppliedBy`, `ExpiredReason`, `ChatLinkSource` and `ChatWidgetStatus`
  - **new enum values:** `MessageOrigin.OTP`, `MessageStatus.EXPIRED`, `SkipReason.OFFER_CODE_MISSING` and `MEDIA_URL_MISSING`
  - **new columns:**
    - `templates`: `kind` (default `STANDARD`), `ttl_seconds`, `ttl_applied_by`, `options` (default `{}`)
    - `campaigns`: `allow_duplicate_rows`, `offer_config`, `card_media`, `launched_by_id`
    - `messages`: `copy_index` (default 0), `expired_reason`, `expires_at`
    - `chat_links`: `source` (default `MANUAL`), `widget_id`, `widget_rule_id`
    - `chat_link_opens`: `page`
  - **new tables:** `otp_settings` and `chat_widgets` (card media reuse the 001 `media_assets.meta_media_ids` cache)
  - **a hand-written SQL tail:**
    - drop the unique `(campaign_id, contact_id)` on `messages` and add `(campaign_id, contact_id, copy_index)`
    - indexes: `messages (created_at)`, the partial `messages (expires_at) WHERE status = 'SENT'`, `consent_events (created_at)`, `chat_link_opens (chat_link_id, page)`
    - a one-row unique index on `otp_settings`
    - backfill `campaigns.launched_by_id` from the `campaign.launched` audit entries, else `created_by_id`
    - checks: `copy_index >= 0`, `otp_settings.limit_per_phone` between 1 and 50, `limit_window_minutes` between 1 and 1440
- [ ] T006 [P] Unit tests in packages/shared/src/template-rules.test.ts for the new kinds (research R2, R6, R7, R8):
  - **authentication:**
    - the body cannot be set
    - `codeExpiryMinutes` is 1–90 or null
    - `COPY_CODE` or `ONE_TAP`; `ONE_TAP` needs 1–5 apps, each package name with at least two dot-separated segments starting with letters (at most 224 characters) and an 11-character signature hash of `[A-Za-z0-9+/=]`
    - button and autofill texts are at most 25 characters
    - no media header and no footer text
  - **carousel:**
    - MARKETING only
    - message body at most 1024 characters
    - 2–10 cards with one media format (IMAGE or VIDEO)
    - card body at most 160 characters, on every card or none
    - at most 2 buttons per card (QUICK_REPLY, URL, PHONE_NUMBER), the same types in the same order on every card
    - every card needs a sample file
  - **limited-time offer:**
    - MARKETING only, with no footer
    - offer text at most 16 characters; body at most 600 characters, examples included
    - a copy-code example of at most 15 characters, and one URL button
  - **TTL:**
    - ranges: AUTHENTICATION 30–900, UTILITY 30–43200, MARKETING 43200–2592000
    - `ttlAppliedBy` is META for the first two and PLATFORM for marketing
    - a category change clears a TTL outside the new range
- [ ] T007 [P] Unit tests packages/shared/src/templates/template-kinds.test.ts:
  - the mapping keys `CARD.{i}.BODY.{n}`, `CARD.{i}.BUTTON.{b}`, `HEADER.media` and `$offerCode`, and the keys each kind needs in the campaign mapping step
  - card quick reply payloads `wbm:c{i}:b{b}`: encoded and parsed, with anything else refused
- [ ] T008 [P] Unit tests packages/shared/src/campaigns/launch-checks.test.ts and the `EXPIRED` cases in packages/shared/src/status.test.ts:
  - **launch checks:**
    - an offer must end in the future and after the scheduled start
    - card media must match the template's format and the size limits (001 `HEADER_MEDIA`)
    - media addresses must be https
    - "send to every row" works only with UPLOAD audiences
  - **status ranking:**
    - `EXPIRED` with `NOT_DELIVERED_IN_TIME` is replaced by `DELIVERED`, `READ` or `FAILED`
    - `EXPIRED_BEFORE_SENDING` and `OFFER_ENDED` are final
    - `EXPIRED` never goes back to `QUEUED` or `SENT`
- [ ] T009 Implement the shared modules tested by T006–T008:
  - packages/shared/src/template-rules.ts (kinds, TTL ranges, `ttlAppliedByFor`)
  - packages/shared/src/templates/template-kinds.ts
  - packages/shared/src/campaigns/launch-checks.ts
  - `EXPIRED` in packages/shared/src/status.ts
  - export them from packages/shared/src/index.ts and rebuild `@wbm/shared`
- [ ] T010 [P] Add the 009 lists to packages/shared, with cases in each file's test (research R17):
  - **permission** in permissions.ts and permissions.test.ts: `reports.view` (ADMIN, MANAGER)
  - **API key scope** in integrations/scopes.ts and scopes.test.ts: `otp.send`, labelled "Send one-time codes"
  - **event type** in integrations/events.ts and events.test.ts: `otp.status` (group `otp`)
  - **enums** in enums.ts: `MessageOrigin.OTP`, `MessageStatus.EXPIRED` and `ExpiredReason`
- [ ] T011 [P] Unit tests packages/shared/src/help/error-meanings.test.ts (research R12):
  - every code in apps/api/src/modules/meta/meta-error-classifier.ts, plus 131050, 131051, 131052, 131053 and 131057, has `title`, `meaning`, `action` and `checkedAt`
  - the platform reasons have entries: unknown outcome, expired before sending, not delivered in time, offer ended, and the media address problems
  - an unknown code gives Meta's text with general advice
- [ ] T012 Implement packages/shared/src/help/error-meanings.ts (texts in our own words, from Meta's public error reference) and make `describeMetaError` in apps/api/src/modules/meta/meta-error-classifier.ts read its titles; keep apps/api/test/unit/meta-error-classifier.spec.ts green
- [ ] T013 [P] Add the 009 audit actions of research R17 to apps/api/src/modules/audit/audit-actions.ts, and list them in `PENDING` in apps/api/test/unit/audit-coverage.spec.ts until their story records them
- [ ] T014 [P] Add the test support files:
  - apps/api/test/support/fake-templates-graph.ts: `FakeTemplatesGraph`, a stateful nock fake per contracts/meta-templates.md §5:
    - template create and edit checks per kind
    - media uploads
    - send payload checks per kind, with the calls recorded
    - `holdDelivery`
  - apps/api/test/support/templates.ts helpers: seed an approved template of each kind; seed an API key with given scopes; deliver a status webhook for a message
- [ ] T015 [P] Add `code`, `codeEnc` and `coupon_code` to the redaction list in apps/api/src/common/logging/redaction.ts, with cases in apps/api/test/unit/logging-redaction.spec.ts
- [ ] T016 [P] Add the web libraries, with types from the contracts, labels and query keys:
  - apps/web/src/lib/templates.ts: kind labels, TTL range labels, and who applies the TTL
  - apps/web/src/lib/reports.ts
  - apps/web/src/lib/chat-widgets.ts
  - apps/web/src/lib/help.ts: re-exports of the shared help data
- [ ] T017 Create apps/api/src/modules/otp/otp.module.ts and wire it into apps/api/src/app.module.ts (and the worker where its jobs run):
  - add `'l/w/widget.js'`, `'l/w/:key/config.json'` and `'l/w/:key/image'` to the global prefix exclusions in apps/api/src/app.setup.ts
  - keep apps/api/test/unit/app-module.spec.ts green
- [ ] T018 Update the earlier contracts for the new fields, then run `npm run lint:contracts`:
  - **001 dashboard-api.openapi.yaml:**
    - TemplateInput and Template gain `kind`, `ttlSeconds`, `ttlAppliedBy`, `auth`, `cards`, `offer` and `options` (the TemplateKindFields of the 009 contract)
    - campaigns gain `allowDuplicateRows`, `offerConfig` and `cardMedia`
    - the campaign report gains CampaignReportAdditions
    - `MessageStatus` gains `EXPIRED` and `expiredReason`; `SkipReason` gains `OFFER_CODE_MISSING` and `MEDIA_URL_MISSING`
  - **002 inbox-api.openapi.yaml:** button reply chat items carry `card` (`{cardIndex, buttonIndex}`)
  - **006 contracts:**
    - the `otp.send` scope
    - the `otp.status` event in webhook-events.md (no code)
    - ChatLink gains `source`, and the chat links list leaves out `WIDGET` links

**Checkpoint**: the foundation is ready; stories can begin.

---

## Phase 3: User Story 1 - Send one-time codes through WhatsApp (Priority: P1) 🎯 MVP

**Goal**: managers create authentication templates; company systems send codes through
`POST /api/v1/otp`; codes go first on the number's queue and are never stored.

**Independent Test**: quickstart US1 row: an approved code template, a key with `otp.send`, a code
delivered with a copy-code button, its status readable, the code masked, the sixth code refused.

### Tests for User Story 1 (write first, must fail)

- [ ] T019 [P] [US1] Unit tests:
  - apps/api/test/unit/templates/template-components-auth.spec.ts: our authentication draft becomes Meta's create body (contracts/meta-templates.md §1):
    - copy code, and one-tap with `supported_apps`
    - the footer only when a validity is set
    - the security note
    - `message_send_ttl_seconds`
    - the `URL` button Meta returns is read back
  - apps/api/test/unit/sending/template-payload-auth.spec.ts: the code as the body parameter and the button parameter (`sub_type: url`, `index: "0"`), taken only from the decrypted job and never from `resolved_params`
- [ ] T020 [P] [US1] Integration test apps/api/test/integration/templates-auth.int-spec.ts (`FakeTemplatesGraph`):
  - create, submit and sync an authentication template; editor rule problems give 422 with field issues
  - one-tap needs its apps
  - the TTL is sent to Meta and stored with `ttl_applied_by = META`
  - a manager can create it; an agent gets 403
- [ ] T021 [P] [US1] Integration test apps/api/test/integration/otp-api.int-spec.ts (`FakeTemplatesGraph`):
  - **settings:**
    - the default template must be an approved AUTHENTICATION template, else TEMPLATE_NOT_AUTHENTICATION
    - the number must be connected
    - a change is audited as `otp_settings.changed`
  - **accepting a code:**
    - `POST /api/v1/otp` returns 202 with an id
    - a key without `otp.send` gets 403 SCOPE_MISSING, and a key with only `otp.send` cannot use `POST /v1/messages`
    - the code format is 4–15 letters or digits
    - INVALID_NUMBER; RECIPIENT_BLOCKED for a blocked number
  - **consent:** an opted-out contact still gets the code; no contact is created and consent is unchanged
  - **limits:** the sixth code within the window gets 429 TOO_MANY_CODES with `Retry-After`; an admin's new limit applies
  - **idempotency:** a repeat with the same key and body returns the first response with no second send; a changed body gets 409
  - **priority:** with 50 campaign jobs waiting on the number, the code's job runs first
  - **status:**
    - delivered, read and failed webhooks update `GET /api/v1/otp/{id}` and emit `otp.status` without the code
    - another key's id gets 404
    - a number stopped by quality or its limit gives 422 NUMBER_NOT_SENDING at once
- [ ] T022 [P] [US1] Contract cases:
  - apps/api/test/contract/otp.contract-spec.ts against contracts/public-otp-v1.openapi.yaml: the 202, the errors and the status
  - `/otp/settings` in a new apps/api/test/contract/templates-growth.contract-spec.ts
- [ ] T023 [P] [US1] Playwright e2e apps/web/e2e/templates-us1-codes.spec.ts:
  - create a code template (security note, 10-minute validity, copy code, 5-minute TTL), approved on mock-meta
  - choose it in Settings → One-time codes; give a key **Send one-time codes**
  - `POST /api/v1/otp` with the key: `/mock/sent` shows the code twice in the payload, and the message log shows `••••`
  - the sixth code gets 429

### Implementation for User Story 1

- [ ] T024 [US1] Add the authentication rules to tools/mock-meta/src/templates.ts: the create body checks, and sends that must carry the code twice (at most 15 characters). Mirror them in `FakeTemplatesGraph`. Check the copy-code and one-tap pages again *(verify)* and fix contracts/meta-templates.md.
- [ ] T025 [US1] Templates api:
  - map AUTHENTICATION drafts in apps/api/src/modules/templates/template-components.builder.ts (create and edit bodies with `message_send_ttl_seconds`)
  - remove the editor refusal and store `kind`, `options` and `ttl_seconds` in apps/api/src/modules/templates/templates.service.ts
  - read the kind and options back in apps/api/src/modules/templates/templates-sync.service.ts
- [ ] T026 [US1] Implement apps/api/src/modules/otp/otp.service.ts (research R3 – R5):
  - checks: the code, the phone (libphonenumber with the default country), an approved AUTHENTICATION template, and a connected number that is sending
  - refuse blocked numbers
  - the Redis per-phone counter
  - a `messages` row: origin `OTP`, no contact, the code masked
  - the job, added through a new `otpSendJob()` in apps/api/src/modules/sending/send-jobs.ts: the code encrypted with `TokenCipher`, no priority, `removeOnComplete` and `removeOnFail` true
- [ ] T027 [US1] Sending and statuses:
  - apps/api/src/modules/sending/send.processor.ts decrypts `codeEnc` for OTP jobs and builds the payload through a new `authenticationComponents()` in template-payload.builder.ts; it never logs payloads
  - apps/api/src/modules/webhooks/handlers/status.handler.ts emits `otp.status` for `origin = OTP` through apps/api/src/modules/integrations/webhooks/platform-events.ts
- [ ] T028 [US1] Add the routes:
  - apps/api/src/modules/otp/public-otp.controller.ts:
    - `POST /v1/otp` with `@RequireScope('otp.send')`, the 006 idempotency storing the masked response, and the key rate limit
    - `GET /v1/otp/{id}`: the key's own codes, for 30 days
  - apps/api/src/modules/otp/otp-settings.controller.ts: `GET` and `PUT /otp/settings` with the last-24-hours counts, audited
- [ ] T029 [P] [US1] Web:
  - the kind choice in apps/web/src/app/(dashboard)/templates/new/page.tsx, with new apps/web/src/components/templates/code-options.tsx and apps/web/src/components/templates/ttl-field.tsx
  - the fixed code text in apps/web/src/components/templates/template-preview.tsx
  - apps/web/src/app/(dashboard)/settings/one-time-codes/page.tsx, linked from settings/layout.tsx
  - the scope label on the API key screens comes from the shared labels

**Checkpoint**: US1 runs alone.

---

## Phase 4: User Story 2 - Carousel templates with cards chosen at send time (Priority: P1) 🎯 MVP

**Goal**: managers build carousels; campaigns choose card media, uploaded once per number; card
quick replies come back to chats and flows.

**Independent Test**: quickstart US2 row: a 3-card carousel approved, a campaign with another image
on card 2, each payload with the media ids and variables, a card 2 reply shown as "Card 2 · Tell me
more".

### Tests for User Story 2 (write first, must fail)

- [ ] T030 [P] [US2] Unit tests:
  - apps/api/test/unit/templates/template-components-carousel.spec.ts: cards with a `header_handle` each, card bodies and buttons, and the message body
  - apps/api/test/unit/sending/template-payload-carousel.spec.ts: `card_index`, header media `id`s, card body and url parameters, quick reply payloads `wbm:c{i}:b{b}`
  - the `wbm:c1:b0` button case in apps/api/test/unit/inbox/message-parser.spec.ts
- [ ] T031 [P] [US2] Integration test apps/api/test/integration/templates-carousel.int-spec.ts (`FakeTemplatesGraph`):
  - **templates:** create, submit (one resumable upload per card sample) and sync
  - **campaign media:**
    - the cards default to the samples, and card 2 can be replaced from the library
    - `POST /campaigns/{id}/media-check` reports READY, WRONG_TYPE or TOO_LARGE per card
  - **launch:**
    - each card file is uploaded once per number; a second campaign reuses the cached Meta id (`media_assets.meta_media_ids`), and after the cache age (fake clock) the file is uploaded again
    - each recipient's payload carries the card variables
  - **replies:**
    - a card 2 quick reply becomes a chat item with the card and button
    - a 003 template button trigger starts its flow
  - **results:** tracked url buttons count clicks (005)
- [ ] T032 [P] [US2] Contract cases:
  - `POST /campaigns/{id}/media-check` (card part) in apps/api/test/contract/templates-growth.contract-spec.ts
  - the CAROUSEL template cases in apps/api/test/contract/us3.contract-spec.ts
- [ ] T033 [P] [US2] Playwright e2e apps/web/e2e/templates-us2-carousel.spec.ts:
  - build a 3-card carousel; it is approved
  - a campaign with another image on card 2 shows the card preview, and launches to three test contacts
  - `/mock/sent` has three carousel payloads with media ids
  - the CLI reply `wbm:c1:b0` shows "Card 2 · Tell me more" in live chat

### Implementation for User Story 2

- [ ] T034 [US2] Add the carousel rules to tools/mock-meta/src/templates.ts and `FakeTemplatesGraph`: the create checks, the media upload, and sends that check every card has a media id. Check the carousel page again *(verify)* and fix contracts/meta-templates.md.
- [ ] T035 [US2] Map CAROUSEL drafts in apps/api/src/modules/templates/template-components.builder.ts, uploading each card's sample with apps/api/src/modules/media/meta-resumable-upload.ts in templates.service.ts; sync the cards back in templates-sync.service.ts
- [ ] T036 [US2] Add apps/api/src/modules/campaigns/media-check.service.ts (the card checks; card files go to the number through the 001 `MediaService.ensureMetaMediaId`):
  - the `POST /campaigns/{id}/media-check` route in campaigns.controller.ts
  - apps/api/src/modules/campaigns/launch.service.ts uploads the card media before dispatch and refuses with MEDIA_PROBLEMS
- [ ] T037 [US2] Campaign sends:
  - `cardMedia` on create and update in apps/api/src/modules/campaigns/campaigns.service.ts
  - the `CARD.*` mapping keys in variable-resolver.ts and audience-snapshot.service.ts
  - a `carouselComponents()` in apps/api/src/modules/sending/template-payload.builder.ts, using the Meta ids from `MediaService.ensureMetaMediaId`
- [ ] T038 [US2] Inbound: apps/api/src/modules/inbox/inbound/message-parser.ts reads `wbm:c{i}:b{b}` payloads into the chat item's `card`; the chat item text is "Card {i+1} · {button text}"; 003 template button triggers still match on the button text
- [ ] T039 [P] [US2] Web:
  - apps/web/src/components/templates/carousel-cards.tsx in templates/new
  - the cards preview in template-preview.tsx
  - apps/web/src/components/campaigns/wizard/card-media.tsx in mapping-step.tsx
  - card replies in apps/web/src/components/inbox/chat-item-view.tsx

**Checkpoint**: US1 and US2 run alone.

---

## Phase 5: User Story 3 - Limited-time offers with a countdown and a code (Priority: P2) 🎯 MVP batch

**Goal**: offer templates; campaigns set the end time and each recipient's code; nothing is sent
after the end.

**Independent Test**: quickstart US3 row: an offer campaign ending in two days with codes from an
upload column; a row without a code is skipped; messages after the end are "offer ended".

### Tests for User Story 3 (write first, must fail)

- [ ] T040 [P] [US3] Unit tests:
  - apps/api/test/unit/templates/template-components-offer.spec.ts: the component order, no footer, and the copy-code example
  - apps/api/test/unit/sending/template-payload-offer.spec.ts: `limited_time_offer.expiration_time_ms`, the `coupon_code` parameter at index 0 and the url parameter at index 1
- [ ] T041 [P] [US3] Integration test apps/api/test/integration/templates-offer.int-spec.ts (`FakeTemplatesGraph`):
  - create, submit and sync an offer template
  - **offer config:** an end in the past, or before the scheduled start, gets 422
  - **codes:** per-recipient codes from an upload column and from an attribute; a missing code skips the recipient with OFFER_CODE_MISSING
  - each payload carries the end time and the recipient's code
  - **after the end:** a campaign paused until after the end drops the rest as `EXPIRED` / `OFFER_ENDED`, counted in the results
- [ ] T042 [P] [US3] Contract cases: `offerConfig` on the 001 campaign routes in apps/api/test/contract/us5.contract-spec.ts, and `expired.offerEnded` in the campaign report
- [ ] T043 [P] [US3] Playwright e2e apps/web/e2e/templates-us3-offer.spec.ts:
  - build an offer template; it is approved
  - a campaign ending in two days with codes from an upload column
  - `/mock/sent` shows each recipient's own code; the row without a code shows "missing offer code"

### Implementation for User Story 3

- [ ] T044 [US3] Add the offer rules to tools/mock-meta/src/templates.ts and `FakeTemplatesGraph`. Check the offer page again, especially `expiration_time_ms` as a timestamp *(verify)*, and fix contracts/meta-templates.md.
- [ ] T045 [US3] Map LIMITED_TIME_OFFER drafts in apps/api/src/modules/templates/template-components.builder.ts and sync them back
- [ ] T046 [US3] Campaigns and sending:
  - `offerConfig` in campaigns.service.ts, checked in launch.service.ts
  - `$offerCode` and OFFER_CODE_MISSING in audience-snapshot.service.ts and variable-resolver.ts
  - the send-time end check in a new apps/api/src/modules/sending/send-expiry.ts, called by send.processor.ts, giving `EXPIRED` / `OFFER_ENDED` through send-outcome.ts
  - an `offerComponents()` in template-payload.builder.ts
- [ ] T047 [P] [US3] Web:
  - apps/web/src/components/templates/offer-fields.tsx in templates/new
  - the countdown in the preview
  - apps/web/src/components/campaigns/wizard/offer-config.tsx (end time, and the code from one value, a column or an attribute)

**Checkpoint**: the MVP batch (US1–US3) is done; push once and fix CI.

---

## Phase 6: User Story 4 - Stop late delivery, and send media from a web address (Priority: P2)

**Goal**: a TTL per template (Meta for codes and utility, our queue for marketing), the expired
sweep, and media addresses in campaigns with a launch check.

**Independent Test**: quickstart US4 row: a 60-second TTL with delivery held shows "not delivered
in time"; a document campaign with per-row addresses blocks on a bad address and sends after the fix.

### Tests for User Story 4 (write first, must fail)

- [ ] T048 [P] [US4] Unit tests apps/api/test/unit/sending/send-expiry.spec.ts: `queued_at + ttl` past gives EXPIRED_BEFORE_SENDING for every kind; an offer end past gives OFFER_ENDED; no TTL means no drop; `expires_at` is set only for Meta-applied TTL
- [ ] T049 [P] [US4] Integration test apps/api/test/integration/templates-ttl.int-spec.ts (`FakeTemplatesGraph`, fake clock):
  - **ranges:** ranges by category are enforced (422); the TTL is sent to Meta for AUTHENTICATION and UTILITY and never for MARKETING
  - **category change:** a sync that finds Meta changed utility to marketing clears the TTL, or keeps it as PLATFORM when it fits
  - **before sending:** a paused campaign resumed after the TTL drops the queued messages as EXPIRED_BEFORE_SENDING
  - **after sending:**
    - with delivery held, the sweep marks sent messages NOT_DELIVERED_IN_TIME after `ttl + 10 minutes`
    - a late delivered webhook replaces the mark
  - **retries and completion:** retry rounds (005) never pick `EXPIRED`; a campaign completes with its expired messages counted
- [ ] T050 [P] [US4] Integration test apps/api/test/integration/campaign-media-urls.int-spec.ts (nock hosts):
  - `HEADER.media` from one address, a column or an attribute; a missing value skips the recipient with MEDIA_URL_MISSING
  - **the check:**
    - an http address, a private address, the wrong type, too large and a timeout each give their reason
    - more than 1,000 distinct addresses are sampled (`sampled: true`)
    - launch is refused with MEDIA_PROBLEMS and at most 50 problems
  - **sending:** messages go out with `link`; a send-time failure shows the help reason
  - the public API refuses an http address with 422
- [ ] T051 [P] [US4] Contract cases: the address part of `POST /campaigns/{id}/media-check`, the TTL fields on templates (apps/api/test/contract/us3.contract-spec.ts), and the `expired` report fields
- [ ] T052 [P] [US4] Playwright e2e apps/web/e2e/templates-us4-ttl-media.spec.ts:
  - **TTL:** a utility template with a 30-second TTL, delivery held on mock-meta, and the sweep's grace and interval shortened by env for e2e: the message shows "not delivered in time"
  - **media addresses:** a document campaign with `invoice_url` per row; **Check media** lists the bad row; after the fix it launches

### Implementation for User Story 4

- [ ] T053 [US4] Templates: send `message_send_ttl_seconds` for AUTHENTICATION and UTILITY on create and edit, set `ttl_applied_by`, and handle category changes in templates-sync.service.ts (research R8)
- [ ] T054 [US4] Sending and expiry:
  - apps/api/src/modules/sending/send-expiry.ts in send.processor.ts for every message
  - set `messages.expires_at` when a Meta-applied TTL message is sent
  - a new apps/api/src/modules/sending/expired-sweep.processor.ts (an `expired-sweep` job every 5 minutes on the maintenance queue), with `EXPIRED_SWEEP_GRACE_SECONDS` (default 600) and `EXPIRED_SWEEP_EVERY_SECONDS` (default 300) in apps/api/src/common/config/config.ts and .env.example
  - apps/api/src/modules/webhooks/handlers/status-update.ts lets delivered, read and failed replace NOT_DELIVERED_IN_TIME
  - `EXPIRED` is final in apps/api/src/modules/campaigns/campaign-progress.processor.ts and left out of retry rounds
- [ ] T055 [US4] Media addresses:
  - `HEADER.media` in variable-resolver.ts and audience-snapshot.service.ts (to `$headerMediaUrl`, with MEDIA_URL_MISSING)
  - the address checks in media-check.service.ts through apps/api/src/common/http/safe-http.ts (HEAD, else a ranged GET; 5 at a time; at most 1,000 distinct, sampled above that)
  - launch.service.ts refuses MEDIA_PROBLEMS
- [ ] T056 [P] [US4] Web:
  - ttl-field.tsx shows who applies the TTL
  - apps/web/src/components/campaigns/wizard/media-source.tsx (one address, a column or an attribute) in mapping-step.tsx
  - **Check media** with its problem list in review-step.tsx
  - expired counts by reason in the campaign report page apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx

**Checkpoint**: US4 runs on top of the MVP.

---

## Phase 7: User Story 5 - Replies, duplicates and reports (Priority: P2)

**Goal**: replied counts and the reply rate that match the retarget group, "send to every row", and
the overview, team member and consent reports.

**Independent Test**: quickstart US5 row: two replies give replied 2; three rows of one number send
three messages; each report's totals match the campaign results and download as CSV.

### Tests for User Story 5 (write first, must fail)

- [ ] T057 [P] [US5] Unit tests packages/shared/src/reports/ranges.test.ts: a range ending before it starts, longer than 366 days, or older than 12 months is refused; day bounds in the company time zone
- [ ] T058 [P] [US5] Integration test apps/api/test/integration/campaign-replies-duplicates.int-spec.ts:
  - **replies:**
    - `replied` equals the size of the 005 Replied retarget group (SC-006); a reply after 3 days does not count
    - `replyRate` is replied divided by delivered
    - the recipients list takes the `replied` filter
  - **send to every row:**
    - on: one number on three rows gets three messages with `copy_index` 0–2 and each row's variables
    - opted-out numbers are still skipped
    - the estimate counts messages, and `multiMessageRecipients` is right
    - off: one message per number, as today
    - retarget groups hold distinct contacts
  - **export:** the campaign export has `replied`, `replied_at` and `clicks`
- [ ] T059 [P] [US5] Integration test apps/api/test/integration/reports.int-spec.ts:
  - **overview:** totals match the campaign results, by day in the company time zone, by category and by number, with failures by reason, expired counts and the cost
  - **team report:**
    - `launched_by_id`, including campaigns backfilled from audit entries
    - removed members are still listed
    - the conversation openings stats
  - **consent report:**
    - each change with its source; counts by day and source; paging
    - phones masked without `phones.full`
  - **ranges:** bad ranges give 422 RANGE_INVALID
  - **downloads:**
    - each CSV streams the same numbers as its JSON
    - downloads are audited as `data.exported` with the report type
  - **permissions:** agents get 403
- [ ] T060 [P] [US5] Contract cases:
  - `/reports/*` in apps/api/test/contract/templates-growth.contract-spec.ts
  - the CampaignReportAdditions in apps/api/test/contract/us5.contract-spec.ts
- [ ] T061 [P] [US5] Playwright e2e apps/web/e2e/reports-us5.spec.ts:
  - replied and the reply rate on a campaign with two CLI replies
  - "send to every row" with a repeated number sends three messages
  - the three reports for this month, each downloaded

### Implementation for User Story 5

- [ ] T062 [US5] Replied counts:
  - move the REPLIED fragment into apps/api/src/modules/campaigns/replied.sql.ts, used by retarget.service.ts and the campaign report in apps/api/src/modules/reports/reports.service.ts (`replied`, `replyRate`, cached for 60 seconds)
  - the `replied` filter in campaign-messages.controller.ts
  - the new columns in apps/api/src/modules/reports/export.controller.ts
- [ ] T063 [US5] Duplicate rows and who launched:
  - `allowDuplicateRows` (UPLOAD only) in campaigns.service.ts
  - audience-upload.processor.ts and csv.ts keep every valid row when it is on
  - audience-snapshot.service.ts sets `copy_index`
  - estimate.service.ts counts messages
  - the report's `multiMessageRecipients`
  - launch.service.ts sets `launched_by_id`
- [ ] T064 [US5] Reports in apps/api/src/modules/reports/:
  - overview-report.service.ts, team-report.service.ts and consent-report.service.ts
  - reports-v2.controller.ts with the JSON summaries and streamed CSVs: ranges from the shared rules, audit, and phone masking
- [ ] T065 [P] [US5] Web:
  - replied, the reply rate and the Replied filter on apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx
  - the "send to every row" option in apps/web/src/components/campaigns/wizard/audience-step.tsx
  - apps/web/src/app/(dashboard)/reports/page.tsx with Overview, Team and Opt-ins tabs, a date range and downloads
  - a **Reports** nav item (`reports.view`) in apps/web/src/app/(dashboard)/layout.tsx

**Checkpoint**: batch 2 (US4–US5) is done; push once.

---

## Phase 8: User Story 6 - A library of sample templates (Priority: P3)

**Goal**: 60+ original samples, filtered and copied into drafts.

**Independent Test**: quickstart US6 row: Food → Order update → Use this sample gives a draft with
the sample's text and examples.

### Tests for User Story 6 (write first, must fail)

- [ ] T066 [P] [US6] Unit tests packages/shared/src/templates/samples.test.ts:
  - every sample passes `validateTemplate` (media samples are exempt only from the missing-file rule)
  - at least 60 samples and 10 industries
  - every purpose and type of the spec; at least 10 in Arabic
  - ids and names are unique
  - no sample contains another company's brand words (a deny list)
- [ ] T067 [P] [US6] Integration test apps/api/test/integration/template-samples.int-spec.ts:
  - filters and search
  - a copy becomes a DRAFT with the sample's content; NAME_TAKEN for a used name
  - agents can list samples but get 403 on copy
  - copies are audited as `template_sample.copied`
- [ ] T068 [P] [US6] Contract cases for `/template-samples*` in apps/api/test/contract/templates-growth.contract-spec.ts
- [ ] T069 [P] [US6] Playwright e2e apps/web/e2e/templates-us6-samples.spec.ts: filter to food and order update, use a sample, and the draft editor opens filled

### Implementation for User Story 6

- [ ] T070 [US6] Write packages/shared/src/templates/samples.ts: `TEMPLATE_SAMPLES`, our own texts per research R13, exported from index.ts
- [ ] T071 [US6] Add apps/api/src/modules/templates/template-samples.controller.ts (list, get, copy) with its service
- [ ] T072 [P] [US6] Add apps/web/src/app/(dashboard)/templates/samples/page.tsx: filters, the preview (template-preview.tsx) and a **Use this sample** dialog (account and name), linked from the templates page

**Checkpoint**: US6 runs alone.

---

## Phase 9: User Story 7 - Help where it is needed (Priority: P3)

**Goal**: editor guidelines, the meaning and action of every failure reason, and the frequency
capping notes.

**Independent Test**: quickstart US7 row: guidelines per editor section; every failure reason shows
its meaning; the marketing review step shows the per-person limit note.

### Tests for User Story 7 (write first, must fail)

- [ ] T073 [P] [US7] Unit tests packages/shared/src/help/template-guidelines.test.ts: every editor section (category, variables, media, buttons, carousel, offer, authentication) has guidelines and a `checkedAt`, and the rejection reasons are listed
- [ ] T074 [P] [US7] Integration test apps/api/test/integration/help-reasons.int-spec.ts:
  - failure reasons in campaign results and message details carry `meaning` and `action`
  - an unknown code shows Meta's text with general advice and is counted in `wbm_unknown_error_codes_total`
  - the held-back count has its explanation
- [ ] T075 [P] [US7] Playwright e2e apps/web/e2e/templates-us7-help.spec.ts: the guidelines panel per section, the meanings next to failure reasons, and the per-person limit note on a marketing campaign's review step and in its results

### Implementation for User Story 7

- [ ] T076 [US7] Write packages/shared/src/help/template-guidelines.ts in our own words, and complete the actions in error-meanings.ts
- [ ] T077 [US7] Api: `meaning` and `action` on failure reasons in reports.service.ts and campaign-messages.controller.ts; the unknown-code counter in apps/api/src/common/metrics/metrics.service.ts
- [ ] T078 [P] [US7] Web:
  - apps/web/src/components/templates/guidelines-panel.tsx in the editor
  - apps/web/src/components/help/error-meaning.tsx in the results and message details
  - apps/web/src/components/help/frequency-cap-note.tsx in review-step.tsx and the report page

**Checkpoint**: US7 runs alone.

---

## Phase 10: User Story 8 - A WhatsApp chat button for the website, and a link and QR generator (Priority: P3)

**Goal**: website buttons with page rules, served as one script plus a public config, counted
through 006 chat links; a quick link and QR generator.

**Independent Test**: quickstart US8 row:
- the mock site shows the button with the product rule's greeting
- Start chat counts one open on that page and one chat for that rule
- `/checkout` shows no button
- the generator makes a link and QR

### Tests for User Story 8 (write first, must fail)

- [ ] T079 [P] [US8] Unit tests packages/shared/src/growth/page-rules.test.ts:
  - EXACT ignores a trailing slash; PREFIX and CONTAINS
  - matching is lower-case
  - the first match wins; `hide` stops the button
  - the fragment is dropped
- [ ] T080 [P] [US8] Unit tests for the website button script:
  - apps/api/test/unit/widget/chat-button.spec.ts (`@vitest-environment jsdom`):
    - it renders in a shadow root with the look settings
    - `{hidden: true}` and fetch errors do nothing and throw nothing
    - Start chat opens the rule's link with `w` and `p`
    - Escape closes the greeting
  - apps/api/test/unit/widget/widget-bundle.spec.ts: the built file is under 30 KB, with no `import`, `require`, `document.cookie` or storage use
- [ ] T081 [P] [US8] Integration test apps/api/test/integration/chat-widgets.int-spec.ts:
  - **creating:**
    - the button's `WIDGET` chat links are made, and left out of `/chat-links`
    - a rule with its own message gets its own link
    - an update keeps the key and the snippet
    - NAME_TAKEN; NUMBER_NOT_CONNECTED
  - **the public config:**
    - CORS `*`, no cookies, the ETag and 304, and 429 from the limiter
    - hidden when paused or the number is disconnected; 404 once deleted
    - the image route
  - **counting:**
    - `/l/c/{code}?w=&p=` records the page (path only, at most 200 characters); a wrong `w` is ignored; robots are not counted
    - a chat start by ref counts for its rule; the stats route
  - **managing:**
    - one notification per disconnection
    - audit entries
    - agents get 403 on create
- [ ] T082 [P] [US8] Integration test apps/api/test/integration/whatsapp-link-tool.int-spec.ts: the link, a PNG data URL and an SVG; 422 INVALID_NUMBER; `connectedNumberId` for a connected number's phone; nothing stored
- [ ] T083 [P] [US8] Contract cases for `/chat-widgets*`, `/tools/whatsapp-link` and `/l/w/{key}/config.json` in apps/api/test/contract/templates-growth.contract-spec.ts
- [ ] T084 [P] [US8] Playwright e2e apps/web/e2e/widget-us8.spec.ts:
  - **designer:** the preview, then copying the snippet
  - **the mock site:**
    - `/mock/site/products/lamp` shows the button and the rule's greeting
    - **Start chat** reaches the chat link, and an inbound CLI message with the rule's text starts a chat
    - the counts show the open and the chat
    - `/mock/site/checkout` shows no button
  - **generator:** a link and QR, and **Save as chat link** opens the 006 form filled in

### Implementation for User Story 8

- [ ] T085 [US8] Add apps/api/src/modules/integrations/chat-widgets/chat-widgets.service.ts and chat-widgets.controller.ts:
  - create, update, pause, resume, delete, stats and the snippet
  - `WIDGET` links in chat-links.service.ts, hidden from the list
  - `w` and `p` in chat-link-redirect.service.ts
  - the "From the website button · {rule}" label from chat-link-matcher.ts
  - the notification when a button's number disconnects
- [ ] T086 [US8] Add apps/api/src/modules/integrations/chat-widgets/widget-public.controller.ts: `/l/w/widget.js` (the static file from dist, cached for a day), `/l/w/{key}/config.json` (CORS, cache, ETag, the 005 limiter) and `/l/w/{key}/image`
- [ ] T087 [US8] Write the script apps/api/src/widget/chat-button.ts (contracts/website-button.md: shadow root, the shared page rule matcher, the greeting dialog, and a `data-preview` mode that reads an inline config). Build it with apps/api/scripts/build-widget.mjs: compile, inline the shared matcher, wrap it in an IIFE and write dist/widget/widget.js, run by the api `build` script and copied by apps/api/Dockerfile.
- [ ] T088 [US8] Add apps/api/src/modules/tools/whatsapp-link.controller.ts (the generator, with the 006 `qrcode`) and register it
- [ ] T089 [P] [US8] Web:
  - apps/web/src/app/(dashboard)/website-button/page.tsx and website-button/[id]/page.tsx: the designer with the live preview (an iframe `srcdoc` that loads widget.js with `data-preview`), page rules with their order, the snippet, the setup guide and stats
  - apps/web/src/app/(dashboard)/tools/whatsapp-link/page.tsx
  - nav items in layout.tsx

**Checkpoint**: all stories are done.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [ ] T090 [P] Add the observability of research R17:
  - **metrics** in apps/api/src/common/metrics/metrics.service.ts, with their instrumentation points: `wbm_otp_sends_total{result}`, `wbm_otp_send_seconds`, `wbm_messages_expired_total{reason}`, `wbm_widget_opens_total`, `wbm_reports_exported_total{type}`
  - **alerts** `WbmOtpFailing` and `WbmOtpSlow` in ops/alerts.yml, with cases in apps/api/test/unit/alerts.spec.ts
- [ ] T091 [P] Extend retention and erasure, tests first:
  - **retention**, in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts: OTP messages after 30 days
  - **erasure**, in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts: OTP messages to the phone lose it, and duplicate-row messages are cleared like other campaign messages
- [ ] T092 [P] Add the code leak scan for SC-002 in apps/api/test/integration/otp-no-code-leak.int-spec.ts:
  - **setup:** codes sent through a success, a failure, a retry (a 5xx then success) and an idempotent repeat
  - **what is scanned:** messages, idempotency records, audit entries, outbound events, captured logs (`Logger` prototype spies) and Redis job data
  - **what must hold:** no code appears anywhere, and the jobs are gone
- [ ] T093 [P] Empty the 009 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [ ] T094 [P] Add contracts/templates-growth-api.openapi.yaml to apps/api/test/integration/rbac.int-spec.ts, skipping `get /l/w/widget.js`, `get /l/w/{key}/config.json` and `get /l/w/{key}/image`
- [ ] T095 [P] Update the docs:
  - README.md: a Templates and growth section (code templates and the API, carousels, offers, TTL, media addresses, every row, replies, reports, samples, help, the website button, the generator)
  - specs/009-templates-growth/quickstart.md, if steps changed
  - docs/research/aisensy/feature-inventory-2026-11-19.md: mark items 4.1, 4.3–4.7, 4.9, 4.11, 5.3, 5.6, 5.13, 5.14, 12.1 and 12.2, and update the roadmap
- [ ] T096 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/009-templates-growth/checklists/release.md, with the pre-release items:
  - **Meta:** the three kinds approved on the real account; a real code in under 10 seconds; the offer end time correct on a phone
  - **One-tap (optional):** the company's Android app does Meta's handshake
  - **Website:** the snippet pasted with the site's Content Security Policy allowing the link host, checked on desktop and phone
  - **Help:** the help `checkedAt` dates re-checked

---

## Dependencies & Execution Order

- **Setup (T001–T004)** → **Foundational (T005–T018)** → stories.
- **The MVP batch:**
  - **US1** needs only the foundation.
  - **US2** needs only the foundation (T036 adds the media-check route that US4 extends).
  - **US3** needs only the foundation; T046's `send-expiry.ts` is extended by US4.
- **Batch 2:**
  - **US4** needs US2 (media-check) and US3 (send-expiry).
  - **US5** needs only the foundation.
- **Batch 3:**
  - **US6** and **US7** need only the foundation (US7's meanings were started in T012).
  - **US8** needs only the foundation and 006 chat links.
- Within a story: tests → mock routes → services → processors → web.
- **Polish** comes after the stories it touches.

## Parallel examples

- **Foundational:**
  - run at once: T006–T008 (shared tests), T010, T011, T013, T014, T015 and T016
  - then T009 and T012, then T017 and T018
- **US1:**
  - run at once: T019–T023
  - then T024 → T025 → T026 → T027 → T028; T029 beside T026–T028
- **US2:** run T030–T033 at once; then T034 → T035 → T036 → T037 → T038; T039 beside them.
- **US5:** run T057–T061 at once; then T062, T063 and T064 side by side (different files); T065 after them.
- **US8:** run T079–T084 at once; then T085 → T086 → T087, with T088 and T089 beside them.

## Implementation strategy

1. **MVP**: Setup, Foundational, US1–US3; push once and fix CI.
2. **Batch 2**: US4–US5; push once.
3. **Batch 3**: US6–US8 and Polish; push, then the release checklist.
4. Each story is independently testable through its quickstart row. Tasks are marked done only after
   CI confirms them.
