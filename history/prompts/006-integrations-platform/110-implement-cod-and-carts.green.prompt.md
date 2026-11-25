---
id: 110
title: Implement COD And Carts
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.implement (continue)
labels: ["implement", "integrations", "cod", "carts", "shopify", "woocommerce", "nock15"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/7
files:
 - packages/shared/src/integrations/cod.ts (+ test), carts.ts (+ test), stores.ts (paid flag, checkouts, cart fields)
 - apps/api/src/modules/sending/template-payload.builder.ts (quick-reply payloads)
 - apps/api/src/modules/integrations/stores/cod.service.ts, store-tick.processor.ts, store-carts.ts
 - apps/api/src/modules/integrations/stores/store-events.processor.ts, store-automations.service.ts, stores.controller.ts, shopify/shopify.client.ts, woocommerce/woo.client.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts, inbox/automation/auto-replies.service.ts, inbox/conversations/chat-contact.service.ts
 - apps/api/src/modules/contacts/consent.service.ts, contact-deletion.service.ts
 - apps/web/src/app/(dashboard)/integrations/stores/[id]/page.tsx (COD card, cart card, carts list, COD filter)
 - tools/mock-meta/src/inbound-cli.ts (--button-payload), shopify.ts (order lookups)
 - apps/api/test/integration/integrations-cod.int-spec.ts, integrations-carts.int-spec.ts
 - apps/web/e2e/integrations-us5-cod.spec.ts, integrations-us6-carts.spec.ts, integrations-us1-webhooks.spec.ts
tests:
 - CI on PR #7 at cb6a864: every job green (unit, integration, contract, e2e), with US1 to US5
 - US6 runs in CI (083d5fa, 512ea39); local type checks, lint and 472 unit tests pass
---

## Prompt

continue

(Sent after /effort; the work went on with 006 US4, US5 and US6.)

## Response snapshot

- **US4 store orders: green in CI.**
  - The Shopify fakes first timed out. nock 15 calls a reply function with a single Fetch `Request`, and a two-parameter function is treated as a callback that never answers. The store fakes were rewritten.
  - Stores are now set aside after each test, because at most 5 can be connected.
  - The test drip is archived in `finally`.
- **US5 COD confirmation, done (T056–T062):**
  - **The question:** payloads `cod1:{orderId}:Y|N` go on the template's quick-reply buttons, and the question replaces the plain order confirmation.
  - **The answer:** the first answer wins. The reply goes through live chat, before flows and the AI agent.
  - **Store actions** run as retried jobs:
    - Shopify: tags, a metafield, and cancel when automatic cancel is on.
    - WooCommerce: a note, a meta value, and the status.
  - **Store tick:** reminders and "no answer" run on a 30-second tick.
  - **Closed first:** an order cancelled or paid in the store before the customer answers is marked CLOSED.
  - **Results and alerts:** COD counts in the results, the COD_ANSWERED journey entry, the store.cod_answered event, and an alert to admins when the customer cancels and automatic cancel is off.
  - **Web:** a COD card with replies, waits and automatic cancel, and a COD filter on orders.
- **US6 carts, implemented (T063–T068):**
  - **Carts:** Shopify checkouts and WooCommerce unpaid orders become carts.
  - **Reminders:** up to three marketing reminders, each sent once. The cart is read again at reminder time, and its link goes through a 005 tracked link.
  - **Recovery:** an order within 7 days of a reminder recovers the cart; an order before any reminder only closes it.
  - **Stops:** an opt-out, a block, or a reply on the store's number stops the cart.
  - **Expiry:** carts expire after 7 days.
  - **Deletion:** deleting a contact closes their COD questions and carts and scrubs their store data.
  - **Results and web:** cart results (per step, clicks, recovered value), the carts list, and a cart card on the store page.

## Outcome

- ✅ Impact: 006 has 63 tasks done and verified (T001–T063). US6 (T064–T068) waits for CI.
- 🧪 Tests: COD and cart integration tests, and COD and cart e2e tests, all running in CI.
- 📁 Files: see the list above.
- 🔁 Next prompts:
  - make US6 green in CI
  - US7 chat links and QR codes (T069–T076)
  - US8 number wizard (T077–T084)
  - Polish (T085–T091)
- 🧠 Reflection: when a mock or a library major version changes how callbacks are called, a two-minute local probe without the database finds the cause much faster than a CI round trip.
