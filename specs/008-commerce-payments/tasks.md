---
description: "Task list for commerce and payments over WhatsApp (feature 008)"
---

# Tasks: Commerce and Payments over WhatsApp

**Input**: Design documents from `/specs/008-commerce-payments/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/commerce-api.openapi.yaml,
contracts/public-payments-v1.openapi.yaml, contracts/stripe.md, contracts/meta-commerce-graph.md,
quickstart.md

**Tests**: REQUIRED (constitution Principle V). Each story's tests come first and must fail before
its implementation.
- **No real accounts in tests.** Stripe and Meta are mocked with nock in unit and integration
  tests: `FakeStripe` and `FakeCommerceGraph`. In e2e they are mocked with mock-meta
  (`tools/mock-meta/src/stripe.ts` and `src/commerce.ts`). No real Stripe account, payment,
  catalog or form is used.
- **Unconfirmed fields.** Fields marked *(verify)* in research.md and the contracts are checked
  against Stripe's and Meta's live references when the client method is written (T016, T017, and the
  tasks that name them). Each one is then pinned in contracts/stripe.md or
  contracts/meta-commerce-graph.md.

**Organization**: by user story (spec.md US1–US8) after Setup and Foundational, in the plan's
delivery order. Pushes are batched: US1–US3 (the MVP), US4–US6, then US7–US8 with Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story (US1–US8); Setup, Foundational and Polish tasks have none
- Paths are relative to the repository root (npm workspaces: `apps/api`, `apps/web`,
  `packages/shared`, `tools/mock-meta`)

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: configuration, queue names, contract lint and the mock-meta Stripe and commerce
skeletons.

- [X] T001 Add the Stripe settings to the env schema in apps/api/src/common/config/config.ts and document them in .env.example (research R1):
  - `STRIPE_API_BASE_URL`: a URL, default `https://api.stripe.com`, https required in production unless it points to mock-meta in test
  - `STRIPE_API_VERSION`: default `2026-09-30.endive`, pattern `^\d{4}-\d{2}-\d{2}\.[a-z]+$`
  - Webhook addresses use the existing `APP_URL`
- [X] T002 [P] Add `PAYMENTS: 'payments'` and `CATALOG: 'catalog'` to `QUEUES` in apps/api/src/common/queue/queue.constants.ts, with a comment (feature 008, plan Technical Context)
- [X] T003 [P] Register the two 008 contract files:
  - add specs/008-commerce-payments/contracts/commerce-api.openapi.yaml and public-payments-v1.openapi.yaml to the `lint:contracts` script in package.json
  - add `'commerce-api.openapi.yaml'` and `'public-payments-v1.openapi.yaml'` (feature folder `008-commerce-payments`) to `ContractFile` and `FEATURE_OF` in apps/api/test/contract/openapi-validator.ts
- [X] T004 [P] Add tools/mock-meta/src/stripe.ts, mounted under `/stripe` from tools/mock-meta/src/server.ts. It starts with the key rules of contracts/stripe.md, `GET /stripe/v1/account` (country AE, currency aed, charges enabled), in-memory state, and a `signEvent(secret, body)` helper (`t=…,v1=…`). Later stories add their routes to this file
- [X] T005 [P] Add tools/mock-meta/src/commerce.ts, mounted from tools/mock-meta/src/server.ts. Later stories add their routes to this file. It starts with:
  - the seeded catalog `900000000000001` with 40 products: three out of stock, one `review_status: rejected`, and prices in the mixed text formats of contracts/meta-commerce-graph.md
  - `GET /{waba}/product_catalogs`, `GET /{catalog}` and paged `GET /{catalog}/products`
  - acceptance of interactive `product`, `product_list`, `catalog_message`, `cta_url` and `flow` messages in the send route, recorded in `/mock/sent`

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the schema, the shared pure rules, the Stripe and commerce clients, the fakes, module
wiring, permissions, scopes, events, audit actions, redaction, web types and the inbound CLI options.

**⚠️ CRITICAL**: no user story work can begin until this phase is complete.

- [X] T006 Write the Prisma models and the migration apps/api/prisma/migrations/20261203000000_commerce_payments/migration.sql per data-model.md, then update apps/api/prisma/schema.prisma and run `prisma generate`. The migration holds:
  - the ten tables: `payment_gateways`, `payment_settings`, `payment_requests`, `payment_events`, `catalog_connections`, `catalog_products`, `chat_orders`, `forms`, `form_versions`, `form_answers`
  - the new enums of data-model.md
  - new values on existing enums: `ChatContentType` (`PAYMENT_REQUEST`, `PRODUCT`, `PRODUCT_LIST`, `CATALOG`, `ORDER`, `FORM`), `MessageOrigin.PAYMENTS`, the six `JourneyEventType` values, the four `NotificationType` values, `ConsentSource.FORM` and `StoreAutomationKind.PAY_LINK`
  - new columns: `campaigns.payment_config`, `store_orders.payment_request_id` and `store_orders.paid_via_link_at`
  - a hand-written SQL tail:
    - one-row unique indexes on `payment_gateways`, `payment_settings` and `catalog_connections`
    - partial indexes on `payment_requests`: `(status, expires_at) WHERE status = 'WAITING'` and `(next_reminder_at) WHERE next_reminder_at IS NOT NULL`
    - `CREATE EXTENSION IF NOT EXISTS pg_trgm`, with trigram GIN indexes on `catalog_products.name` and `retailer_id`
    - a unique form name where the status is not `ARCHIVED`
    - check constraints: `amount_minor > 0`, `refunded_minor >= 0`, `reminders_sent` between 0 and 2, form version `number >= 1`
- [X] T007 [P] Unit tests packages/shared/src/commerce/money.test.ts (R5):
  - currency exponents (aed 2; bhd, kwd and omr 3; jpy 0), `toMinor` and `fromMinor`
  - `formatMinor` with plain spaces (the 007 behaviour)
  - `minimumMinor` (aed 200; other currencies from Stripe's table *(verify)*)
  - the 007 `formatMinor` import from `ads/budgets` still works
- [X] T008 [P] Unit tests packages/shared/src/commerce/payments.test.ts (R2, R3, R5):
  - **limits:** amount between the minimum and the maximum; expiry 30 minutes to 30 days; at most 1,380 minutes in flows
  - **`sessionExpiresAt`:** clamped to [now + 30 min, now + 24 h] and not beyond the request expiry when that is possible
  - **`applyPaymentEvent`:**
    - paid; async succeeded and failed
    - failed attempts with the decline code
    - an expired session leaves the request unchanged
    - partial and full refunds
    - a refund before its payment is held PENDING
    - a payment after expiry or cancel is PAID late
    - a `livemode` mismatch and the check session (`wbm_check`) are IGNORED
    - ranks never go back
  - **display states:** including Failed attempt, Partly refunded and Not delivered
  - **`redactStripeEvent`:** removes `payment_method_details`, `billing_details`, `customer_details`, `shipping_details` and `last_payment_error.payment_method`
- [X] T009 [P] Unit tests packages/shared/src/commerce/stripe-signature.test.ts (R3, contracts/stripe.md):
  - header parsing: `t`, several `v1`, `v0` ignored, unknown keys and spaces
  - HMAC-SHA256 over `${t}.${rawBody}`, compared in constant time
  - 300 s tolerance in both directions
  - the previous secret accepted only until `previousSecretUntil`
  - missing `t` or `v1` fails, and so does a changed body
- [X] T010 [P] Unit tests packages/shared/src/commerce/reminders.test.ts and gateway-checks.test.ts (R4, R6):
  - **`nextReminderAt`:** two reminders in order; a due time already past is skipped; none after expiry; each at most once; a reminder must fall before the expiry
  - **gateway checks from Stripe answers, each with a plain fix:**
    - key format, kind (a secret key is a WARNING) and mode
    - account country and currency (WARNING when not AE or aed)
    - `charges_enabled` false fails, naming `requirements.currently_due`
    - an account read refused for a restricted key is a WARNING
    - Checkout access fails with the permission named
    - endpoint registration refused is FAILED with the manual fix
    - ready means no FAILED
- [X] T011 [P] Unit tests packages/shared/src/commerce/catalog.test.ts and carts.test.ts (R8, R10, R11):
  - **`parseCatalogPrice`:** every format listed in contracts/meta-commerce-graph.md, and null when it cannot parse
  - **`isSendableProduct`:** out of stock, removed, rejected and hidden products are not sendable
  - **`COMMERCE_LIMITS` for product lists:** 1–10 sections, at most 30 items, at least 1 per section, titles required with more than one section and at most 24 characters
  - **cart totals:** from decimal `item_price` with the currency exponent
  - **`cartWarnings`:** not in the catalog, another currency, mixed currencies, a changed price
- [X] T012 [P] Unit tests packages/shared/src/commerce/forms.test.ts, flow-json.test.ts and form-token.test.ts (R12):
  - **`FormModelSchema`:**
    - keys match `^[a-z][a-z0-9_]{0,39}$` and are unique
    - the field types
    - choices have 1–20 options (dropdown at most 200)
    - 1–10 screens, each with a button
  - **`formChecks`:** reachability, required fields, options, and `FORM_LIMITS` *(verify each limit)*
  - **`compileFlowJson`:** matches the two-screen example of contracts/meta-commerce-graph.md exactly, covering:
    - version 7.3 and screen ids S1–Sn
    - the component map
    - `navigate` footers, then the terminal screen's `complete` payload with `${screen.S1.form.x}` references
  - **token encoding** (`wf1.<payload>.<mac>`, with an injected signer): it round-trips, and a changed payload or mac is refused
- [X] T013 Implement the pure modules, tested by T007–T012:
  - packages/shared/src/commerce/money.ts, payments.ts, stripe-signature.ts (`node:crypto`, as `integrations/signing.ts`), reminders.ts, gateway-checks.ts, catalog.ts, carts.ts, forms.ts, flow-json.ts and form-token.ts
  - move `formatMinor` from packages/shared/src/ads/budgets.ts to commerce/money.ts, with a re-export
  - export everything from packages/shared/src/index.ts
- [X] T014 [P] Add the 008 lists to packages/shared, with cases in each file's test (R10, R12, R14):
  - **permissions** in permissions.ts and permissions.test.ts: `payments.view` (ADMIN, MANAGER), `payments.manage` (ADMIN), `forms.manage` (ADMIN, MANAGER)
  - **API key scopes** in integrations/scopes.ts and scopes.test.ts: `payments.read`, `payments.write`, with labels
  - **event types** in integrations/events.ts and events.test.ts:
    - `payment.requested`, `payment.paid`, `payment.failed`, `payment.expired`, `payment.refunded`, `payment.cancelled` (group `payments`)
    - `chat_order.received`, `chat_order.paid` (group `commerce`)
    - `form.submitted` (group `forms`)
  - **enums** in enums.ts: the four notification types and `ConsentSource.FORM`
  - **template button types** in template-rules.ts and template-rules.test.ts:
    - new types `CATALOG`, `MPM` and `FLOW`
    - CATALOG and MPM are MARKETING with exactly one button
    - FLOW text is at most 25 characters
    - a pay link URL button's base must equal `${PUBLIC_LINK_BASE_URL}/p/` with the suffix `{{1}}`
- [X] T015 [P] Add the 008 audit actions of research R14 to apps/api/src/modules/audit/audit-actions.ts, and list them in `PENDING` in apps/api/test/unit/audit-coverage.spec.ts until their story records them
- [X] T016 Implement `StripeClient` in apps/api/src/modules/payments/stripe.client.ts with the seven calls of contracts/stripe.md:
  - **requests:** the bracketed form encoder; `Authorization`, `Stripe-Version` and `Idempotency-Key` headers; the 10 s timeout; 3 retries for network errors, 429 and 5xx with the same key; `StripeApiError {status, type, code, declineCode, param, message}`
  - **check against Stripe's 2026-09-30.endive reference and fix contracts/stripe.md:**
    - the Checkout Session create parameter names (`price_data`, `product_data`, `payment_intent_data`, `expires_at`, `locale`)
    - the account display-name fields
    - the expire answers for expired and complete sessions
    - the restricted key permission names
  - **unit tests** in apps/api/test/unit/payments/stripe-client.spec.ts (nock): every call, the encoding, retries with the same key, and error mapping
- [X] T017 Implement `MetaCommerceClient` in apps/api/src/modules/commerce/meta-commerce.client.ts:
  - **calls:** the catalog, commerce settings, `items_batch` with its status, and Flows calls of contracts/meta-commerce-graph.md
  - **errors:** the 001 error parsing (`MetaApiError`), and a 60 s back-off on code 80009
  - **check against Meta's reference and fix the contract:**
    - `product_catalogs` fields
    - the product fields `visibility`, `review_status` and `sale_price`
    - the `items_batch` maximum and price format
    - the Flows `validation_errors` fields
  - **unit tests** in apps/api/test/unit/commerce/meta-commerce-client.spec.ts (nock): each call and the errors
- [X] T018 [P] Add the test support files:
  - apps/api/test/support/fake-stripe.ts: `FakeStripe`, a stateful nock catch-all with sessions, endpoints and events, plus `event()` (signed with the test secret) and `deliver()`
  - apps/api/test/support/fake-commerce-graph.ts: `FakeCommerceGraph` with catalogs, products, commerce settings, `items_batch` and flows, in the pattern of `fake-ads-graph.ts`
  - apps/api/test/support/commerce.ts helpers: connect a test gateway, seed the catalog copy, open a conversation with a recent customer message, deliver a cart or form answer through `webhook.inbound`
- [X] T019 Create apps/api/src/modules/payments/payments.module.ts and apps/api/src/modules/commerce/commerce.module.ts, and wire them into apps/api/src/app.module.ts and apps/api/src/worker-features.module.ts:
  - each module has a global domain part (clients, request and order services used by the inbound handler and the flow engine) and an API part (controllers); queue processors are registered in the worker
  - add `'l/p/:code'` to the global prefix exclusions in apps/api/src/app.setup.ts
  - keep apps/api/test/unit/app-module.spec.ts green
- [X] T020 [P] Add `secretKey`, `secret_key_enc`, `webhookSecret`, `webhook_secret_enc` and `stripe-signature` to the redaction list in apps/api/src/common/logging/redaction.ts, with cases in apps/api/test/unit/logging-redaction.spec.ts
- [X] T021 [P] Add apps/web/src/lib/payments.ts, apps/web/src/lib/catalog.ts and apps/web/src/lib/forms.ts with:
  - types from the contracts and query keys
  - labels for statuses, display states, sources, checks, chat order states, form field types and categories
  - money display through the shared `formatMinor`
- [X] T022 [P] Add the cart and form options of contracts/meta-commerce-graph.md to tools/mock-meta/src/inbound-cli.ts:
  - `--order "<retailerId>:<qty>,…"`, priced from the seeded catalog, and `--order-price-change`
  - `--form-reply <flow_token> --answers '<json>'`

**Checkpoint**: the foundation is ready; stories can begin.

---

## Phase 3: User Story 1 - Connect the company's payment gateway (Priority: P1) 🎯 MVP

**Goal**: admins connect Stripe with checks and fixes. Keys and secrets are stored encrypted, and
notifications are proven to arrive.

**Independent Test**: quickstart US1 row: a rejected key is refused; the good key passes with Test
mode and AED; "Notifications working" appears; keys are never shown again.

### Tests for User Story 1 (write first, must fail)

- [X] T023 [P] [US1] Integration test apps/api/test/integration/payments-gateway.int-spec.ts (`FakeStripe`):
  - **saving keys:**
    - a restricted test key passes with mode TEST, aed and the account name
    - a secret key gives a KEY_KIND WARNING
    - a rejected key → 422 KEY_INVALID, nothing saved
    - charges disabled → saved as ERROR, naming the requirements
    - an account read refused → WARNING
  - **the endpoint:**
    - automatic registration posts the six events and `api_version`, and stores the secret encrypted, never returned
    - manual registration requires `whsec_…`
  - **the notification check:** the check session's `checkout.session.expired` arrives and passes; a wrong secret fails after 2 minutes (fake clock), with the fix
  - **managing:** run checks again; replace keys; disconnect deletes only the endpoint we made
  - **security:**
    - a webhook with a bad signature → 400, recorded with `signatureValid=false`, nothing changed
    - managers get 403 on PUT
    - audit entries without keys
- [X] T024 [P] [US1] Contract cases for `/payments/gateway*` and `GET /payments/settings` in a new apps/api/test/contract/commerce.contract-spec.ts
- [X] T025 [P] [US1] Playwright e2e apps/web/e2e/payments-us1-gateway.spec.ts:
  - `rk_test_mockXXnockout` is refused
  - `rk_test_mockOK1234` with automatic registration passes every check and shows Test mode and AED
  - **Test notifications** shows "Notifications working"
  - after saving, the key fields are empty and only Replace keys and Disconnect are offered

### Implementation for User Story 1

- [X] T026 [US1] Extend tools/mock-meta/src/stripe.ts with the routes of contracts/stripe.md:
  - checkout sessions: create, retrieve and expire
  - webhook endpoints: create (secret `whsec_mock…`) and delete
  - signed delivery to the registered URL or `MOCK_STRIPE_WEBHOOK_URL`
  - the `noperm` and `nockout` key rules
- [X] T027 [US1] Implement apps/api/src/modules/payments/gateway/payment-gateway.service.ts, payment-gateway.controller.ts and notification-check.ts:
  - save: checks with the shared rules; keys and secrets encrypted with `TokenCipher`
  - the endpoint, automatic or manual
  - the notification check: a check session made and expired, with a 2-minute `notification-check-timeout` job on the `payments` queue
  - run checks again, replace keys, disconnect
  - the ERROR state, notifying admins with `PAYMENTS_CONNECTION_ERROR`
  - audit entries; the `GET /payments/settings` defaults row (read-only until US2)
- [X] T028 [US1] Implement apps/api/src/modules/payments/events/stripe-webhook.controller.ts and the first part of payment-events.processor.ts:
  - verify the raw body with the shared function against the current and previous secrets
  - record rejected requests (headers and the first 2 KB)
  - store the body through `redactStripeEvent`; a repeated `stripe_event_id` is answered 200 as a duplicate
  - queue `payment-event` jobs; the processor handles check-session events (the notification check)
  - request effects come in US2
- [X] T029 [P] [US1] Add apps/web/src/app/(dashboard)/payments/gateway/page.tsx and a **Payments** item (permission `payments.view`) in apps/web/src/app/(dashboard)/layout.tsx. The page has:
  - the key form, with automatic or manual registration and the webhook URL to copy
  - the checks with their fixes
  - the notification check, polling until it passes or fails
  - a Test mode badge, Replace keys and Disconnect

**Checkpoint**: US1 runs alone.

---

## Phase 4: User Story 2 - Ask for a payment in live chat and see it paid (Priority: P1) 🎯 MVP

**Goal**: agents request payments in chat; customers pay on Stripe's page through our pay link;
statuses arrive live, expire on time, and are reconciled.

**Independent Test**: quickstart US2 row: a request for AED 150 shows Paid in the chat, on the
profile and in the journey after a mock payment; Decline shows Failed attempt; cancel shows
Cancelled.

### Tests for User Story 2 (write first, must fail)

- [X] T030 [P] [US2] Integration test apps/api/test/integration/payments-requests.int-spec.ts (`FakeStripe`):
  - **inside the window:**
    - the session is made eagerly with every parameter of contracts/stripe.md: amount, currency, both metadata places, `client_reference_id`, the clamped `expires_at`, `success_url`, key `wbm-pr-<id>-s1`
    - a `cta_url` message goes on the priority send path with our pay link (chat item `PAYMENT_REQUEST`)
    - journey `PAYMENT_REQUESTED`, event `payment.requested`
  - **outside the window:** the payment template goes through the 001 queue (origin `PAYMENTS`) with the code in `BUTTON.0.p1`, or 409 WINDOW_CLOSED_NO_TEMPLATE
  - **refusals:**
    - amount under AED 2.00 or over the maximum, the expiry bounds, the description length
    - `requestRoles` without AGENT → 403 ROLE_NOT_ALLOWED
    - gateway ERROR → 409 GATEWAY_NOT_READY
    - Stripe 5xx → 502 with nothing sent; Stripe 400 → 422 GATEWAY_REFUSED
  - **settings:** `PUT /payments/settings` refuses a template without a pay link button (TEMPLATE_NOT_PAY_LINK)
- [X] T031 [P] [US2] Integration test apps/api/test/integration/payments-lifecycle.int-spec.ts (`FakeStripe` webhooks):
  - **paid:**
    - `paidAt`, the paid amount and `paymentIntentId` are set
    - the agent gets `PAYMENT_RECEIVED`, with journey `PAYMENT_PAID` and event `payment.paid`
    - the live chat event goes out on the 002 stream
  - **duplicates and order:** a duplicate event has no second effect; an expired session after completion stays PAID
  - **failures:** `payment_intent.payment_failed` → Failed attempt with the decline code, still payable; async succeeded and failed
  - **expiry:** the tick (fake clock) → EXPIRED, the session expired at Stripe (retried up to 10 times), journey `PAYMENT_EXPIRED`, event `payment.expired`
  - **late payment:** a payment after expiry → PAID late, managers get `PAYMENT_PAID_LATE`
  - **cancel and resend:** cancel → the session expired, CANCELLED, audit `payment_request.cancelled`, event `payment.cancelled`; resend after a failed delivery
  - **other events:**
    - a `livemode` mismatch is IGNORED
    - the reconciler finds a held-back event (`/v1/events`) and applies it once with source RECONCILE
    - the fallback without Events read uses session retrieval
  - **visibility:** `GET /contacts/{id}/payments` lists the request; agents get 403 on `GET /payments/requests` but see the `payment` summary on the chat item
- [X] T032 [P] [US2] Integration test apps/api/test/integration/pay-link.int-spec.ts:
  - `/l/p/:code` → 302 to the open session
  - **an expired session on a waiting request:** the old session is expired first, then a new one is made with key `s2`, then 302
  - two opens at once make one session
  - **pages:** paid (with the `wa.me` button), expired, cancelled, paused (gateway disconnected), the `?paid=1` return page
  - **counting and limits:** opens counted except previews and robots; 429 from the rate limiter; unknown code 404
- [X] T033 [P] [US2] Contract cases in apps/api/test/contract/commerce.contract-spec.ts for:
  - `/inbox/conversations/{id}/payment-requests` and `/payments/requests/{id}` with cancel and resend
  - `PUT /payments/settings` and `/contacts/{id}/payments`
  - the webhook and `/l/p/{code}`
- [X] T034 [P] [US2] Playwright e2e apps/web/e2e/payments-us2-live-chat.spec.ts:
  - request AED 150 for "Order 1042" in a chat
  - open the link, then **Pay** on the mock page: Paid shows in the chat, on the profile's Payments tab and in the journey
  - **Decline** on a second request shows Failed attempt; cancelling shows Cancelled
  - Expiry is covered by T031 with a fake clock

### Implementation for User Story 2

- [X] T035 [US2] Implement apps/api/src/modules/payments/settings/payment-settings.service.ts and payment-settings.controller.ts:
  - the defaults row and validation
  - the `TEMPLATE_NOT_PAY_LINK` check, using the shared rule
  - audit `payments.settings_changed`
  - reminder and chat order fields are stored now and validated further in US4 and US6
- [X] T036 [US2] Implement apps/api/src/modules/payments/requests/payment-sessions.ts:
  - `ensureSession` (eager or lazy) under a row lock
  - the clamp and the `sessionsCreated` idempotency counter
  - expire-before-new; a `complete` answer applies the payment
- [X] T037 [US2] Implement apps/api/src/modules/payments/requests/payment-sender.ts:
  - **in the window:** the `cta_url` message through the 002 priority send, with the settings' text and button
  - **outside it:** the payment template through the 001 queue with origin `PAYMENTS`
  - the `payment` variable source (amount, description, reference, expires, code) in apps/api/src/modules/campaigns/variable-resolver.ts, with cases in its unit test
- [X] T038 [US2] Implement apps/api/src/modules/payments/requests/payment-requests.service.ts and payment-requests.controller.ts:
  - create from a chat (role, window and limit checks); get and list (`payments.view`)
  - cancel, which expires the session; resend
  - `GET /contacts/{id}/payments`
  - the chat item `payment` summary in the 002 chat item DTO (apps/api/src/modules/inbox/)
- [X] T039 [US2] Implement apps/api/src/modules/payments/requests/payment-effects.ts and the rest of apps/api/src/modules/payments/events/payment-events.processor.ts:
  - `applyPaymentEvent` under a row lock
  - after-commit effects:
    - notify the maker; journey entries; 006 outbound events; the 002 live stream
    - the tag, and the flow start by the 006 chat-link rule
    - `PAYMENT_PAID_LATE` to managers
  - held refunds are retried
- [X] T040 [US2] Implement apps/api/src/modules/payments/events/payments-reconcile.processor.ts: the 15-minute repeatable job reading `/v1/events` from the cursor minus 10 minutes, falling back to session retrieval when the key cannot read events
- [X] T041 [US2] Implement apps/api/src/modules/payments/tick/payments-tick.processor.ts:
  - the 60-second repeatable `payments-tick`, batches of 500 with `FOR UPDATE SKIP LOCKED`
  - expiry, with a best-effort session expire retried up to 10 times (reminders come in US4)
- [X] T042 [US2] Implement apps/api/src/modules/payments/links/pay-link.controller.ts:
  - `/l/p/:code` with its pages (our wording, no Stripe branding)
  - the 005 `LinkRateLimiter` factory
  - open counting that skips previews and robots, as in the 006 chat link redirect
- [X] T043 [P] [US2] Add the live chat parts:
  - apps/web/src/components/inbox/payment-request-dialog.tsx, opened from composer.tsx: amount, description, reference, expiry, tag and flow, with the window notice
  - the payment card in chat-item-view.tsx: status, display state, amount, copy link, cancel, resend
  - payment journey labels in journey-list.tsx
  - a Payments tab in profile-panel.tsx and on apps/web/src/app/(dashboard)/contacts/[id]/page.tsx
- [X] T044 [P] [US2] Add apps/web/src/app/(dashboard)/payments/settings/page.tsx (limits, request roles, the message text and button, the payment template with its mapping) and apps/web/src/app/(dashboard)/payments/[id]/page.tsx (status history, the message, cancel, resend)

**Checkpoint**: US2 runs alone (with US1's connection).

---

## Phase 5: User Story 3 - Payment requests from flows, campaigns, the API and store orders (Priority: P1) 🎯 MVP

**Goal**: payment requests go out from a flow step, campaigns, the public API and store orders, with
tags and flows on payment.

**Independent Test**: quickstart US3 row:
- a flow takes the paid branch
- three campaign links are matched to the right contacts
- an API request is created and read back
- a store order shows paid

### Tests for User Story 3 (write first, must fail)

- [X] T045 [P] [US3] Unit tests for the payment step:
  - in packages/shared/src/flows/graph.test.ts and validate.test.ts:
    - the `payment` step schema: amount sources `static`, `answer` and `attribute`; description; `expiryMinutes` at most 1,380; `next` and `onNotPaid`
    - the publish fact "gateway connected"
  - in apps/api/test/unit/flows/run-commerce.spec.ts, the engine:
    - the step emits a request effect and waits
    - input `payment` paid → `next`; not paid → `onNotPaid`
    - customer messages while waiting follow the 003 interrupt rules
- [X] T046 [P] [US3] Integration test apps/api/test/integration/payments-sources.int-spec.ts:
  - **flow step:**
    - the session waits; paid → the paid branch; expiry → the not-paid branch
    - a test session's request is `is_test`, and `/payments/requests/{id}/test-result` drives the branches
  - **campaign with `paymentConfig`:**
    - three recipients get three requests, made at dispatch in the recipients' transaction, with codes in the button suffix and no Stripe call until opened
    - an attribute amount; a missing amount is held back with `PAYMENT_AMOUNT_MISSING`
    - each payment is matched to its recipient
  - **store order `PAY_LINK`:**
    - an UNPAID order gets the template with the link; a COD order only with `includeCod`
    - a currency mismatch is logged with no link
    - **when paid:** the order shows paid, COD becomes CLOSED, and nock sees Shopify `orderMarkAsPaid` and WooCommerce `set_paid`; a store refusal only gives a warning
  - **tag and flow on payment:** the 006 chat-link rule holds (never over a running flow or a member's chat)
- [X] T047 [P] [US3] Integration test apps/api/test/integration/public-payments-api.int-spec.ts:
  - **create** (`POST /api/v1/payments` with `Idempotency-Key`):
    - a new contact is created
    - in the window → `cta_url`; outside → the template
    - `send: false` returns only `payUrl`
  - **idempotency:** the same key returns the same answer; a different body → 409
  - **scopes:** missing scopes → 403
  - **read and cancel:** get by id and by reference or phone; cancel
  - **events:** `payment.requested` and `payment.paid` are delivered as outbound events
- [X] T048 [P] [US3] Contract cases for the public payments routes in a new apps/api/test/contract/public-payments-v1.contract-spec.ts, and for `/payments/requests/{id}/test-result` in commerce.contract-spec.ts
- [X] T049 [P] [US3] Playwright e2e apps/web/e2e/payments-us3-sources.spec.ts:
  - a flow with a Request payment step, run from the test panel: **Mark paid (test)** takes the paid branch
  - a campaign with a pay link template to three test contacts makes three requests
  - a store order with the Pay link automation shows paid after the mock payment

### Implementation for User Story 3

- [X] T050 [US3] Add the flow payment step:
  - the schema, `FLOW_LIMITS` and publish facts in packages/shared/src/flows/graph.ts and validate.ts
  - the step and the `payment` input in apps/api/src/modules/flows/engine/run.ts and effects.ts
  - `resume` accepting `payment` in apps/api/src/modules/flows/engine/session.service.ts; requests are made through the payments domain with source FLOW, `flowSessionId`, and `is_test` for test sessions
  - the gateway fact passed by apps/api/src/modules/flows/definitions/publish.service.ts
  - the `test-result` route in payment-requests.controller.ts
- [X] T051 [US3] Add campaign payment requests:
  - validate `paymentConfig` in the campaign create and update DTOs (apps/api/src/modules/campaigns/)
  - create the requests per recipient in apps/api/src/modules/sending/dispatch-planner.ts, in the same transaction
  - the held-back reason `PAYMENT_AMOUNT_MISSING`
  - the `payment` variable source for the button suffix; opening a pay link makes the session lazily (payment-sessions.ts)
- [X] T052 [US3] Implement apps/api/src/modules/payments/public/public-payments.controller.ts:
  - the 006 API key guard, the scope decorator, the idempotency service and the rate limit
  - find or create the contact by the 006 contacts rules
- [X] T053 [US3] Add the store `PAY_LINK` automation in apps/api/src/modules/integrations/stores/store-automations.service.ts:
  - settings `includeCod` and `expiryMinutes`, with the automation's template and pay link
  - order effects from payment-effects.ts: the order shows paid and COD becomes CLOSED
  - mark paid in the store:
    - `orderMarkAsPaid` in apps/api/src/modules/integrations/stores/shopify/shopify.client.ts *(verify the mutation input and that the app has `write_orders`)*
    - `set_paid` in apps/api/src/modules/integrations/stores/woocommerce/woo.client.ts
  - a store connection warning when the store refuses
  - mock routes for both calls in tools/mock-meta/src/shopify.ts and woocommerce.ts
- [X] T054 [P] [US3] Add the web parts for these sources:
  - apps/web/src/components/flows/steps/payment-form.tsx, registered in step-form.tsx and step-node.tsx
  - **Mark paid (test)** and **Mark not paid (test)** in apps/web/src/components/flows/test-panel.tsx
  - the campaign payment config in apps/web/src/components/campaigns/wizard/mapping-step.tsx (amount fixed or from an attribute, description, expiry, tag and flow on payment), with its summary in review-step.tsx
  - the Pay link automation card on apps/web/src/app/(dashboard)/integrations/stores/[id]/page.tsx

**Checkpoint**: the MVP (US1–US3) is complete; push and check CI.

---

## Phase 6: User Story 4 - Reminders, non-payers and the payments page (Priority: P2)

**Goal**: unpaid requests get up to two reminders; non-payers can be retargeted; managers see totals
and export.

**Independent Test**: quickstart US4 row:
- five mock requests (two paid, one refunded in part, two unpaid) give the right totals
- the unpaid ones get their reminder
- the Not paid group can be sent a campaign
- the export lists every request

### Tests for User Story 4 (write first, must fail)

- [X] T055 [P] [US4] Integration test apps/api/test/integration/payments-reports.int-spec.ts:
  - **reminders:**
    - two reminders at their times through the tick (fake clock)
    - only while the request is waiting and was delivered
    - a marketing template is skipped for opted-out contacts
    - each is sent once; payment and cancel stop them
    - settings refuse a reminder at or after the expiry
  - **summary:**
    - totals by status, day (company time zone) and source, with test requests excluded
    - the status, source and agent filters
    - a refund changes the totals
  - **export:** a CSV stream with phones masked without `phones.full`, and audit `payments.exported`
  - **retargeting:** `PAID` and `NOT_PAID` groups from a campaign with a payment config
- [X] T056 [P] [US4] Contract cases for `GET /payments/requests`, `/payments/summary` and `/payments/export.csv` in apps/api/test/contract/commerce.contract-spec.ts
- [X] T057 [P] [US4] Playwright e2e apps/web/e2e/payments-us4-reports.spec.ts:
  - set a reminder in the settings
  - the payments page totals for five mock requests (two paid, one refunded in half, two waiting)
  - filters and export
  - retarget a campaign's Not paid group

### Implementation for User Story 4

- [X] T058 [US4] Add reminders to apps/api/src/modules/payments/tick/payments-tick.processor.ts:
  - due reminders are sent through the 001 queue with origin `PAYMENTS` and the 001 opt-out checks
  - `remindersSent` and `nextReminderAt` follow the shared rule
  - reminder validation in payment-settings.service.ts
- [X] T059 [US4] Implement apps/api/src/modules/payments/reports/payments-summary.service.ts and payments-export.controller.ts (aggregations, the CSV stream, masking, audit), and the list filters in payment-requests.controller.ts
- [X] T060 [US4] Add `PAID` and `NOT_PAID` to `RETARGET_GROUPS` in apps/api/src/modules/campaigns/retarget.service.ts, with their audience queries
- [X] T061 [P] [US4] Add the web parts:
  - apps/web/src/app/(dashboard)/payments/page.tsx: the period, total tiles, a by-day chart, a by-source table, the request list with filters, and export
  - the reminders section in payments/settings/page.tsx
  - `PAID` and `NOT_PAID` in apps/web/src/components/campaigns/retarget-dialog.tsx

**Checkpoint**: US4 runs alone.

---

## Phase 7: User Story 5 - Connect the Meta catalog and send products (Priority: P2)

**Goal**: admins connect the catalog (optionally filled from a store); agents send products, lists
and the catalog; managers use catalog and multi-product templates.

**Independent Test**: quickstart US5 row:
- 40 products are copied, and search finds one
- one product, a list and the catalog arrive as the right message types
- an out-of-stock product cannot be sent

### Tests for User Story 5 (write first, must fail)

- [X] T062 [P] [US5] Integration test apps/api/test/integration/catalog.int-spec.ts (`FakeCommerceGraph`):
  - **connection state:** catalogs per WABA; numbers with and without the catalog
  - **connect and copy:**
    - the first copy: 40 products, prices parsed, unsendable ones flagged
    - the hourly job marks removed products
    - a failed copy → `CATALOG_SYNC_FAILED` to admins
  - **settings:** commerce settings get and set; disconnect
  - **search:** by name and retailer id, with the sendable filter
  - **sending in the window:**
    - product, list and catalog payloads exactly as the contract (chat items `PRODUCT`, `PRODUCT_LIST`, `CATALOG`)
    - window closed → 409; a number without the catalog → 409; unsendable products → 422 naming them
  - **audit and roles:** audit `catalog.connected`, `catalog.disconnected` and `catalog.commerce_settings_changed`; agents get 403 on the connection
- [X] T063 [P] [US5] Integration test apps/api/test/integration/catalog-fill.int-spec.ts (nock store APIs plus `FakeCommerceGraph`):
  - filling from a Shopify store and from a WooCommerce store, one item per variant with the retailer id rules of R9
  - the price text; only changed items sent (hash); deletions
  - batch status polling and per-item errors
  - the 80009 back-off; audit `catalog.fill_changed`
- [X] T064 [P] [US5] Template tests:
  - apps/api/test/unit/template-payload.builder.spec.ts: the CATALOG and MPM send components with thumbnail and sections
  - apps/api/test/integration/catalog-templates.int-spec.ts:
    - creating and syncing templates with CATALOG and MPM buttons
    - the MARKETING category enforced
    - a campaign with product choices sends them
- [X] T065 [P] [US5] Contract cases for `/catalog/*` and `/inbox/conversations/{id}/products` in apps/api/test/contract/commerce.contract-spec.ts
- [X] T066 [P] [US5] Playwright e2e apps/web/e2e/commerce-us5-catalog.spec.ts:
  - connect the mock catalog, copy the products, search
  - send one product, a list with two sections, and the catalog in a chat
  - an out-of-stock product shows as unavailable in the picker

### Implementation for User Story 5

- [X] T067 [US5] Extend tools/mock-meta/src/commerce.ts with commerce settings per number, and `items_batch` with its status (`finished` on the second check, items without a price invalid)
- [X] T068 [US5] Implement apps/api/src/modules/commerce/catalog/catalog-connection.service.ts, catalog.controller.ts and catalog-sync.processor.ts:
  - connection state; connect, which starts the first copy; disconnect
  - commerce settings
  - the hourly `catalog-sync` repeatable job and the on-demand copy on the `catalog` queue
  - product search with the trigram index
  - audit entries
- [X] T069 [US5] Implement apps/api/src/modules/commerce/catalog/catalog-fill.processor.ts and the store product readers:
  - Shopify GraphQL products with variants in shopify.client.ts *(verify that the app has `read_products`)*
  - WooCommerce products and variations in woo.client.ts
  - hashing, chunked `items_batch`, status polling, and errors saved on the connection
- [X] T070 [US5] Implement apps/api/src/modules/commerce/messages/product-messages.service.ts and the inbox route:
  - product, list and catalog sends, and their chat item DTO
  - CATALOG and MPM buttons in apps/api/src/modules/templates/template-components.builder.ts and templates-sync.service.ts
  - their send components in apps/api/src/modules/sending/template-payload.builder.ts *(verify the MPM send parameters against Meta's multi-product template page)*
  - campaign product choices in the variable mapping
- [X] T071 [P] [US5] Add the web parts:
  - apps/web/src/app/(dashboard)/catalog/page.tsx (the connection, numbers with commerce settings, products with search, fill from a store with its errors) and a **Catalog** item in apps/web/src/app/(dashboard)/layout.tsx
  - apps/web/src/components/inbox/product-picker.tsx, opened from composer.tsx
  - product message rendering in chat-item-view.tsx
  - CATALOG and MPM buttons in apps/web/src/app/(dashboard)/templates/new/page.tsx and apps/web/src/components/templates/template-preview.tsx
  - product choices in apps/web/src/components/campaigns/wizard/mapping-step.tsx

**Checkpoint**: US5 runs alone.

---

## Phase 8: User Story 6 - Turn carts sent in chat into orders with a payment link (Priority: P2)

**Goal**: carts become chat orders, paid through a link sent automatically or after an agent's
review.

**Independent Test**: quickstart US6 row:
- a two-product cart becomes a chat order with the right total
- in automatic mode, the link arrives within a minute
- paying marks the order paid

### Tests for User Story 6 (write first, must fail)

- [X] T072 [P] [US6] Unit cases in apps/api/test/unit/inbox/message-parser.spec.ts: `order` messages parse to `ORDER` with the items, decimal prices, lower-case currency and the customer's text
- [X] T073 [P] [US6] Integration test apps/api/test/integration/chat-orders.int-spec.ts:
  - **a cart arrives:** the chat order has the items, names from the copy and the total
  - **automatic mode:** a `CHAT_ORDER` request and a `cta_url` message are sent inside the inbound job
  - **review mode:** the order waits; edit quantities, remove items, cancel (which cancels the request), send the link
  - **warnings:** not in the catalog, currency, mixed currencies and a changed price stop automatic links
  - **paid:** the order is PAID, gets its tag, sends events `chat_order.received` and `chat_order.paid`, and journey `CHAT_ORDER_RECEIVED`; a refund is mirrored
- [X] T074 [P] [US6] Contract cases for `/chat-orders*` in apps/api/test/contract/commerce.contract-spec.ts
- [X] T075 [P] [US6] Playwright e2e apps/web/e2e/commerce-us6-chat-orders.spec.ts:
  - a CLI cart of two products shows a chat order card in live chat
  - automatic mode: the link arrives, and paying marks the order Paid
  - review mode: edit the order and send the link
  - `--order-price-change` shows a warning

### Implementation for User Story 6

- [X] T076 [US6] Parse `order` messages in apps/api/src/modules/inbox/inbound/message-parser.ts, and route them in inbound-chat.handler.ts: to a waiting flow step once US8 adds it, otherwise to `ChatOrderService`
- [X] T077 [US6] Implement apps/api/src/modules/commerce/orders/chat-orders.service.ts and chat-orders.controller.ts:
  - the modes, with warnings from the shared `cartWarnings`
  - edits; the link through payment requests with source `CHAT_ORDER`; cancel
  - status mirroring in payment-effects.ts
  - the chat order mode, expiry and tag validated in payment-settings.service.ts
- [X] T078 [P] [US6] Add the web parts:
  - apps/web/src/components/inbox/chat-order-card.tsx (items, total, warnings, edit quantities, send link, cancel), rendered by chat-item-view.tsx
  - chat order settings in apps/web/src/app/(dashboard)/payments/settings/page.tsx
  - orders on the contact's Payments tab

**Checkpoint**: batch 2 (US4–US6) is complete; push and check CI.

---

## Phase 9: User Story 7 - WhatsApp Forms (Priority: P3)

**Goal**: managers build and publish forms; agents and templates send them; answers fill attributes,
tags and consent.

**Independent Test**: quickstart US7 row:
- a two-screen form is published and sent
- a mock answer sets the mapped attributes and the tag
- the answer appears in the form's answers list

### Tests for User Story 7 (write first, must fail)

- [X] T079 [P] [US7] Integration test apps/api/test/integration/forms.int-spec.ts (`FakeCommerceGraph`):
  - **build and check:** create, save the draft, check problems
  - **publish:**
    - the compiled Flow JSON goes to each WABA with its category as version 1
    - Meta's validation errors are mapped → 422 META_REFUSED
    - a change makes version 2 and a new Meta flow; publishing without changes → NO_CHANGES
  - **archive and delete:** archiving deprecates the flows (IN_USE when a published flow uses the form); only drafts can be deleted
  - **send:**
    - in the window with a signed token (chat item `FORM`)
    - window closed → 409; not published → 409
    - template FLOW buttons are created and sent with a token
  - **a valid answer:**
    - answers are saved and mapped attributes set by their type
    - an invalid value is kept with a problem
    - tags are added
    - a ticked opt-in → consent `FORM`; unticked → no consent
    - journey `FORM_SUBMITTED`, event `form.submitted`
  - **a forged or changed token, or another contact:** only a plain `FORM_REPLY`
  - **answers:** the list and export (audit `form_answers.exported`, masking)
  - **audit and roles:** audit `form.published` and `form.archived`; agents get 403 on manage routes
- [X] T080 [P] [US7] Contract cases for `/forms*` and `/inbox/conversations/{id}/forms` in apps/api/test/contract/commerce.contract-spec.ts
- [X] T081 [P] [US7] Playwright e2e apps/web/e2e/commerce-us7-forms.spec.ts:
  - build a two-screen form, map name and email, add a tag, publish
  - send it in a chat, and answer with the CLI using the token read from `/mock/sent`
  - the answer shows in the chat, the attributes and tag are set, and the answers list shows it

### Implementation for User Story 7

- [X] T082 [US7] Extend tools/mock-meta/src/commerce.ts with the Flows routes of contracts/meta-commerce-graph.md: create with validation, get, deprecate and delete
- [X] T083 [US7] Implement apps/api/src/modules/commerce/forms/forms.service.ts, forms.controller.ts and form-publisher.ts:
  - checks and compiling; publishing to each WABA; versions
  - mapping Meta's validation errors back to screens and fields
  - archive and deprecate
  - *(verify the `validation_errors` fields and the `${screen.<id>.form.<field>}` reference syntax with a published test flow; switch the compiler to navigate payloads if needed)*
- [X] T084 [US7] Implement apps/api/src/modules/commerce/forms/form-tokens.ts and form-answers.service.ts:
  - form tokens: HMAC with `TOKEN_ENCRYPTION_KEY` over the shared encoding
  - answers:
    - `nfm_reply` routing from inbound-chat.handler.ts
    - validation; mapping by attribute type; tags
    - consent `FORM` through the 001 `ConsentService`
    - journey entries and outbound events
  - the inbox form send route (chat item `FORM`)
  - FLOW buttons in template-components.builder.ts, templates-sync.service.ts and template-payload.builder.ts
- [X] T085 [P] [US7] Add the web parts:
  - apps/web/src/app/(dashboard)/forms/page.tsx (the list)
  - forms/[id]/page.tsx (the builder: screens, fields, options, mapping to attributes, tags, preview, check, publish, versions, archive)
  - forms/[id]/answers/page.tsx (answers and export)
  - a **Forms** item in the layout
  - apps/web/src/components/inbox/form-sender.tsx, opened from composer.tsx
  - `FORM` and `FORM_REPLY` rendering with answers and problems in chat-item-view.tsx
  - the FLOW button in the template builder

**Checkpoint**: US7 runs alone.

---

## Phase 10: User Story 8 - Commerce steps in the flow builder (Priority: P3)

**Goal**: flows send products, catalogs and forms and wait for carts and answers. The payment step
can charge the cart total.

**Independent Test**: quickstart US8 row: a flow sends a product list, waits for a cart, requests
the cart total and takes the paid branch; another flow uses a form's answers in a message. Both run
in the test panel.

### Tests for User Story 8 (write first, must fail)

- [X] T086 [P] [US8] Unit tests:
  - in packages/shared/src/flows/graph.test.ts and validate.test.ts:
    - the `product`, `catalog` and `form` step schemas
    - the `cartTotal` amount source
    - the publish facts "catalog connected" and "form published"
  - in apps/api/test/unit/flows/run-commerce.spec.ts, the engine:
    - product and catalog steps wait for an `order` input, then go to `next` with the cart in answers; a timeout → `onTimeout`
    - form steps wait for a `form` input, then go to `next` with the answers under the prefix; a timeout
    - a payment amount from `cartTotal`
- [X] T087 [P] [US8] Integration test apps/api/test/integration/flows-commerce.int-spec.ts:
  - a flow sends a product list; the cart goes to the flow (chat order mode `FLOW`, no automatic link); the payment step charges the cart total and takes the paid branch
  - a form step's answers are used in a later message
  - publishing is refused when the catalog is not connected or the form is not published
  - test sessions run with the test numbers
- [X] T088 [P] [US8] Playwright e2e apps/web/e2e/commerce-us8-flow-steps.spec.ts: build **Send product list** → **Request payment** (cart total) → **Send form**, and run it in the test panel with a CLI cart, **Mark paid (test)** and a CLI form answer

### Implementation for User Story 8

- [X] T089 [US8] Add the three steps across shared, engine and inbound:
  - **shared:** the schemas, the publish facts and the `cartTotal` source in packages/shared/src/flows/graph.ts and validate.ts
  - **engine:** the `order` and `form` inputs and the three steps in apps/api/src/modules/flows/engine/run.ts, effects.ts and session.service.ts
  - **inbound:** carts and verified answers routed to waiting sessions in inbound-chat.handler.ts
  - **sending:** through product-messages.service.ts and the form sender
  - **publishing:** the catalog and form facts passed by publish.service.ts
- [X] T090 [P] [US8] Add apps/web/src/components/flows/steps/product-form.tsx, catalog-form.tsx and form-step-form.tsx, registered in step-form.tsx and step-node.tsx, with the product and form pickers; their problems show in problems-panel.tsx

**Checkpoint**: all stories are done.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T091 [P] Add the observability of research R14:
  - metrics in apps/api/src/common/metrics/metrics.service.ts, with their instrumentation points: `wbm_payment_links_total{result}`, `wbm_payment_events_total{type,result,source}`, `wbm_payments_total{status}`, `wbm_chat_orders_total{mode}`, `wbm_form_answers_total{result}`, `wbm_catalog_sync_total{job,result}`
  - the alerts `WbmPaymentLinksFailing` and `WbmPaymentNotificationsMissing` in ops/alerts.yml, with cases in apps/api/test/unit/alerts.spec.ts
- [X] T092 [P] Extend retention and erasure, tests first:
  - **retention**, in apps/api/test/integration/retention.int-spec.ts and apps/api/src/modules/maintenance/retention.processor.ts:
    - `payment_events` after 30 days
    - `form_answers` after 12 months
    - removed catalog products 90 days after removal
    - `payment_requests` and `chat_orders` after 5 years
  - **erasure**, in apps/api/test/integration/contact-deletion.int-spec.ts and apps/api/src/modules/contacts/contact-deletion.service.ts:
    - waiting requests are cancelled, with their sessions expired
    - requests and orders keep their amounts without the contact, phone and name
    - form answers are deleted
- [X] T093 [P] Add the card-data scan for SC-004 in apps/api/test/integration/payments-no-card-data.int-spec.ts:
  - **setup:** a full payment, refund and failure run with `FakeStripe` events that carry card details (`payment_method_details.card` with last4 and brand, `billing_details`, `customer_details`)
  - **what is scanned:** every payment, order and event table, the captured logs, and the outbound event payloads
  - **what must not appear:** Luhn-valid 13–19 digit numbers, `last4`, `cvc`, card brands or the customer's address
- [X] T094 [P] Empty the 008 `PENDING` list in apps/api/test/unit/audit-coverage.spec.ts once every action is recorded
- [X] T095 [P] Add contracts/commerce-api.openapi.yaml to apps/api/test/integration/rbac.int-spec.ts, skipping `get /l/p/{code}` and `post /payments/stripe/webhook`
- [X] T096 [P] Update the docs:
  - README.md: Payments, Catalog and Forms sections (Stripe keys and the restricted key, notifications, pay links and expiry, reminders, the catalog and commerce settings, carts, forms, the commerce flow steps)
  - specs/008-commerce-payments/quickstart.md, if steps changed
  - docs/research/aisensy/feature-inventory-2026-11-19.md: mark items 3.13, 4.8, 6.12, 7.4, 8.1–8.4 and 11.8 (8.3 as payment links), and update the roadmap
- [X] T097 Run every quickstart row end to end (in CI where the machine's memory does not allow it) and record the results in specs/008-commerce-payments/checklists/release.md, with the pre-release items:
  - **Stripe:** the account verified with charges enabled; a restricted live key; the endpoint registered; "Notifications working" in live mode
  - **Meta:** the catalog connected in WhatsApp Manager; `catalog_management` on the token; the cart enabled; catalog, MPM and payment templates approved; business verification if Meta asks for it before forms can be published
  - **Shopify:** the app scopes `read_products` and `write_orders`
  - **A real test:** one small live payment (AED 2–5), refunded afterwards

---

## Dependencies & Execution Order

- **Setup (T001–T005)** → **Foundational (T006–T022)** → stories.
- **The MVP:**
  - **US1** comes first, because every payment needs the gateway.
  - **US2** needs US1.
  - **US3** needs US2 (requests, sessions, effects).
- **Batch 2:**
  - **US4** needs US2 (and US3's campaign requests for retargeting).
  - **US5** needs only the foundation.
  - **US6** needs US2 and US5.
- **Batch 3:**
  - **US7** needs only the foundation (the template FLOW button uses US5's builder changes, if they are done).
  - **US8** needs US3, US5, US6 and US7.
- Within a story: tests → mock routes → services → processors → web.
- **Polish** comes after the stories it touches.

## Parallel examples

- **Foundational:**
  - run at once: T007–T012 (shared tests), T014, T015, T018, T020, T021 and T022
  - then T013, then T016 and T017 side by side
- **US2:**
  - run at once: T030–T034
  - then T035 → T036 → T037 → T038 → T039; T040–T042 beside T039
  - T043 and T044 at any time after T038
- **US5:** run T062–T066 at once; then T067 → T068 → T069 and T070; T071 beside them.
- **US7:** run T079–T081 at once; then T082 → T083 → T084; T085 beside T083–T084.

## Implementation strategy

1. **MVP**: Setup, Foundational, US1–US3; push once and fix CI.
2. **Batch 2**: US4–US6; push once.
3. **Batch 3**: US7, US8 and Polish; push, then the release checklist.
4. Each story is independently testable through its quickstart row. Tasks are marked done only after
   CI confirms them.
