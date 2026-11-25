# Implementation Plan: Integrations and Developer Platform

**Branch**: `006-integrations-platform` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-integrations-platform/spec.md`

## Summary

Connect the platform with the company's other systems, using the market leader's documented
behaviour with our own design and wording:
- signed outbound webhooks with retries and a delivery log
- a contacts API with key permissions
- named API campaigns
- Shopify and WooCommerce order notifications, COD confirmation and cart reminders
- chat links with QR codes
- a guided number connection wizard

**Technical approach** (see research.md):
- **Webhooks:**
  - An outbox writes `outbound_events` and `webhook_deliveries` in the triggering transaction.
  - A new `webhooks-out` BullMQ queue sends them with Standard Webhooks signatures through the 003
    safe client.
  - Retries follow a schedule of about 24 hours, with fast recovery and a 5-in-flight cap per
    endpoint (R1–R3).
- **API:**
  - `scopes` on 001 API keys.
  - New `/api/v1` contact, tag, attribute, drip enrolment and API campaign routes.
  - They reuse the dashboard services, so journeys, drip events and webhook events follow (R4–R6).
- **Stores:**
  - Shopify: a Dev Dashboard app with the client credentials grant (24-hour tokens), or a legacy
    token. It uses the pinned GraphQL Admin API version, and the platform creates its own webhook
    subscriptions.
  - WooCommerce: REST v3 keys, with webhooks the platform creates.
  - Both: signed receivers, a raw event table with dedupe, a `stores` queue for processing, and a
    15-minute reconciler that repairs webhooks and fetches missed orders.
  - A 30-second `store-tick` sends COD reminders and cart reminders (R7–R11).
- **Chat links:**
  - `${PUBLIC_LINK_BASE_URL}/c/{code}` is served at `/l/c/:code` and answers 302 to `wa.me`, with
    a `(ref XXXXXX)` reference matched by the 002 inbound handler.
  - QR codes come from the `qrcode` package (R12).
- **Wizard:** Graph v27.0 `debug_token`, account and number fields, `register`, `subscribed_apps`,
  app subscriptions and a test template, with a wizard session in Redis (R13).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, the same as 001–005

**Primary Dependencies**:
- **Existing:**
  - NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, libphonenumber-js
  - Next.js 16.4, React 19.3, TanStack Query 5, Tailwind CSS 4
  - from 001–005: the dispatcher, send queues, public API guard, idempotency service and token
    encryption (001); the safe HTTP client (003); tracked links and drip events (005)
- **New:** `qrcode` 1.5.4 (MIT) with `@types/qrcode` for QR images (R12), justified under
  Complexity Tracking. Shopify and WooCommerce are called with Node's `fetch` through the safe
  lookup, so there is no SDK.

**Storage**:
- **PostgreSQL:** 15 new tables:
  - `webhook_endpoints`, `outbound_events`, `webhook_deliveries`
  - `api_campaigns`, `api_campaign_triggers`
  - `store_connections`, `store_events`, `store_automations`, `store_orders`,
    `store_order_messages`, `store_carts`, `store_cart_reminders`
  - `chat_links`, `chat_link_opens`, `chat_link_starts`
  - `number_connection_checks`
  Columns are added to `api_keys` and `messages`, and enums are extended (data-model.md).
- **Redis:**
  - queues: `webhooks-out` (deliveries and the sweep) and `stores` (store events, the reconciler,
    token refresh, `store-tick` and store actions)
  - a per-endpoint in-flight counter
  - wizard sessions (an encrypted token, 30-minute TTL)
  - the 005 link rate-limit key for chat links

**Testing**:
- **Vitest unit tests for pure logic** (in `packages/shared` and api units):
  - the Standard Webhooks signature and rotation, and the retry waits
  - event payload builders with the content setting
  - scope checks
  - API campaign value resolution
  - Shopify and WooCommerce payload mapping and stage detection
  - the phone choice
  - COD and cart state rules
  - chat link references and matching
  - wizard check rules from Graph answers
- **Integration tests per story, with nock** for stores and Meta:
  - `integrations-webhooks`, `integrations-contacts-api`, `integrations-api-campaigns`
  - `integrations-shopify`, `integrations-woocommerce`, `integrations-cod`, `integrations-carts`
  - `integrations-chat-links`, `integrations-number-wizard`
  - plus cases in `retention`, `contact-deletion`, `rbac` (reads the new contract) and audit
    coverage
- **Contract tests** against `contracts/integrations-api.openapi.yaml` and
  `contracts/public-api-v1.openapi.yaml`. Both are added to `lint:contracts`.
- **Playwright e2e per story** against mock-meta, which gains mock Shopify and WooCommerce stores,
  a request catcher, and the Meta wizard routes (R15).

**Target Platform**: the same Docker images (api/worker and web) as 001–005. Store webhooks reach
`${APP_URL}/api/integrations/...`, and chat links use the 005 public link address.

**Project Type**: web monorepo (`apps/api`, `apps/web`, `packages/shared`, `tools/mock-meta`)

**Performance Goals**:
- SC-001: 99% of events delivered within 10 s (a post-commit enqueue and 20 workers)
- SC-003: 95% of API campaign triggers handed to WhatsApp within 5 s (the 001 send path)
- SC-004: 95% of order notifications within 1 minute (acknowledge, then the queue)
- SC-007: 95% of chat link openings within 1 s (one indexed lookup and an insert, as 005 SC-001)

**Constraints**:
- **Sending:** templates only, with 001's consent rules on every new send path (API campaigns,
  store notifications, COD, carts). Cart reminders are marketing.
- **Store limits:** Shopify answers within 5 s and has 24-hour client-credential tokens; WooCommerce
  disables a webhook after more than 5 failures.
- **Security:** no secrets in logs or exports, and https-only outbound requests through the safe
  lookup. `OUTBOUND_ALLOW_LOCAL` is accepted only outside production, for local tests.
- **Machine:** the dev machine has 3.9 GB RAM, so heavy runs go to CI.

**Scale/Scope**:
- up to 20 endpoints and 300,000 events a day (a 100,000-recipient campaign's statuses)
- up to 5 stores and 5,000 orders a day
- up to 100 chat links
- about 10 new screens: webhooks with the delivery log, API key permissions, API campaigns with
  results, stores, the automation editors and results, orders and carts, chat links with QR and
  poster, and the wizard
- 8 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Result: **PASS** before research and
**PASS** after design.

- [x] **I. Official API & Policy**:
  - Every new send is a Meta-approved template through the 001 Cloud API path: API campaigns,
    order notifications, COD and cart reminders. The only free text is the COD reply, inside the
    24-hour window the customer's tap opened.
  - Marketing needs a recorded opt-in. A store's consent counts only when an admin confirms that it
    names WhatsApp (FR-027).
  - Opt-outs win on every new path, and are checked again when each message is written.
  - The kill switch is unaffected: number sending off, pausing API campaigns, and turning off
    automations.
- [x] **II. Original Product**: behaviour only; screens, wording and the poster design are ours.
  Research used Shopify, WooCommerce, Meta and Standard Webhooks public documentation, never
  AiSensy's app.
- [x] **III. Security & Privacy**:
  - **Encryption:** new secrets (webhook signing secrets, store credentials and tokens, the wizard
    token) are encrypted with the 001 token encryption, shown once, and never logged. The log
    redaction list grows.
  - **Inbound checks:** store webhooks are verified (Shopify HMAC, WooCommerce signature) before any
    processing, like Meta's.
  - **Outbound requests:** https only, the safe DNS lookup refusing private and reserved addresses,
    no redirects.
  - **Roles:** endpoints and stores are admin-only (`integrations.manage`), because endpoints get
    full numbers. Key scopes are least privilege. Agents see masked phones in results.
  - **Audit and erasure:** audit entries follow FR-057, and contact deletion follows FR-060.
- [x] **IV. Reliable Messaging**:
  - All new sends go through the persistent dispatcher and per-number queues.
  - Webhook deliveries are at least once, with an outbox, retries with backoff, `FAILED` kept and
    resend.
  - Store events are deduplicated by delivery id, and each notification is unique per order and
    kind, so there are no double sends.
  - The reconciler covers lost events, and pauses are free of duplicates.
- [x] **V. Test-First**:
  - tests are listed per story before implementation
  - Meta, Shopify and WooCommerce are mocked (nock and mock-meta), and no real store or WhatsApp
    message is used
  - CI gates are unchanged, with the new contracts added
- [x] **VI. Observability**:
  - metrics and alerts (R14)
  - logs with endpoint, store, order and campaign ids, and no payloads or secrets
- [x] **VII. Simplicity**:
  - two new queues and one small library, justified below
  - no SDKs for the stores
  - API campaign messages keep origin `API`, and only `STORE` is a new origin

## Project Structure

### Documentation (this feature)

```text
specs/006-integrations-platform/
├── plan.md              # This file
├── research.md          # R1–R15
├── data-model.md        # tables, enums, state machines, retention, audit actions
├── quickstart.md        # setup, simulations, validation rows, checks
├── contracts/
│   ├── integrations-api.openapi.yaml   # dashboard + public receivers + /l/c/{code}
│   ├── public-api-v1.openapi.yaml      # /api/v1 additions with x-scope
│   └── webhook-events.md               # outbound events, signatures, retries, tool guides
└── tasks.md             # /sp.tasks
```

### Source Code (repository root)

```text
apps/api/
├── prisma/
│   ├── schema.prisma                                   # new models and enums
│   └── migrations/20261201000000_integrations/migration.sql
├── src/common/
│   ├── logging/redaction.ts                            # secrets, credentials, signatures
│   ├── metrics/metrics.service.ts                      # R14 metrics
│   └── http/safe-http.ts                               # shared safe client (from 003 api-client), OUTBOUND_ALLOW_LOCAL
├── src/modules/integrations/
│   ├── integrations.module.ts                          # IntegrationsDomainModule (@Global) + IntegrationsApiModule
│   ├── webhooks/                                       # endpoints, outbound-events (record), delivery processor, sweep, signer
│   ├── api-campaigns/                                  # service, controller, trigger service, results
│   ├── stores/
│   │   ├── store-connections.service.ts                # connect, test, disconnect, consent
│   │   ├── shopify/                                    # client (GraphQL, token refresh), receiver, mapping
│   │   ├── woocommerce/                                # client (REST), receiver, mapping
│   │   ├── store-events.processor.ts                   # orders, carts, stages, notifications
│   │   ├── store-reconciler.processor.ts               # every 15 min: webhooks repair and fetch
│   │   ├── store-tick.processor.ts                     # every 30 s: COD and cart reminders
│   │   ├── cod.service.ts                              # button answers (called from 002 inbound)
│   │   └── automations.service.ts / results.service.ts
│   ├── chat-links/                                     # service, controller, redirect, QR, inbound matcher
│   └── number-wizard/                                  # sessions (Redis), checks, fixes, connect
├── src/modules/public-api/                             # scopes guard; contacts, tags, attributes, drips, api-campaign routes
├── src/modules/{contacts,inbox,webhooks,growth,flows,ai}/  # OutboundEvents.record hooks; COD and chat-link routing in inbound
└── test/{unit,integration,contract}/                   # per story (quickstart §4)

apps/web/src/
├── app/(dashboard)/settings/webhooks/…                 # endpoints, delivery log
├── app/(dashboard)/settings/api-keys/…                 # scopes editor (existing page)
├── app/(dashboard)/campaigns/api/…                     # API campaigns, results
├── app/(dashboard)/integrations/stores/…               # stores, automations, orders, carts
├── app/(dashboard)/campaigns/chat-links/…              # chat links, QR, poster (print page)
└── app/(dashboard)/numbers/connect/…                   # wizard

packages/shared/src/integrations/                      # signing, retry waits, events, scopes, refs, store rules (pure)
tools/mock-meta/src/                                    # shopify, woo, catch, wizard routes; npm run mock:store
tools/perf/webhooks-latency.ts, stores-latency.ts       # perf:webhooks, perf:stores
```

**Structure Decision**: the 001–005 web monorepo layout. The feature lives in one api module,
`integrations`, with a global domain module for the services other modules call
(`OutboundEvents`, `CodService`, `ChatLinkMatcher`), like `GrowthDomainModule` in 005. Public API
additions stay in the existing `public-api` module.

## Phases and order

| Phase | Content | Gate |
|---|---|---|
| Setup | Migration, enums, permission `integrations.manage`, shared safe client, config (`SHOPIFY_API_VERSION`, `OUTBOUND_ALLOW_LOCAL`), mock-meta skeletons | Typecheck, unit |
| Foundation | Outbox writer and catalog, signer, delivery processor and sweep, scopes guard, redaction, metrics | Unit and integration green |
| US1 (P1) | Webhook endpoints, hooks at every event source, log, resend, test, auto-pause, web pages | Integration, contract, e2e |
| US2 (P1) | Key scopes, contacts, tags, attributes and drip enrolment routes | Same |
| US3 (P2) | API campaigns, trigger route, self-pause, results, web | Same |
| US4 (P2) | Store connections (Shopify, WooCommerce), receivers, events processor, reconciler, notifications, web | Same |
| US5 (P2) | COD: sending, button routing, store actions, tick, results | Same |
| US6 (P3) | Carts: tracking, tick, stop rules, recovery, results | Same |
| US7 (P3) | Chat links, redirect, QR and poster, inbound matcher, results | Same |
| US8 (P3) | Wizard sessions, checks, fixes, test message, connect, health check | Same |
| Polish | Retention and erasure, audit coverage, RBAC from all contracts, alerts, perf scripts, docs (README, inventory), release checklist | All gates green in CI |

## Key decisions (ADR candidates)

| Decision | Why | Rejected |
|---|---|---|
| Outbound webhooks: Postgres outbox + BullMQ queue + Standard Webhooks signatures | At-least-once delivery without a new service; a known format for receivers | Svix or Hookdeck (personal data to another processor), inline sends, a tick |
| Stores: our own clients for Shopify (Dev Dashboard app, client credentials) and WooCommerce (REST keys), with platform-made webhooks and a reconciler | The documented single-owner path since 2026, and self-repairing | A public Shopify App Store app, manual webhooks, store SDKs |
| Chat links through our own redirect, with a reference in the pre-filled text | Openings and chat starts can be counted | Meta's QR code API (no counting) |

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `webhooks-out` queue | Per-delivery retries with backoff, and a first attempt within seconds (SC-001) | The 005 tick (30 s) misses 10 s; reusing `maintenance` would mix long retries with housekeeping |
| `stores` queue | Store events need quick acknowledgement and ordered processing, and the reconciler and tick belong to stores | Processing inside the receiver would miss Shopify's 5-second limit |
| `qrcode` dependency | Correct QR codes in SVG and PNG | Writing our own encoder is error-prone; Meta's QR API cannot count openings |
| New origin `STORE` | Store messages show as automatic in live chat and in their own results | Reusing `API` would mix them with developers' sends |
