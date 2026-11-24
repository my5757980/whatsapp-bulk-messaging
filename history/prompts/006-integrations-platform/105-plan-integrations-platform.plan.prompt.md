---
id: 105
title: Plan Integrations Platform
stage: plan
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "integrations", "webhooks", "shopify", "woocommerce", "public-api", "chat-links", "number-wizard", "research"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/006-integrations-platform/plan.md
 - specs/006-integrations-platform/research.md
 - specs/006-integrations-platform/data-model.md
 - specs/006-integrations-platform/quickstart.md
 - specs/006-integrations-platform/contracts/integrations-api.openapi.yaml
 - specs/006-integrations-platform/contracts/public-api-v1.openapi.yaml
 - specs/006-integrations-platform/contracts/webhook-events.md
 - specs/006-integrations-platform/spec.md
 - CLAUDE.md
tests:
 - redocly lint of both new contracts: valid (warnings only, like 001–005)
---

## Prompt

haaa agayyycontinue karooo kaam

(This continues the same user message after the spec, PHR 104. Claude ran /sp.plan with: "006-integrations-platform: plan from specs/006-integrations-platform/spec.md on the existing stack (NestJS api and worker, Prisma/Postgres, BullMQ/Redis, Next.js web). Research current Shopify and WooCommerce access and webhook docs for a single store owner, Meta Graph API permissions and checks for the number wizard, webhook signing and retry design, and wa.me chat links.")

## Response snapshot

**Research findings (public docs):**
- **Shopify:**
  - New admin custom apps stopped on 2026-01-01. An app in the company's own Dev Dashboard organization gets 24-hour tokens through the client credentials grant, renewed by the worker; legacy static tokens are still accepted.
  - Webhooks are signed with base64 HMAC-SHA256 using the client secret, and deduplicated on `X-Shopify-Webhook-Id`.
  - Shopify retries 8 times over 4 hours and removes API-made subscriptions after repeated failures, so a reconciler is needed.
  - Checkout payloads can lack customer data, so carts are fetched again.
- **WooCommerce:**
  - REST v3 keys, and webhooks signed with base64 HMAC-SHA256.
  - A webhook is disabled after more than 5 failures, and missed events are lost.
  - Core has no abandoned cart event, so WooCommerce cart reminders cover unpaid orders. The spec's Assumptions were updated.
- **Meta:**
  - `debug_token` granular scopes give the WABA ids.
  - `register` takes a PIN, and `subscribed_apps` subscribes the app.
  - `messaging_limit_tier` is deprecated; limits belong to the business portfolio since 2025-10-07 (`whatsapp_business_manager_messaging_limit`).
  - Cart reminders are marketing templates; order updates are utility.
- **Webhooks:** the Standard Webhooks format (id.timestamp.body HMAC, `whsec_` secrets, two signatures while rotating).

**Plan:**
- **Webhooks:** a Postgres outbox, a `webhooks-out` BullMQ queue, the 003 safe client, retries over about 24 hours with fast recovery, a 5-in-flight cap per endpoint, and auto-pause.
- **API:** API key scopes; new `/api/v1` contact, tag, attribute, drip and API campaign routes on the dashboard services.
- **Stores:** a `stores` queue for signed receivers, a raw event table, idempotent processing, a 15-minute reconciler and a 30-second `store-tick` for COD and carts.
- **Chat links:** `/l/c/:code` with a `(ref XXXXXX)` reference, and the `qrcode` 1.5.4 library.
- **Wizard:** Graph v27.0 checks and fixes, with a Redis wizard session.
- **Design files:**
  - data-model.md: 15 tables, enums, state machines, retention and audit actions
  - contracts: the dashboard API, the public v1 additions with `x-scope`, and the event catalog
  - quickstart.md: setup, simulations, 8 validation rows and troubleshooting
- **Constitution Check:** PASS before research and after design.
- **ADR candidates:** recorded in the plan (outbox webhooks; store clients and reconciler; chat link redirect).
- **CLAUDE.md:** gets the 006 Active Technologies and Recent Changes lines.

## Outcome

- ✅ Impact: 006 is planned and ready for `/sp.tasks`.
- 🧪 Tests: both contracts lint as valid.
- 📁 Files: listed above.
- 🔁 Next prompts: `/sp.tasks` for 006. An ADR for the integration architecture is possible (`/sp.adr integrations-architecture`) if the user wants it.
- 🧠 Reflection: platform docs changed a lot in 2025–2026 (Shopify custom apps, Meta messaging limits), and checking them stopped the plan from building on outdated ways.

## Evaluation notes (flywheel)

- Failure modes observed:
  - YAML flow maps broke on unquoted descriptions with commas or braces (fixed)
  - the context script added a weak Active Technologies line (replaced by hand)
- Graders run and results (PASS/FAIL): redocly lint PASS (after fixes); Constitution Check PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): quote every description in flow-style YAML maps.
