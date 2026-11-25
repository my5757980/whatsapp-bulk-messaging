---
id: 109
title: Implement API Campaigns And Stores
stage: green
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.implement (continue)
labels: ["implement", "integrations", "api-campaigns", "shopify", "woocommerce", "ci-fixes", "draft-pr"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/7
files:
 - packages/shared/src/integrations/api-campaigns.ts (+ test)
 - packages/shared/src/integrations/stores.ts (+ test)
 - packages/shared/src/enums.ts
 - apps/api/src/modules/integrations/api-campaigns/*
 - apps/api/src/modules/public-api/public-api-campaigns.controller.ts
 - apps/api/src/modules/integrations/stores/* (clients, receivers, inbox, messages, processor, reconciler, services, controller)
 - apps/api/src/modules/integrations/webhooks/outbound-events.ts
 - apps/api/src/modules/integrations/webhooks/platform-events.ts
 - apps/api/src/modules/growth/drips/drip-events.ts
 - apps/api/src/modules/contacts/contacts.service.ts
 - apps/api/src/modules/numbers/numbers.service.ts
 - apps/api/src/modules/webhooks/handlers/template-status.handler.ts
 - apps/api/src/modules/inbox/messages/chat-timeline.service.ts
 - apps/web/src/app/(dashboard)/campaigns/api/*
 - apps/web/src/app/(dashboard)/integrations/stores/*
 - tools/mock-meta/src/shopify.ts, woocommerce.ts, store-cli.ts
 - apps/api/test/integration/integrations-api-campaigns.int-spec.ts, integrations-shopify.int-spec.ts, integrations-woocommerce.int-spec.ts
 - apps/web/e2e/integrations-us3-api-campaigns.spec.ts, integrations-us4-store-orders.spec.ts
 - .gitleaks.toml
 - specs/006-integrations-platform/contracts/*.yaml, data-model.md, tasks.md
tests:
 - shared unit tests for API campaign and store rules pass locally
 - api unit tests 471/471; api and web type checks and lint clean
 - CI on PR #7 at 309c150: all integration and contract tests passed (US1 to US3); e2e 41/42 (US2 tag check fixed in 50a71ae)
---

## Prompt

continue

(Sent after /model and /effort; the work went on with 006 US3 and US4.)

## Response snapshot

- **Draft PR #7 opened** once the GitHub connection worked again.
- **First CI runs found these problems, now fixed:**
  - **Transaction timeout:** the status handler's transaction loaded the webhook endpoint list on a second pool connection and timed out. The list is now read on the caller's transaction.
  - **Tests sharing data:** tests saw each other's endpoints and active drips. Each test now uses only its own deliveries, removes its endpoints, and archives its drips.
  - **Wrong starting consent:** an opt-in test started from an opted-in contact.
  - **Delivery log contract:** the contract did not allow test.ping deliveries in the log.
  - **Secret scan:** it flagged the placeholder key in the call example and made-up test keys. These are now allowlisted, and the call example uses $WBM_API_KEY.
  - **US2 e2e:** it now reads the tags from the contact page's tags field.
- **US3 API campaigns (T034–T041), done:**
  - shared rules for names, value sources and the daily-limit day
  - dashboard routes for draft, live (with checks), pause, stop, results per day and CSV export
  - the trigger route, with a trigger row for every call
  - self-pause on template and number changes, with an alert
  - web pages
  - CI green on the API side, and its e2e passed
- **US4 store orders (T042–T055), implemented and in CI:**
  - shared order mapping, stages, phone choice and the stale rule
  - mock stores and `npm run mock:store`
  - Shopify and WooCommerce clients and signed receivers
  - the raw event store
  - an order processor that sends each stage at most once and remembers stages turned off
  - a reconciler with token renewal, webhook repair, missed-order fetch and ERROR after three failed checks
  - routes, automations, results and orders
  - the STORE chat origin, the ORDER_PLACED journey entry and drip events
  - web pages and the Integrations navigation item

## Outcome

- ✅ Impact: 006 is at 55 of 91 tasks, with US1–US3 verified in CI.
- 🧪 Tests: the US4 tests run in CI on PR #7.
- 📁 Files: see the list above.
- 🔁 Next prompts:
  - make US4 green in CI
  - US5 COD confirmation
  - US6 carts
  - US7 chat links
  - US8 number wizard
  - Polish
- 🧠 Reflection:
  - Tests that share one database must remove what they create: endpoints, active drips (20 at most) and connected stores (5 at most).
  - A transaction must never wait on a second pool connection.
