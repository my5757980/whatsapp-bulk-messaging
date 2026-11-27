---
id: 122
title: Plan Commerce Payments
stage: plan
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 008-commerce-payments
branch: 008-commerce-payments
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "payments", "stripe", "catalog", "whatsapp-flows", "commerce"]
links:
  spec: specs/008-commerce-payments/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/008-commerce-payments/plan.md
 - specs/008-commerce-payments/research.md
 - specs/008-commerce-payments/data-model.md
 - specs/008-commerce-payments/quickstart.md
 - specs/008-commerce-payments/contracts/commerce-api.openapi.yaml
 - specs/008-commerce-payments/contracts/public-payments-v1.openapi.yaml
 - specs/008-commerce-payments/contracts/stripe.md
 - specs/008-commerce-payments/contracts/meta-commerce-graph.md
 - CLAUDE.md
tests:
 - none (planning)
---

## Prompt

haaa

(The user's yes to "/sp.plan" next. Claude ran /sp.plan with this input:)

Follow the 001-007 stack and patterns (NestJS api and worker, Prisma migrations, BullMQ, Next.js pages, zod, shared pure rules with unit tests, mock-meta and nock fakes, encrypted credentials, audit, retention, metrics). Research and cite current official docs for: Stripe in the UAE (AED, Payment Links vs Checkout Sessions for one-off per-customer amounts, expiry, metadata, webhooks with signature verification and event types, idempotency keys, test mode, refunds and partial refunds as events, restricted keys); the Meta catalog for WhatsApp (catalog linked to the WABA, reading products, Catalog Batch API to fill it from stores, single-product, multi-product and catalog messages, catalog and MPM templates, the inbound order message); and WhatsApp Flows (Flow JSON for static forms, create/update/publish via the Graph API, flow messages and template flow buttons, nfm_reply responses). Prefer no new dependency unless it clearly pays (consider the official stripe SDK vs plain HTTPS). Keep the plan batch-friendly for delivery in the order US1-US3, US4-US6, US7-US8 with polish.

## Response snapshot

- **Research (R1–R14, with sources from Stripe and Meta docs read 2026-11-25):**
  - **Stripe client:** a thin `StripeClient` over fetch, with no SDK.
    - Pinned version `2026-09-30.endive`, idempotency keys, a restricted key.
  - **Pay links:** our `/l/p/:code` link sits in front of Checkout Sessions.
    - Sessions are made eagerly for single requests and lazily for campaigns.
    - A session lasts 30 minutes to 24 hours; a new one is made while the request is still valid.
    - Only one session can be paid at a time.
    - Payment Links were rejected: a Price and Product per request, and links never expire on their own.
  - **Webhooks and the connection check:**
    - Signatures are checked by hand (`t.v1`, HMAC-SHA256, 300 s).
    - Each event is stored once by its id; a 15-minute `/v1/events` reconciler catches missed ones.
    - Connecting proves notifications work with a session that is made and expired at once.
  - **Timing:** a 60-second tick handles expiry and reminders.
  - **Catalog:**
    - Read from the WABA, copied hourly, filled from 006 stores with `items_batch`.
    - Commerce settings per number.
  - **Messages:** product, product list, catalog, cta_url and flow messages; CATALOG, MPM and FLOW template buttons.
  - **Carts:** inbound `order` messages become chat orders, in automatic or review mode.
  - **Forms:** our form model is compiled to Flow JSON 7.3, published in one call, and answers come back with signed flow tokens.
  - **Flow builder:** four steps and three engine inputs.
  - **Cross-cutting:** roles, audit, retention, metrics and fakes.
- **Plan:**
  - Summary, technical context, a constitution check (all pass) and the structure.
  - Two new modules, `payments` and `commerce`; no new dependency.
  - Delivery batches: US1–US3, US4–US6, then US7–US8 with polish.
- **Data model:** 10 new tables, enum changes, state transitions, validation, retention.
- **Contracts:** the dashboard OpenAPI, the public payments API, `stripe.md` with the mock gateway, and `meta-commerce-graph.md` with mock-meta.
- **Quickstart.**
- **CLAUDE.md:** the 008 technology and recent-change entries.
- Main CI after the 007 merge finished green (all 4 jobs).

## Outcome

- ✅ Impact: 008 is planned and ready for /sp.tasks.
- 🧪 Tests: none at this stage; the test plan is in plan.md.
- 📁 Files: plan, research, data model, quickstart, four contracts, CLAUDE.md.
- 🔁 Next prompts: /sp.tasks.
- 🧠 Reflection: field names marked *(verify)* need checking against the live references (MPM send params, the catalog product fields, Flow JSON global references, the restricted key account permission).
