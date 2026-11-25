# Implementation Plan: Commerce and Payments over WhatsApp

**Branch**: `008-commerce-payments` | **Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-commerce-payments/spec.md`

## Summary

Take payments and sell products inside WhatsApp, matching the documented behaviour of the market
leader with our own design and wording:
- **Payments:**
  - Stripe payment links (UAE, AED) with signed notifications
  - requests from live chat, flows, campaigns, the public API and store orders
  - statuses, reminders and non-payer retargeting
  - a payments page and payment history
- **Catalog:** the company's Meta catalog with product, product list and catalog messages and
  templates. Carts sent in chat become orders with a payment link.
- **Forms:** WhatsApp Forms (Meta WhatsApp Flows) whose answers fill contact attributes and tags.
- **Flow builder:** four new steps (product, catalog, payment, form).

**Technical approach** (see research.md):
- **Stripe:**
  - a thin `StripeClient` (no SDK) on the pinned `STRIPE_API_VERSION` 2026-09-30.endive, with a
    restricted key stored with the 001 `TokenCipher` (R1)
  - customers get **our** link `${PUBLIC_LINK_BASE_URL}/p/{code}` (served at `/l/p/:code`), which
    sends them to a Stripe Checkout Session:
    - the first session is made eagerly for single requests and lazily for campaigns
    - a new session is made after the 24-hour session limit while the request is still valid
    - only one session can be paid at a time (R2)
- **Notifications:**
  - `POST /api/payments/stripe/webhook` checks the `Stripe-Signature` header by hand, stores each
    event once by its id, and applies it on a new `payments` queue
  - a 15-minute reconciler reads `/v1/events` to catch missed notifications (R3)
  - connecting registers the webhook endpoint when the key allows, and proves notifications arrive
    with a check session that is made and expired at once (R4)
- **Due times:** a 60-second `payments-tick` runs expiries and up to two template reminders from due
  times in Postgres (the 005 drip pattern, R6).
- **Meta:** new calls go through a thin `MetaCommerceClient` on the pinned Graph version (v27.0)
  with the 001 system user token:
  - **catalog:** the WABA's catalog, an hourly product copy, `items_batch` filling from 006 stores,
    and commerce settings (R8, R9)
  - **messages:** interactive `product`, `product_list`, `catalog_message`, `cta_url` and `flow`
    messages, plus CATALOG, MPM and FLOW template buttons (R10, R12)
  - **forms:** our own form model compiled to Flow JSON 7.3 and published with one
    `POST /{WABA_ID}/flows` per version; signed `flow_token`s map `nfm_reply` answers back (R12)
- **Inbound:** the 002 parser learns `order` (carts become chat orders, R11) and maps `nfm_reply` to
  its form.
- **Flow builder:** the 003 graph and engine gain four steps and three inputs: order, form and
  payment (R13).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, the same as 001–007

**Primary Dependencies**:
- **Existing:**
  - NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, libphonenumber-js
  - Next.js 16.4, React 19.3, TanStack Query 5, Tailwind CSS 4
  - from earlier features:
    - 001: `TokenCipher`, the send queue, templates and variable mapping, attributes, consent and
      retention
    - 002: live chat, the composer, the journey and priority sends
    - 003: the flow graph, engine and test panel
    - 005: link codes, the link rate limiter, retarget groups and the drip tick
    - 006: stores, outbound events, the public API with idempotency, and API key scopes
- **New:** none.
  - Stripe and Graph calls use Node's `fetch`.
  - Signatures and tokens use `node:crypto`.

**Storage**:
- **PostgreSQL:** 10 new tables:
  - `payment_gateways`, `payment_settings`, `payment_requests`, `payment_events`
  - `catalog_connections`, `catalog_products`, `chat_orders`
  - `forms`, `form_versions`, `form_answers`

  New columns on `campaigns` (`payment_config`) and extended enums (data-model.md).
- **Redis:** the `payments` and `catalog` queues, and the 005 link rate-limit keys for pay links.
- **Object storage:** none new. Product images stay at Meta and in the stores.

**Testing**:
- **Vitest unit (shared):**
  - money and limits
  - payment status ranking and `applyPaymentEvent`
  - the Stripe signature check
  - reminder due times
  - pay link page states
  - cart totals and warnings
  - catalog price parsing and sendability
  - product message limits
  - form checks and `compileFlowJson`
  - `flow_token` signing
  - commerce step schemas and publish checks
- **Vitest integration** (api, with the nock fakes `FakeStripe` and `FakeCommerceGraph`):
  - **gateway:** checks and the notification check
  - **requests:** from each source, with eager and lazy sessions
  - **notifications:** webhooks (duplicates, out of order, bad signatures, test mode) and the
    reconciler
  - **lifecycle:** expiry, reminders, cancellation, paid late, refunds
  - **store orders:** pay links and marking orders paid
  - **catalog:** sync and fill
  - **commerce:** product messages, carts in both modes, forms and answers, flow steps
  - **cross-cutting:** permissions, audit, retention and erasure
- **Contract:**
  - `contracts/commerce-api.openapi.yaml` (dashboard) and `contracts/public-payments-v1.openapi.yaml`
    (public API)
  - RBAC reads the dashboard contract and skips `get /l/p/{code}` and `post /payments/stripe/webhook`
  - **Updates to earlier contracts:**
    - 002 inbox: chat items carry `payment`, `chatOrder` and `form` summaries
    - 001 campaigns: `paymentConfig` and product choices
    - 005: the `PAID` and `NOT_PAID` retarget groups
    - 006 events: the new event types
- **Playwright e2e** on mock-meta, with `tools/mock-meta/src/stripe.ts` and `src/commerce.ts`:
  - connect Stripe
  - request and pay in live chat
  - a flow payment branch
  - payments page totals and a reminder
  - the catalog and product messages
  - a cart to a paid order
  - build, publish, send and answer a form
  - commerce steps in the test panel

**Target Platform**: the same Docker images and processes (api, worker, web) as 001–007

**Project Type**: web application (the existing monorepo)

**Performance Goals**:
- **SC-001** (a request reaches the customer within 10 seconds): one Stripe call plus a 002 priority
  send.
- **SC-002** (statuses within 1 minute): webhooks applied by queue jobs, live through the 002 SSE
  stream.
- **SC-005** (cart links within 1 minute): handled inside the inbound job.
- **SC-006** (500 products in 5 minutes, search under 2 seconds): paged reads and a trigram index.
- **SC-007** (answers within 1 minute): handled inside the inbound job.
- **SC-008** (reminders within 5 minutes): the 60-second tick.

**Constraints**:
- **Stripe:**
  - Checkout Sessions last at most 24 hours
  - the minimum charge is AED 2.00
  - API rate limits apply, which is why campaign sessions are lazy
  - a verified Stripe account for the UAE business is needed
- **Meta:**
  - one catalog per WABA, connected in WhatsApp Manager
  - the cart must be on
  - catalog and MPM templates are marketing templates
  - Flows publishing may need business verification *(verify; release checklist)*
  - the system user token needs `catalog_management`

**Scale/Scope**:
- one Stripe account
- hundreds of payment requests a day, campaigns of up to 50,000 recipients
- catalogs of up to 10,000 products
- tens of forms, thousands of answers a month

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0):

- [x] **I. Official API & Policy**:
  - Only Stripe's documented v1 API and Meta's documented Cloud, Graph catalog and Flows APIs are
    used, each on its pinned version.
  - Free-form commerce messages are sent only in the 24-hour window. Outside it, approved templates
    go through the 001 send checks.
  - Catalog and MPM templates are marketing templates and need opt-in. Opt-out wins on every send
    path, including reminders.
  - Native WhatsApp Payments is not used (not offered in the UAE).
- [x] **II. Original Product**: behaviour comes from public documentation only; screens, labels,
  message texts and the form builder are our own.
- [x] **III. Security & Privacy**:
  - Card data never reaches the platform: Stripe's hosted page takes it.
  - Keys and webhook secrets are encrypted, never shown again, never logged and never sent in events.
  - A restricted key is recommended.
  - Webhooks are verified with a timestamp tolerance, and rejected ones are recorded.
  - `flow_token`s are signed and bound to the contact.
  - Audit entries cover every sensitive change. Phones are masked in exports.
  - Erasure clears personal details from payment records and deletes form answers.
- [x] **IV. Reliable Bulk Messaging**:
  - Template sends use the 001 queue and limits.
  - Stripe POSTs carry idempotency keys and are retried.
  - Notifications are stored before processing and deduplicated by event id, with a reconciler as
    backup.
  - Campaign sessions are lazy, so dispatch never waits on Stripe.
- [x] **V. Test-First**: unit, integration (nock), contract and e2e (mock gateway and mock-meta)
  tests are written before each story's code. Stripe and Meta are never called in tests.
- [x] **VI. Observability**:
  - structured logs with correlation ids
  - metrics `wbm_payment_links_total`, `wbm_payment_events_total`, `wbm_payments_total`,
    `wbm_chat_orders_total`, `wbm_form_answers_total`, `wbm_catalog_sync_total`
  - alerts `WbmPaymentLinksFailing` and `WbmPaymentNotificationsMissing`
- [x] **VII. Simplicity**:
  - no new dependency
  - one gateway and one catalog
  - one payment request model for every source
  - static forms only (no Flows endpoint)
  - existing roles plus three permissions

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker. Customer money stays in the Stripe account's currency (AED); the
platform's own costs stay in USD.

## Project Structure

### Documentation (this feature)

```text
specs/008-commerce-payments/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── commerce-api.openapi.yaml   # dashboard routes, the pay link and the Stripe webhook
│   ├── public-payments-v1.openapi.yaml  # /api/v1/payments (payments.read, payments.write)
│   ├── stripe.md                   # the Stripe calls and events used, and mock gateway behaviour
│   └── meta-commerce-graph.md      # catalog, product and flow messages, Flows API, mock-meta
├── checklists/requirements.md
└── tasks.md             # /sp.tasks
```

### Source Code (repository root)

```text
packages/shared/src/commerce/
├── money.ts              # currency exponents, minor units, formatting (formatMinor moves here)
├── payments.ts           # limits, statuses, ranking, applyPaymentEvent, display states
├── stripe-signature.ts   # Stripe-Signature parsing and verification (node:crypto)
├── reminders.ts          # nextReminderAt and reminder rules
├── gateway-checks.ts     # Stripe connection check rules
├── catalog.ts            # parseCatalogPrice, isSendableProduct, COMMERCE_LIMITS
├── carts.ts              # cart totals and warnings
├── forms.ts              # form model schema, FORM_LIMITS, formChecks
├── flow-json.ts          # compileFlowJson (Flow JSON 7.3)
└── form-token.ts         # flow_token encoding (signing in the api)
packages/shared/src/flows/graph.ts, validate.ts     # product, catalog, payment and form steps, publish facts
packages/shared/src/integrations/events.ts, scopes.ts  # payment, chat order and form events; payments scopes
packages/shared/src/permissions.ts, enums.ts, template-rules.ts  # permissions, enums, CATALOG/MPM/FLOW buttons

apps/api/src/modules/payments/
├── payments.module.ts                   # domain (global) and API modules, queue processors
├── stripe.client.ts                     # thin Stripe client
├── gateway/payment-gateway.service.ts, payment-gateway.controller.ts, notification-check.ts
├── settings/payment-settings.service.ts, payment-settings.controller.ts
├── requests/payment-requests.service.ts, payment-requests.controller.ts, payment-sessions.ts, payment-sender.ts, payment-effects.ts
├── links/pay-link.controller.ts         # /l/p/:code and its pages
├── events/stripe-webhook.controller.ts, payment-events.processor.ts, payments-reconcile.processor.ts
├── tick/payments-tick.processor.ts      # expiry and reminders
├── reports/payments-summary.service.ts, payments-export.controller.ts
└── public/public-payments.controller.ts # /api/v1/payments
apps/api/src/modules/commerce/
├── commerce.module.ts
├── meta-commerce.client.ts              # catalog, commerce settings, items_batch, flows
├── catalog/catalog-connection.service.ts, catalog.controller.ts, catalog-sync.processor.ts, catalog-fill.processor.ts
├── messages/product-messages.service.ts # product, list and catalog sends (inbox and flows)
├── orders/chat-orders.service.ts, chat-orders.controller.ts
└── forms/forms.service.ts, forms.controller.ts, form-publisher.ts, form-answers.service.ts, form-tokens.ts

apps/api/src/modules/inbox/inbound/message-parser.ts, inbound-chat.handler.ts  # order, form answers
apps/api/src/modules/inbox/                     # composer: request payment, products, forms
apps/api/src/modules/flows/engine/              # commerce steps and inputs
apps/api/src/modules/campaigns/                 # paymentConfig, product choices, PAID/NOT_PAID groups
apps/api/src/modules/sending/template-payload.builder.ts  # CATALOG, MPM, FLOW buttons and the pay link suffix
apps/api/src/modules/integrations/stores/       # PAY_LINK automation, mark paid in the store
apps/api/src/modules/public-api/                # payments scopes and routes
apps/api/src/app.setup.ts                       # exclude 'l/p/:code' from the api prefix
apps/api/prisma/schema.prisma + migration 20261203000000_commerce_payments

apps/web/src/app/(dashboard)/payments/
├── page.tsx              # totals, list and filters, export
├── gateway/page.tsx      # Stripe connection, checks and the notification check
├── settings/page.tsx     # limits, roles, texts, templates, reminders, chat order mode
└── [id]/page.tsx         # one request: status history, message, cancel and resend
apps/web/src/app/(dashboard)/catalog/page.tsx      # connection, numbers, commerce settings, products, fill
apps/web/src/app/(dashboard)/forms/page.tsx, forms/[id]/page.tsx, forms/[id]/answers/page.tsx
apps/web/src/components/inbox/      # request payment, product picker, form sender, chat order card, payment card
apps/web/src/components/contacts/   # payment history
apps/web/src/components/flows/      # four step editors, test panel buttons
apps/web/src/components/campaigns/  # payment config, product choices

tools/mock-meta/src/stripe.ts       # Stripe API, hosted page and signed webhooks
tools/mock-meta/src/commerce.ts     # catalogs, products, items_batch, commerce settings, flows
tools/mock-meta/src/inbound-cli.ts  # --order, --form-reply
```

**Structure Decision**: the existing monorepo with two new modules:
- **`payments`:** Stripe, payment requests, the pay link and notifications.
- **`commerce`:** catalog, product messages, chat orders and forms.

Each is split into a global domain part, used by the worker's inbound handler and the flow engine,
and an API part (controllers). Queue processors live in `WorkerFeaturesModule`, as in 002–007.

## Delivery order

1. **Foundation**:
   - schema and migration, enums
   - shared rules (money, payments, signature, carts, catalog, forms)
   - `StripeClient`, `MetaCommerceClient`
   - the fakes, plus the mock-meta Stripe and commerce routes
   - the `payments` and `catalog` queues
   - permissions, scopes, events and audit actions
2. **Batch 1 (MVP)**:
   - **US1 Gateway** (P1): connection, checks and the notification check.
   - **US2 Live chat** (P1): the request, the pay link, webhooks, statuses, expiry and the
     contact's history.
   - **US3 Other sources** (P1): campaigns, the public API, store orders, and the flow **payment**
     step with static, answer or attribute amounts.
3. **Batch 2**:
   - **US4** (P2): reminders, PAID/NOT_PAID groups, the payments page and export.
   - **US5** (P2): catalog connection, copy, fill, product messages, CATALOG and MPM templates.
   - **US6** (P2): carts to chat orders in automatic and review modes.
4. **Batch 3**:
   - **US7 Forms** (P3).
   - **US8 Steps** (P3): product, catalog and form steps, and the payment step's cart-total amount.
   - **Polish**: metrics and alerts, retention and erasure, RBAC, docs and the release checklist.

Stories are pushed in these three batches so CI checks several at once.

## Complexity Tracking

No constitution violations. Three deliberate choices:

| Choice | Why | Simpler option rejected because |
|---|---|---|
| Our pay link in front of Stripe Checkout | Expiry up to 30 days and cancellation are ours. Template buttons need a fixed base URL. Clicks are counted. Only one session can be paid at a time. | Stripe Payment Links need a Price and Product per request and never expire on their own. Raw Checkout URLs expire within 24 hours and are too long for template buttons. |
| A reconciler beside webhooks | Missed notifications (our endpoint down longer than Stripe retries) would leave paid requests waiting. | Webhooks alone give no signal when deliveries stop. |
| Our own form model compiled to Flow JSON | Managers build forms in plain fields and screens. Publishing makes versions that answers stay linked to. | Editing raw Flow JSON is not usable by managers and cannot be checked before Meta sees it. |
