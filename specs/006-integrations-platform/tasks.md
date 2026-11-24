---
description: "Task list for integrations and the developer platform (feature 006)"
---

# Tasks: Integrations and Developer Platform

**Input**: Design documents from `/specs/006-integrations-platform/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/integrations-api.openapi.yaml,
contracts/public-api-v1.openapi.yaml, contracts/webhook-events.md, quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- Meta, Shopify and WooCommerce are mocked with nock in integration tests, and with mock-meta in
  e2e. mock-meta gains a request catcher, mock stores with signed webhook senders, and the wizard's
  Graph routes.
- Outbound requests to `http://localhost` work only with `OUTBOUND_ALLOW_LOCAL=true`, which is
  refused in production.
- No real store, endpoint or WhatsApp message is used.

**Organization**: by user story (spec.md US1–US8), after the Setup and Foundational phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US8); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: configuration, queue names, the QR library, contract lint and the request catcher.

- [X] T001 Add the settings `SHOPIFY_API_VERSION` (pattern `YYYY-MM`, default `2026-10`) and `OUTBOUND_ALLOW_LOCAL` (boolean, default false) to the env schema in apps/api/src/common/config/config.ts. The schema must refuse `OUTBOUND_ALLOW_LOCAL=true` when `NODE_ENV=production`. Document both in .env.example, and set `OUTBOUND_ALLOW_LOCAL=true` for the e2e job in .github/workflows/ci.yml
- [X] T002 [P] Add `WEBHOOKS_OUT: 'webhooks-out'` and `STORES: 'stores'` to `QUEUES` in apps/api/src/common/queue/queue.constants.ts, with comments (feature 006, plan Complexity Tracking)
- [X] T003 [P] Add `qrcode` 1.5.4 and `@types/qrcode` (exact versions) to apps/api/package.json and update package-lock.json
- [X] T004 [P] Add specs/006-integrations-platform/contracts/integrations-api.openapi.yaml and specs/006-integrations-platform/contracts/public-api-v1.openapi.yaml to the `lint:contracts` script in package.json
- [X] T005 [P] Add a request catcher to mock-meta in tools/mock-meta/src/catch.ts, mounted from tools/mock-meta/src/server.ts: `POST /catch/:name` records method, headers and raw body and answers 200 (or the status in `?status=`); `GET /catch/:name` lists them; `DELETE /catch/:name` clears them

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, the shared pure logic, the safe HTTP client, the outbox writer skeleton,
module wiring, audit actions and redaction that all stories use.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [X] T006 Write the Prisma models and the migration apps/api/prisma/migrations/20261201000000_integrations/migration.sql per data-model.md:
  - every table of §1, and the columns of §2 on `api_keys` and `messages`
  - the new enums: `WebhookEndpointStatus`, `DeliveryStatus`, `ApiCampaignStatus`, `TriggerOutcome`, `StorePlatform`, `StoreStatus`, `StoreEventStatus`, `StoreAutomationKind`, `PaymentKind`, `CodStatus`, `StoreMessageKind`, `CartStatus` and `ChatLinkStatus`
  - the enum values of §2:
    - `MessageOrigin.STORE` and `ConsentSource.STORE`
    - `DripTriggerKind` and `DripJoinVia`: `ORDER_PLACED`, `ORDER_DELIVERED`
    - `JourneyEventType`: `CHAT_LINK_STARTED`, `ORDER_PLACED`, `COD_ANSWERED`
    - the four `NotificationType` values
  - in a hand-written SQL tail:
    - the partial unique index on `store_order_messages (order_id, kind) WHERE kind <> 'COD_REPLY'`
    - the unique daily index on `chat_link_starts`
    - check constraints for `api_name`, `daily_limit` and cart steps
  - every index of §1

  Update apps/api/prisma/schema.prisma and run `prisma generate`.
- [X] T007 [P] Add the permission `integrations.manage` (admins only) to packages/shared/src/permissions.ts, with a case in its test file
- [X] T008 [P] Unit tests packages/shared/src/integrations/signing.test.ts (research R1):
  - the Standard Webhooks signature of a known vector (`{id}.{timestamp}.{body}`, base64 HMAC-SHA256 with the key decoded from `whsec_…`)
  - two `v1,` values while rotating
  - the verifier accepts any matching value and refuses timestamps over 5 minutes old
  - new secrets are `whsec_` plus 32 random bytes in base64
- [X] T009 [P] Unit tests packages/shared/src/integrations/retries.test.ts (R2):
  - the waits are 10 s, 1 min, 5 min, 30 min, 1 h, 2 h, 4 h, 8 h and 8 h (9 retries, about 23 h 36 min)
  - `nextAttemptAt` and the last-attempt rule
  - the auto-pause rule: no success for 24 h and at least 10 failed attempts
- [X] T010 [P] Unit tests packages/shared/src/integrations/events.test.ts (R3, contracts/webhook-events.md):
  - every catalog type has a group and a label
  - the payload builders give E.164 phones and the common `contact` and `message` shapes
  - with content off, `text`, `buttonPayload` and captions are removed
  - no builder accepts a secret field
- [X] T011 [P] Unit tests packages/shared/src/integrations/scopes.test.ts (R4): the five scope names, `messages.send` as the default for old keys, and the route scope check
- [X] T012 Implement packages/shared/src/integrations/signing.ts, retries.ts, events.ts and scopes.ts (pure) and export them from packages/shared/src/index.ts
- [X] T013 Move the 003 safe request rules (`isBlockedAddress`, `createSafeLookup`, no redirects, https only, a timeout, a size cap) into apps/api/src/common/http/safe-http.ts:
  - add `safeRequest({ method, url, headers, body, timeoutMs, maxBytes })`
  - add the `OUTBOUND_ALLOW_LOCAL` allowance for `http://localhost` outside production
  - re-export from apps/api/src/modules/flows/steps/api-client.ts, so 003 and 004 behave as before
  - add unit tests in apps/api/test/unit/safe-http.spec.ts: blocked private and reserved addresses, redirects refused, localhost refused unless allowed, the allowance ignored in production
- [X] T014 [P] Add the 006 audit actions of data-model.md §5 to apps/api/src/modules/audit/audit-actions.ts, and list them in `PENDING` in apps/api/test/unit/audit-coverage.spec.ts until their story records them
- [X] T015 [P] Add these keys to the redaction list in apps/api/src/common/logging/redaction.ts, with cases in apps/api/test/unit/logging-redaction.spec.ts: `credentials`, `clientsecret`, `consumerkey`, `consumersecret`, `pin`, `webhook-signature`, `x-shopify-hmac-sha256` and `x-wc-webhook-signature` (`secret` and `accesstoken` are already there)
- [X] T016 Create apps/api/src/modules/integrations/integrations.module.ts and wire it into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts:
  - `IntegrationsDomainModule` (global), which exports the services other modules call: `OutboundEvents` (T021), `CodService` (T060), `ChatLinkMatcher` (T075) and `StoreCartStops` (T067)
  - `IntegrationsApiModule`: the controllers
  - the worker processors

  Keep apps/api/test/unit/app-module.spec.ts green.
- [X] T017 [P] Add apps/web/src/lib/integrations.ts: types from both contracts, query keys and labels for event types, scopes, statuses and reasons

**Checkpoint**: the migration applies, shared logic is green, and the module compiles in the HTTP
app and the worker.

---

## Phase 3: User Story 1 - Send platform events to other systems (Priority: P1) 🎯 MVP

**Goal**: signed webhook deliveries of the chosen events, with retries, a delivery log, resend, a
test event and auto-pause.

**Independent Test**: quickstart US1 row: an endpoint on the mock-meta catcher receives signed
sent, delivered and read events and the reply, each once. Events missed during a pause arrive after
resume, and the log shows every attempt.

### Tests for User Story 1 (write first, must fail)

- [X] T018 [P] [US1] Integration test apps/api/test/integration/integrations-webhooks.int-spec.ts, with nock endpoints:
  - creating an endpoint returns the secret once; http and private addresses are refused
  - the test ping is signed, and the signature checks with the shared verifier
  - a campaign send's status webhooks and a customer reply give one delivery each for the chosen types only, with fixed ids; content off removes the text
  - a 500 or a timeout schedules retries with the R2 waits
  - a success after failures makes waiting deliveries due at once
  - 24 h of failures (moved clock) pauses the endpoint and notifies admins; resume sends the waiting events
  - resend keeps the event id; deleting an endpoint cancels its waiting deliveries
  - at most 5 in flight per endpoint, and a slow endpoint does not delay another
- [X] T019 [P] [US1] Contract cases in apps/api/test/contract/integrations.contract-spec.ts for `/webhook-event-types`, `/webhook-endpoints` (list, create, get, patch, delete, pause, resume, renew-secret, test, deliveries) and `/webhook-deliveries/{id}/resend`. Add the contract to the validator in apps/api/test/contract/openapi-validator.ts
- [X] T020 [P] [US1] Playwright e2e apps/web/e2e/integrations-us1-webhooks.spec.ts:
  - add an endpoint on `http://localhost:4010/catch/crm` and copy the secret
  - send the test event
  - send a template to two contacts and reply from one
  - check the catcher holds signed events, and that the delivery log shows them
  - pause, send, resume, and see the waiting events arrive

### Implementation for User Story 1

- [X] T021 [US1] Implement `OutboundEvents` in apps/api/src/modules/integrations/webhooks/outbound-events.ts (R2):
  - `record(tx, type, data)` writes one `outbound_events` row and one `webhook_deliveries` row per active endpoint subscribed to the type
  - the subscription lookup is cached and invalidated when endpoints change
  - `afterCommit(deliveryIds)` adds `webhooks-out` jobs with job id = delivery id
  - a 30-second sweep (apps/api/src/modules/integrations/webhooks/webhook-sweep.processor.ts) re-adds jobs for due deliveries that have none
- [X] T022 [US1] Implement the delivery processor apps/api/src/modules/integrations/webhooks/webhook-delivery.processor.ts:
  - an in-flight counter per endpoint in Redis, at most 5
  - the body is built from the event with the endpoint's content setting, then signed (shared signing, both secrets while rotating)
  - sent with `safeRequest` (10 s, 4 KB)
  - the attempt, status, error and duration are recorded
  - the next retry or the final state is scheduled with the shared waits; a success makes waiting deliveries due at once
  - the auto-pause rule sends the `WEBHOOK_ENDPOINT_FAILING` notification to admins
- [X] T023 [US1] Implement apps/api/src/modules/integrations/webhooks/webhook-endpoints.service.ts and webhook-endpoints.controller.ts per the contract:
  - CRUD with an https check and a safe-address check, and up to 20 endpoints
  - secrets encrypted with the 001 token encryption
  - pause, resume, and renew-secret (the old secret signs for 24 h)
  - a synchronous test send
  - the delivery log with filters, resend, and the event types
  - audit entries
- [X] T024 [US1] Call `OutboundEvents.record` inside the transaction of each event source (R3):
  - `message.status`: apps/api/src/modules/webhooks/handlers/status.handler.ts
  - `message.received`: apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
  - contact events:
    - apps/api/src/modules/contacts/contacts.service.ts (create, update, tags)
    - apps/api/src/modules/contacts/contact-deletion.service.ts (`contact.deleted` with the id only)
    - apps/api/src/modules/imports/import.processor.ts
    - apps/api/src/modules/public-api/public-api.service.ts
    - apps/api/src/modules/flows/engine/session.service.ts (tags and attributes)
    - the 004 memory writer
  - opt-ins and opt-outs: apps/api/src/modules/contacts/consent.service.ts
  - `link.clicked`: apps/api/src/modules/growth/links/click-recorder.ts
  - drip events:
    - `drip.joined`: apps/api/src/modules/growth/drips/drip-events.ts (`consume`) and enrolments.service.ts
    - `drip.finished`: drip-tick.processor.ts
    - `drip.left`: drip-leaving.ts
  - `chat.assigned` and `chat.closed`: apps/api/src/modules/inbox/conversations/conversations.service.ts
- [X] T025 [P] [US1] Add the web pages apps/web/src/app/(dashboard)/settings/webhooks/page.tsx and apps/web/src/app/(dashboard)/settings/webhooks/[id]/page.tsx:
  - list and add, with the secret shown once with copy
  - an event picker by group and a content setting
  - a test button showing the answer
  - the delivery log with filters and resend
  - pause and resume, renew secret, and delete
  - a **Webhooks** entry in the settings navigation (admins only)

**Checkpoint**: US1 runs alone: endpoints receive signed events with retries and a log.

---

## Phase 4: User Story 2 - Manage contacts from other systems through the API (Priority: P1)

**Goal**: API key permissions and `/api/v1` routes for contacts, tags, attributes, consent and
drip enrolment, which reuse the dashboard rules.

**Independent Test**: quickstart US2 row: an upsert by phone never duplicates; tags, opt-out and
lookup work; the journey shows the key; a send-only key gets 403 `insufficient_scope`.

### Tests for User Story 2 (write first, must fail)

- [X] T026 [P] [US2] Integration test apps/api/test/integration/integrations-contacts-api.int-spec.ts:
  - a send-only key gets 403 `insufficient_scope` on every contacts route, and old keys still send messages
  - upsert by phone: 201 then 200 with no duplicate; local-form numbers use the default country
  - lookup, get, and the list with `tag`, `updatedSince` and the cursor, in a stable order
  - attribute types are checked, and patch with null removes an attribute
  - add and remove tags
  - an opt-in without a note gives 422; an opt-out always works
  - idempotent repeats; 429 with `Retry-After`
  - drip enrol and remove by id or name under the 005 rules
  - the journey and audit show the API key, and webhook events and drip starting events are raised
- [X] T027 [P] [US2] Contract cases in apps/api/test/contract/public-api-v1.contract-spec.ts for every operation of contracts/public-api-v1.openapi.yaml except `/api-campaigns/{apiName}/messages` (US3), including 401, 403 `insufficient_scope` and 404. Add the contract to the validator
- [X] T028 [P] [US2] Playwright e2e apps/web/e2e/integrations-us2-contacts-api.spec.ts:
  - give a key *Read contacts* and *Change contacts* on the API keys page
  - call the API with `page.request` and a Bearer key
  - see the contact, its tags and its journey entry "by API key" in the dashboard

### Implementation for User Story 2

- [X] T029 [US2] Add scopes to the public API guard in apps/api/src/modules/public-api/api-key.guard.ts:
  - a `@RequireScope()` decorator
  - 403 with code `insufficient_scope`, naming the scope
  - the existing message and template routes require `messages.send`
  - the key's id goes on the request for actor and journey records
- [X] T030 [US2] Add `PUT /api-keys/{id}/scopes` to the controller in apps/api/src/modules/api-keys/api-keys.service.ts (the `@Controller('api-keys')` there), with the `api_key.scopes_changed` audit entry, and return `scopes` in the key list
- [X] T031 [US2] Add apps/api/src/modules/public-api/public-contacts.controller.ts and public-contacts.service.ts per the contract:
  - they reuse `ContactsService`, `ConsentService` and the attribute validator, with the API key as actor
  - the cursor over `(updated_at, id)`
  - idempotency through the 001 `IdempotencyService`, and rate limits through the existing guard
- [X] T032 [US2] Add apps/api/src/modules/public-api/public-drips.controller.ts (`POST` and `DELETE /v1/drips/{drip}/enrolments…`), reusing `EnrolmentsService` and `DripLeaving` (005). `{drip}` is an id or an exact name
- [X] T033 [P] [US2] Add a scopes editor to the API keys page apps/web/src/app/(dashboard)/settings/api-keys/page.tsx: checkboxes per scope with a plain description, a note that keys made before 006 can only send, and a confirmation

**Checkpoint**: US1 and US2 together form the developer platform MVP.

---

## Phase 5: User Story 3 - Trigger named API campaigns from other systems (Priority: P2)

**Goal**: API campaigns with mapping, tags, attributes and a daily limit; a trigger route; self-pause;
results.

**Independent Test**: quickstart US3 row: 3 triggers (a new phone, an existing contact, a repeated
idempotency key) give 2 messages. The new contact is tagged, a paused call gets 409, and the results
show 3 triggers.

### Tests for User Story 3 (write first, must fail)

- [X] T034 [P] [US3] Unit tests packages/shared/src/integrations/api-campaigns.test.ts:
  - `api_name` rules
  - value resolution from a call value, a contact field or fixed text
  - a missing call value names its key
  - attribute values taken from call values
  - the daily limit's day in the company time zone
- [X] T035 [P] [US3] Integration test apps/api/test/integration/integrations-api-campaigns.int-spec.ts:
  - **Setup:** build; going live is refused with problems; go live
  - **Triggers:**
    - a new phone creates a contact with the tags and attributes (or does not, by setting)
    - an existing contact; an idempotent repeat returns the first answer
    - a missing value gives 422 `MISSING_VALUE`
    - a marketing template without an opt-in is not sent unless the call opts in with a note
    - opted-out and blocked contacts are recorded as not sent
    - paused or stopped gives 409 `NOT_LIVE`; the daily limit gives 409 `DAILY_LIMIT`
  - **Self-pause:** a paused template (template status webhook) or a disconnected number pauses the campaign and notifies managers
  - **Results and export:** results equal the records per day, the export matches, and the `api_campaign.triggered` events are raised
- [X] T036 [P] [US3] Contract cases for the `/api-campaigns*` routes in apps/api/test/contract/integrations.contract-spec.ts, and for `/api-campaigns/{apiName}/messages` in apps/api/test/contract/public-api-v1.contract-spec.ts
- [X] T037 [P] [US3] Playwright e2e apps/web/e2e/integrations-us3-api-campaigns.spec.ts:
  - build "Order feedback" in the UI and set it live
  - trigger it three times with `page.request`
  - pause it and trigger it again
  - check the results and the new contact's tag

### Implementation for User Story 3

- [X] T038 [US3] Implement apps/api/src/modules/integrations/api-campaigns/api-campaigns.service.ts and api-campaigns.controller.ts:
  - CRUD, with `api_name` fixed after the first go-live
  - go-live checks: every variable has a source, the template is approved, the number is connected
  - pause, resume and stop
  - results per day from `api_campaign_triggers` and `messages`, and the CSV export
  - audit entries
- [X] T039 [US3] Implement apps/api/src/modules/integrations/api-campaigns/api-campaign-trigger.service.ts and the route `POST /v1/api-campaigns/{apiName}/messages` in apps/api/src/modules/public-api/public-api-campaigns.controller.ts (scope `campaigns.trigger`):
  - resolve values; upsert the contact with tags, attributes and an optional opt-in
  - check consent and blocking, and the daily limit (company time zone)
  - write the message through the 001 public send path with `api_campaign_id`
  - record the trigger with its outcome and raise `api_campaign.triggered`
  - idempotency
- [X] T040 [US3] Pause live API campaigns from apps/api/src/modules/webhooks/handlers/template-status.handler.ts and from the number disconnect paths in apps/api/src/modules/numbers/numbers.service.ts, with the `API_CAMPAIGN_PAUSED` notification to managers
- [X] T041 [P] [US3] Add the web pages apps/web/src/app/(dashboard)/campaigns/api/page.tsx and apps/web/src/app/(dashboard)/campaigns/api/[id]/page.tsx:
  - the list
  - the editor: template, a mapping that offers call values, header media, tags, attributes, the new-contact rule and the daily limit
  - go live, pause and stop
  - a ready-made request with copy
  - results per day and the export
  - a link from the campaigns page

**Checkpoint**: US3 runs with US2's scopes.

---

## Phase 6: User Story 4 - Send order notifications from the company's store (Priority: P2)

**Goal**: Shopify and WooCommerce connections, signed receivers, a raw event store, idempotent
processing, a reconciler and order notifications with results.

**Independent Test**: quickstart US4 row: one message per order within a minute, nothing for a
repeated event, "no phone" skipped, and the customer becomes a contact with the store tag.

### Tests for User Story 4 (write first, must fail)

- [ ] T042 [P] [US4] Unit tests packages/shared/src/integrations/stores.test.ts:
  - Shopify and WooCommerce payloads map to one order shape: number, total and currency, phones, payment kind
  - stage detection: confirmed, shipped with tracking, delivered from `shipmentStatus`, cancelled, and WooCommerce's chosen statuses
  - the phone choice order (shipping, billing, customer) with the store's default country
  - the 3-day stale rule
  - template variables from order fields
- [ ] T043 [P] [US4] Add mock stores to mock-meta: tools/mock-meta/src/shopify.ts and tools/mock-meta/src/woocommerce.ts
  - Shopify:
    - the client-credentials token endpoint
    - Admin GraphQL: shop, orders, `webhookSubscriptionCreate` and `Delete`, `tagsAdd`, `metafieldsSet`, `orderCancel`, `abandonedCheckouts`
  - WooCommerce REST v3: orders, notes, and webhooks CRUD with status
  - signed webhook senders for both, and the `npm run mock:store` command (quickstart §2) in tools/mock-meta/package.json and the root package.json
- [ ] T044 [P] [US4] Integration test apps/api/test/integration/integrations-shopify.int-spec.ts (nock):
  - **Connect:** the token exchange, subscriptions created, and the access test; the 5-store limit; credentials never returned
  - **Receiver:** a bad HMAC gives 401; a repeated `X-Shopify-Webhook-Id` is ignored
  - **Order confirmed:** sent once even when delivered twice; no phone, opted out and stale orders are skipped with reasons
  - **Contact:** created with the tag, and the consent rule applies only after confirmation
  - **Later stages:** shipped with a tracked tracking link; delivered from `shipmentStatus`; cancelled
  - **Token:** refreshed before expiry
  - **Errors:** the store goes to `ERROR` with an alert
  - **Reconciler:** it fetches orders since the last sync and re-creates a missing subscription
  - **Disconnect:** removes the subscriptions
  - **Drips:** drip starting events `ORDER_PLACED` and `ORDER_DELIVERED` are written
- [ ] T045 [P] [US4] Integration test apps/api/test/integration/integrations-woocommerce.int-spec.ts (nock):
  - the key test
  - webhooks created with a per-store secret
  - a bad signature gives 401; the unsigned activation ping is answered and ignored
  - `processing` means confirmed; `completed` means shipped by default; a chosen delivered status
  - the reconciler sets disabled webhooks active again and fetches orders `modified_after` the last sync
- [ ] T046 [P] [US4] Contract cases in apps/api/test/contract/integrations.contract-spec.ts for `/stores*`, `/stores/{id}/automations/{kind}`, its results, `/stores/{id}/orders`, and both public receivers (401 and 200)
- [ ] T047 [P] [US4] Playwright e2e apps/web/e2e/integrations-us4-store-orders.spec.ts:
  - connect the mock Shopify store
  - turn on *Order confirmed* with a template mapped to order fields
  - place an order (twice delivered) and one without a phone, through `mock:store` routes
  - see one message, the skip reason, and the contact with the store tag

### Implementation for User Story 4

- [ ] T048 [US4] Implement the Shopify client and receiver:
  - apps/api/src/modules/integrations/stores/shopify/shopify.client.ts: GraphQL through `safeRequest` on `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, the client-credentials token exchange and refresh (encrypted, `token_expires_at`), legacy tokens, webhook subscriptions, tags, metafields, cancel, and abandoned checkouts
  - apps/api/src/modules/integrations/stores/shopify/shopify-webhooks.controller.ts: the raw-body HMAC check before anything else
  - apps/api/src/modules/integrations/stores/shopify/shopify-mapping.ts: uses the shared mapping
- [ ] T049 [US4] Implement the WooCommerce client and receiver:
  - apps/api/src/modules/integrations/stores/woocommerce/woo.client.ts: REST v3 with Basic auth over https through `safeRequest`; orders, notes, status and webhooks
  - apps/api/src/modules/integrations/stores/woocommerce/woo-webhooks.controller.ts: the signature check, and the activation ping answered
  - apps/api/src/modules/integrations/stores/woocommerce/woo-mapping.ts
- [ ] T050 [US4] Implement apps/api/src/modules/integrations/stores/store-connections.service.ts and stores.controller.ts:
  - connect with the access test and webhook creation; patch (including the consent confirmation audit and the status mapping); disconnect (webhooks removed, automations stopped); sync now
  - up to 5 active stores
  - credentials encrypted and never returned
  - audit entries
- [ ] T051 [US4] Implement apps/api/src/modules/integrations/stores/store-events.processor.ts on the `stores` queue. Receivers save `store_events` (unique by delivery id) and queue a job; the processor then:
  - upserts the order and the contact (tag; opt-in source `STORE` only when consent is confirmed)
  - detects stages and writes notifications for enabled automations, unique per order and kind, with the consent, block and template checks
  - writes messages with origin `STORE` and `store_order_id` through the 001 dispatcher
  - raises `store.notification_sent`
  - writes drip starting events `ORDER_PLACED` and `ORDER_DELIVERED` (005 `DripEvents`; extend its kinds)
- [ ] T052 [US4] Implement apps/api/src/modules/integrations/stores/store-reconciler.processor.ts (every 15 minutes, a job scheduler on `stores`):
  - check each connected store
  - refresh Shopify tokens due within 1 hour
  - re-create missing Shopify subscriptions, and set WooCommerce webhooks active again
  - fetch orders updated since `last_synced_at` (at most 3 days back) as `sync:` events
  - after three failures in a row, move the store to `ERROR` with the `STORE_CONNECTION_ERROR` notification, and back to `CONNECTED` on success
- [ ] T053 [US4] Implement apps/api/src/modules/integrations/stores/automations.service.ts and store-results.service.ts: get and put automations with validation (approved templates, mapping from order fields), results per kind with skip reasons, and the orders list (phones masked for agents)
- [ ] T054 [US4] Show `STORE` messages as automatic in live chat (`WHEN 'STORE' THEN 'AUTOMATIC'` in the 002 chat timeline), and add an `ORDER_PLACED` journey entry. Update the origin enum in specs/002-team-inbox/contracts/inbox-api.openapi.yaml and in the 001 dashboard contract where message origins are listed
- [ ] T055 [P] [US4] Add the web pages apps/web/src/app/(dashboard)/integrations/stores/page.tsx and apps/web/src/app/(dashboard)/integrations/stores/[id]/page.tsx:
  - the list, and a connect dialog per platform with plain set-up steps (the Shopify Dev Dashboard app and its scopes; WooCommerce keys)
  - settings, including the consent confirmation and WooCommerce status mapping
  - notification editors with mapping from order fields, and results
  - the orders list
  - an **Integrations** navigation entry

**Checkpoint**: US4 runs alone with either store.

---

## Phase 7: User Story 5 - Confirm cash-on-delivery orders on WhatsApp (Priority: P2)

**Goal**: COD confirmation with per-message button payloads, the first answer marking the store
order, replies, a reminder and "not confirmed", and optional automatic cancel.

**Independent Test**: quickstart US5 row with three COD orders: confirm, cancel (automatic cancel
on), and no answer.

### Tests for User Story 5 (write first, must fail)

- [ ] T056 [P] [US5] Unit tests packages/shared/src/integrations/cod.test.ts:
  - building and parsing payloads `cod1:{orderId}:Y|N`
  - transitions: the first answer wins; `CLOSED` when the order is cancelled or paid first
  - the reminder and final times
- [ ] T057 [P] [US5] Integration test apps/api/test/integration/integrations-cod.int-spec.ts:
  - **Confirmation:** a COD order gets the confirmation with both payloads
  - **Confirm:** gives the Shopify tag and metafield, and the free-text reply
  - **Cancel:** with automatic cancel on, calls `orderCancel`; with it off, adds the tag only and sends `COD_CANCELLED` to admins
  - **Repeated tap:** gives the "already answered" reply
  - **No answer:** the reminder at `reminderMinutes`, then `NO_ANSWER` and its tag at `finalMinutes`
  - **Order closed first:** cancelled or paid in the store first gives `CLOSED`, with no reminder
  - **WooCommerce:** a note, meta and status
  - **Failures:** a failing store action is retried and shown on the order
  - **Results:** counts match
- [ ] T058 [P] [US5] Playwright e2e apps/web/e2e/integrations-us5-cod.spec.ts:
  - turn on COD with short test waits
  - place three COD orders with `mock:store`
  - tap the buttons with `mock:inbound --button-payload`
  - check the mock store's tags and the results

### Implementation for User Story 5

- [ ] T059 [US5] Support quick-reply button payload parameters in apps/api/src/modules/sending/template-payload.builder.ts. `resolvedParams` keys `BUTTON.{index}.payload` become `{ type: "button", sub_type: "quick_reply", index, parameters: [{ type: "payload", payload }] }`, with unit cases in its existing test file
- [ ] T060 [US5] Implement `CodService` in apps/api/src/modules/integrations/stores/cod.service.ts:
  - sending the confirmation from the events processor (button payloads per message)
  - `handleButton(payload, inbound)`, called from apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts before flow routing for `cod1:` payloads
  - the first answer wins
  - the reply goes through the 002 session send path
  - store actions (tag, metafield, note, cancel) are jobs on `stores` with retries
  - it raises `store.cod_answered` and adds the `COD_ANSWERED` journey entry
- [ ] T061 [US5] Implement apps/api/src/modules/integrations/stores/store-tick.processor.ts (every 30 seconds, a job scheduler on `stores`). It claims due COD reminders and finals with `FOR UPDATE SKIP LOCKED` (the 005 drip tick pattern), and leaves a hook for cart reminders (T067)
- [ ] T062 [P] [US5] Add a COD tab on the store page apps/web/src/app/(dashboard)/integrations/stores/[id]/page.tsx:
  - the template picker, which accepts only templates with two quick-reply buttons
  - the replies and waits
  - the automatic cancel setting, with a plain explanation
  - COD results and the orders filter by COD status

**Checkpoint**: US5 runs on a connected store.

---

## Phase 8: User Story 6 - Remind customers about abandoned carts (Priority: P3)

**Goal**: up to 3 marketing reminders per cart with consent, stop rules, tracked cart links and
recovered value.

**Independent Test**: quickstart US6 row: reminder 1 with the customer's own link, nothing after
the order, the cart counted as recovered with its value, and a cart without consent skipped.

### Tests for User Story 6 (write first, must fail)

- [ ] T063 [P] [US6] Unit tests packages/shared/src/integrations/carts.test.ts:
  - step validation: 1–3 steps, 30 minutes to 7 days, increasing
  - due times
  - stop decisions per event
  - the 7-day recovery window
  - expiry
- [ ] T064 [P] [US6] Integration test apps/api/test/integration/integrations-carts.int-spec.ts:
  - **Reminder:** a Shopify checkout gives a cart; at the due time it is fetched again (`abandonedCheckouts`) and reminder 1 is sent with a 005 tracked link to the recovery URL
  - **Consent:** no consent means skipped; store consent counts only after confirmation
  - **Stopping:**
    - an order after a reminder gives `RECOVERED` with the value
    - an order before any reminder closes the cart without counting it as recovered
    - an opt-out, a block or an inbound message stops it
  - **Once:** each step is sent once, even when the checkout is updated
  - **WooCommerce:** a `pending` order gives a cart with `payment_url`
  - **Expiry and results:** carts expire after 7 days; results include clicks
- [ ] T065 [P] [US6] Playwright e2e apps/web/e2e/integrations-us6-carts.spec.ts:
  - turn on reminders
  - start checkouts with `mock:store`
  - move the test clock through the mock (or short waits)
  - check the reminder, the recovery after the order, and the skipped cart

### Implementation for User Story 6

- [ ] T066 [US6] Track carts in apps/api/src/modules/integrations/stores/store-events.processor.ts:
  - Shopify `checkouts/create` and `checkouts/update`, and WooCommerce `pending` orders
  - the cart is closed or recovered when the matching order arrives
  - recovered carts raise `store.cart_recovered`
- [ ] T067 [US6] Add cart reminders to apps/api/src/modules/integrations/stores/store-tick.processor.ts:
  - each step fetches the cart again, checks marketing consent, writes the reminder with a 005 tracked link, and moves to the next step or expires
  - `StoreCartStops` (apps/api/src/modules/integrations/stores/store-cart-stops.ts) is called in the transaction of:
    - opt-outs (apps/api/src/modules/contacts/consent.service.ts)
    - blocks (apps/api/src/modules/inbox/conversations/chat-contact.service.ts)
    - inbound messages on the store's number (apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts)
- [ ] T068 [P] [US6] Add a cart reminders tab on the store page:
  - steps with templates and waits, and a note that the templates must be Marketing
  - the consent status of the store
  - the carts list and results (carts, reminders per step, clicks, recovered orders and value, skip reasons)

**Checkpoint**: US6 runs on a connected store.

---

## Phase 9: User Story 7 - Start chats with QR codes and chat links (Priority: P3)

**Goal**: chat links with a short link, QR images and a poster, counted openings, and chat starts
matched by reference that start a flow and tag the contact.

**Independent Test**: quickstart US7 row: 1 opening (the preview is not counted), 1 chat started,
1 new contact, the flow ran, and the tag was added.

### Tests for User Story 7 (write first, must fail)

- [ ] T069 [P] [US7] Unit tests packages/shared/src/integrations/chat-links.test.ts:
  - the reference alphabet (no look-alikes) and its length of 6
  - the message with its reference within limits
  - wa.me addresses: digits only, encoded text
  - matching the last `(ref XXXXXX)`; an edited reference matches nothing
- [ ] T070 [P] [US7] Integration test apps/api/test/integration/integrations-chat-links.int-spec.ts:
  - **Create:** a code and a reference
  - **Redirect:** `GET /l/c/:code` gives 302 to `wa.me` with the text; previews and robots are not counted; a turned-off or deleted link gives the 404 page; the rate limit
  - **Chat start:** an inbound first message with the reference counts a start and adds the tag
  - **Flow:** the link's flow starts before keyword flows; an active flow or a member's chat is not interrupted
  - **Results:** per day; the contacts list, tagging and export
  - **QR:** SVG and PNG
- [ ] T071 [P] [US7] Contract cases for `/chat-links*` and `/l/c/{code}` in apps/api/test/contract/integrations.contract-spec.ts
- [ ] T072 [P] [US7] Playwright e2e apps/web/e2e/integrations-us7-chat-links.spec.ts:
  - create "Shop counter" with a flow and a tag
  - download the QR and open the poster
  - open the link (one as a preview) and send the pre-filled message with `mock:inbound`
  - check the results, the flow reply and the tag

### Implementation for User Story 7

- [ ] T073 [US7] Implement apps/api/src/modules/integrations/chat-links/chat-links.service.ts and chat-links.controller.ts:
  - CRUD (the code and reference are made once; the flow must be published and on the link's number)
  - turning off and deleting
  - QR images with `qrcode` (SVG and PNG, with a size)
  - results, and the contacts list, tagging and export
  - audit entries
- [ ] T074 [US7] Implement the redirect apps/api/src/modules/integrations/chat-links/chat-link-redirect.controller.ts at `GET /l/c/:code`:
  - exclude `l/c/:code` from the global prefix in apps/api/src/app.setup.ts
  - reuse the 005 preview and robot rules and the `LinkRateLimiter`
  - record openings; answer 302 to `wa.me` or show the "no longer in use" page
- [ ] T075 [US7] Implement `ChatLinkMatcher` in apps/api/src/modules/integrations/chat-links/chat-link-matcher.ts, called from the 002 inbound handler on a chat's first message, before the 003 flow router:
  - match the reference, record the start (new contact or not), add the tag and the `CHAT_LINK_STARTED` journey entry
  - start the link's flow through the 003 session service unless a flow or a member's chat is active
- [ ] T076 [P] [US7] Add the web pages:
  - apps/web/src/app/(dashboard)/campaigns/chat-links/page.tsx and [id]/page.tsx: the editor, the QR preview and downloads, results, and contacts with tag and export
  - apps/web/src/app/(dashboard)/campaigns/chat-links/[id]/poster/page.tsx: a print layout of our own design
  - a link from the campaigns page

**Checkpoint**: US7 runs alone.

---

## Phase 10: User Story 8 - Connect a WhatsApp number with guided checks (Priority: P3)

**Goal**: a wizard that checks the token, lists accounts and numbers, runs each check with a fix,
sends a test message and saves the number; and a health check for connected numbers.

**Independent Test**: quickstart US8 row: a token missing a permission is named with its fix; a
good token goes through every check and the test message, and the number is saved.

### Tests for User Story 8 (write first, must fail)

- [ ] T077 [P] [US8] Unit tests apps/api/test/unit/number-wizard-checks.spec.ts for the check rules built from Graph answers:
  - missing scopes, and `expires_at` (0 means it never expires)
  - `platform_type` `NOT_APPLICABLE` means not registered
  - `name_status`, quality and `whatsapp_business_manager_messaging_limit`
  - `subscribed_apps` contains the app id
  - the app's callback URL
  - plain fix text for each failure
- [ ] T078 [P] [US8] Add the wizard's Graph routes to mock-meta in tools/mock-meta/src/wizard.ts:
  - `debug_token` with the tokens `mock-token-ok`, `mock-token-missing-scope` and `mock-token-expiring`
  - the WABA and phone number fields
  - `register` (PIN 123456), `subscribed_apps` get and post, and the app `subscriptions`
  - a test template whose `delivered` status webhook follows
- [ ] T079 [P] [US8] Integration test apps/api/test/integration/integrations-number-wizard.int-spec.ts (nock Graph):
  - a session from a token; the accounts list
  - checks; fixes (register with the PIN, subscribe the app)
  - the test message, with its delivered status arriving
  - connect: the token is encrypted and the number is created through the 001 service
  - the health check on a connected number changes nothing
  - an expired session gives 404
  - audit entries; the token never appears in checks or logs
- [ ] T080 [P] [US8] Contract cases for `/number-wizard/sessions*` and `/numbers/{id}/health-check` in apps/api/test/contract/integrations.contract-spec.ts
- [ ] T081 [P] [US8] Playwright e2e apps/web/e2e/integrations-us8-number-wizard.spec.ts: the missing-scope token, then the good token, picking the mock number, the fixes, the test message, and saving

### Implementation for User Story 8

- [ ] T082 [US8] Add these methods to apps/api/src/modules/meta/meta-graph.client.ts (Graph v27.0):
  - `debugToken`, `listWabas` (from granular scopes) and `listPhoneNumbers` (with the R13 fields)
  - `registerNumber`, `getSubscribedApps`, `subscribeApp` and `getAppSubscriptions`
  - each with unit cases
- [ ] T083 [US8] Implement apps/api/src/modules/integrations/number-wizard/number-wizard.service.ts and number-wizard.controller.ts:
  - sessions in Redis with the encrypted token and a 30-minute TTL
  - checks, saved to `number_connection_checks` without the token
  - fixes after confirmation
  - the test message, waiting up to 60 seconds for its delivered status
  - connect through apps/api/src/modules/numbers/numbers.service.ts
  - `POST /numbers/{id}/health-check`
  - audit entries
- [ ] T084 [P] [US8] Add the wizard apps/web/src/app/(dashboard)/numbers/connect/page.tsx (steps: token, pick, checks with fixes, test message, save), and a **Run checks** button on the numbers settings page

**Checkpoint**: all stories are done.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [ ] T085 [P] Add the R14 metrics to apps/api/src/common/metrics/metrics.service.ts with their instrumentation points: `wbm_webhook_deliveries_total{result}`, `wbm_webhook_delivery_seconds`, `wbm_webhook_backlog`, `wbm_store_events_total{platform,result}`, `wbm_store_messages_total{kind,result}`, `wbm_api_campaign_triggers_total{result}` and `wbm_chat_link_opens_total{kind}`. Add the alerts `WbmWebhookBacklog` and `WbmStoreEventsFailing` to ops/alerts.yml, with cases in apps/api/test/unit/alerts.spec.ts
- [ ] T086 [P] Extend retention and erasure, tests first:
  - in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts:
    - outbound events, deliveries and store events after 30 days
    - triggers, orders and their messages, carts and reminders, chat link opens and starts, and connection checks after 12 months
  - in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts, the FR-060 cases:
    - waiting reminders stop and COD waits close
    - links are cleared
    - waiting deliveries that name the contact are cancelled
- [ ] T087 [P] Empty the 006 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [ ] T088 [P] Add contracts/integrations-api.openapi.yaml to apps/api/test/integration/rbac.int-spec.ts, skipping the public receivers and `/l/c/{code}`. Add apps/api/test/integration/public-api-scopes.int-spec.ts, which reads every operation's `x-scope` from contracts/public-api-v1.openapi.yaml and checks that a key without the scope gets 403 and a key with it does not
- [ ] T089 [P] Add the performance checks with root scripts `perf:webhooks` and `perf:stores`:
  - tools/perf/webhooks-latency.ts (SC-001: 99% of events delivered within 10 s to the catcher)
  - tools/perf/stores-latency.ts (SC-004: 500 store events with 100 duplicates; 95% of notifications within 1 minute; exactly once)
- [ ] T090 [P] Docs:
  - an integrations section in README.md: webhook verification, API key scopes, the Shopify Dev Dashboard app with its scopes and protected customer data, WooCommerce keys, chat links, the wizard
  - update specs/006-integrations-platform/quickstart.md if steps changed
  - mark items 1.1, 5.9, 5.10, 7.2 (QR) and 11.2–11.7 in docs/research/aisensy/feature-inventory-2026-11-19.md, and update its roadmap
- [ ] T091 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/006-integrations-platform/checklists/release.md, with the pre-release items:
  - the Shopify Dev Dashboard app with scopes and protected customer data declared
  - WooCommerce on https with Read/Write keys
  - the Meta app callback check
  - the store's checkout text naming WhatsApp
  - Meta approval of the order update (utility) and cart reminder (marketing) templates
  - the perf runs on staging

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories.
- **US1 (P1)** is the MVP: webhooks. Its event hooks (T024) touch many modules, so other stories
  raise their events through `OutboundEvents` once it exists.
- **US2 (P1)** needs only Foundational. With US1 done, API writes raise webhook events (FR-016).
- **US3 (P2)** needs US2 (scopes and the public routes).
- **US4 (P2)** needs Foundational.
- **US5 (P2)** and **US6 (P3)** need US4 (store connections and the events processor). US6 uses
  005 tracked links.
- **US7 (P3)** needs Foundational, plus 005 link rules and 003 flows.
- **US8 (P3)** needs Foundational.
- **Polish** comes after the stories it touches.

| Story | Priority | Depends on |
|---|---|---|
| US1 | P1 | Foundational |
| US2 | P1 | Foundational (US1 for webhook events from API writes) |
| US3 | P2 | US2 |
| US4 | P2 | Foundational |
| US5 | P2 | US4 |
| US6 | P3 | US4 |
| US7 | P3 | Foundational |
| US8 | P3 | Foundational |

### Within each story

Tests first (they must fail). Then services and processors, then hooks into existing modules, then
the web UI.

## Parallel Example: User Story 1

```text
Run together (different files):
  T018 integrations-webhooks    T019 integrations.contract-spec    T020 e2e integrations-us1
Then: T021 outbox writer → T022 delivery processor → T023 endpoints service and controller
      → T024 event hooks; T025 web (parallel with T024)
```

## Parallel Example: User Story 4

```text
Run together: T042 shared store mapping tests   T043 mock stores   T044 shopify int   T045 woo int   T046 contract   T047 e2e
Then: T048 Shopify client ∥ T049 WooCommerce client → T050 connections → T051 events processor
      → T052 reconciler → T053 automations and results → T054 live chat origin; T055 web
```

## Implementation Strategy

### MVP first

1. Setup, then Foundational.
2. **US1** (webhooks), then validate the quickstart US1 row.
3. **US2** (contacts API). US1 and US2 together are the developer platform MVP.

### Incremental delivery

1. US3 (API campaigns) for developers' named sends.
2. US4 (order notifications), then US5 (COD), then US6 (carts): the store value chain.
3. US7 (chat links) and US8 (wizard) can be built in parallel with the store stories by another
   developer.
4. Polish, then the release checklist.

Each story is pushed when green locally (unit, typecheck, lint) and confirmed in CI (integration,
contract, e2e), as in 005.
