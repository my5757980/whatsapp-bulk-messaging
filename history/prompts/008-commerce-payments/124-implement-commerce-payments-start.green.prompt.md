---
id: 124
title: Implement Commerce Payments Start
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 008-commerce-payments
branch: 008-commerce-payments
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "payments", "stripe", "catalog", "setup", "foundational"]
links:
  spec: specs/008-commerce-payments/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/common/config/config.ts
 - .env.example
 - .github/workflows/ci.yml
 - apps/api/src/common/queue/queue.constants.ts
 - package.json
 - apps/api/test/contract/openapi-validator.ts
 - tools/mock-meta/src/stripe.ts
 - tools/mock-meta/src/commerce.ts
 - tools/mock-meta/src/server.ts
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261203000000_commerce_payments/migration.sql
 - packages/shared/src/commerce/*.test.ts (money, payments, stripe-signature, reminders, gateway-checks, catalog, carts)
tests:
 - mock-meta typecheck passed
 - prisma validate and generate passed
 - shared commerce tests written (failing until T013)
---

## Prompt

haaaaa

(The user's yes to "/sp.implement". Claude ran /sp.implement with this input:)

Start with Setup, Foundational and the MVP batch (US1-US3), test-first; push the batch once and fix CI; then US4-US6, then US7-US8 with Polish.

## Response snapshot

- **Setup:**
  - T001–T003: the Stripe settings, the `payments` and `catalog` queues, and the contract lint and registry.
  - T004–T005: the mock Stripe (keys, Checkout Sessions, webhook endpoints, events, a fake payment page, signed delivery, control routes) and the mock commerce routes (catalog, products, commerce settings, items_batch, Flows, interactive limits), mounted in mock-meta. The typecheck passes.
- **Foundational:**
  - T006: the schema and migration `20261203000000_commerce_payments`, with 10 tables, enums and the hand-written SQL tail. `prisma generate` runs.
  - The shared unit tests for money, payments, the Stripe signature, reminders, gateway checks, catalog and carts are written (part of T007–T011).
- The usage limit was reached mid-way. Nothing was pushed; the work is committed locally on the branch.

## Outcome

- ✅ Impact: Setup and the schema are done; the shared tests are partly written.
- 🧪 Tests: the shared commerce tests fail until T013; no CI run yet.
- 📁 Files: see above.
- 🔁 Next prompts: continue /sp.implement:
  - the forms, flow-json and form-token tests (T012)
  - the shared implementations (T013), then T014–T022
  - then US1–US3, pushed once
- 🧠 Reflection: the shared signature check takes an injected HMAC (browser-safe, like integrations/signing.ts).
