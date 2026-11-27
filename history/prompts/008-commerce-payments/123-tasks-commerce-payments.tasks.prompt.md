---
id: 123
title: Tasks Commerce Payments
stage: tasks
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 008-commerce-payments
branch: 008-commerce-payments
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "payments", "stripe", "catalog", "whatsapp-flows", "commerce"]
links:
  spec: specs/008-commerce-payments/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/008-commerce-payments/tasks.md
 - specs/008-commerce-payments/research.md
 - specs/008-commerce-payments/data-model.md
 - specs/008-commerce-payments/contracts/stripe.md
 - specs/008-commerce-payments/quickstart.md
tests:
 - none (task planning)
---

## Prompt

haaa

(The user's yes to "/sp.tasks" next. Claude ran /sp.tasks with this input:)

Test-first tasks for 008 in the delivery order of plan.md: Setup and Foundational (schema and migration, enums, shared rules with unit tests, StripeClient, MetaCommerceClient, FakeStripe and FakeCommerceGraph, mock-meta stripe.ts and commerce.ts, payments and catalog queues, permissions, scopes, events, audit actions), then US1-US3 (MVP batch), US4-US6, US7-US8, and Polish (metrics and alerts, retention and erasure, RBAC, docs, release checklist). Mark parallel tasks [P], name exact file paths, put tests before code in each story, and call out the *(verify)* fields to check against the live references when each client method is written.

## Response snapshot

- **tasks.md:** 97 tasks in 11 phases, every one in the checklist format with an id, `[P]` where safe, a story label in story phases, and exact file paths.
- **Task counts:**
  - Setup: 5
  - Foundational: 17
  - Stories:

    | Story | Tasks |
    |---|---|
    | US1 | 7 |
    | US2 | 15 |
    | US3 | 10 |
    | US4 | 7 |
    | US5 | 10 |
    | US6 | 7 |
    | US7 | 7 |
    | US8 | 5 |

  - Polish: 7
  - 62 tasks are marked `[P]`.
- **Test-first:** each story's tests come first (integration with `FakeStripe` and `FakeCommerceGraph`, contract cases, Playwright e2e on mock-meta), and must fail before the code.
- **Fields to verify:** the *(verify)* items are named in T007, T012, T016, T017, T053, T069, T070 and T083.
- **Design fixes made along the way:**
  - The webhook address uses the existing `APP_URL` (contracts/stripe.md and quickstart.md).
  - Stored Stripe event bodies go through `redactStripeEvent`, which removes card and customer details (research R3, data-model.md).
  - SC-004 gets its own scan test (T093).

## Outcome

- ✅ Impact: 008 is ready for /sp.implement in three batches.
- 🧪 Tests: planned per story; none run yet.
- 📁 Files: tasks.md, plus small fixes in research.md, data-model.md, contracts/stripe.md and quickstart.md.
- 🔁 Next prompts: /sp.implement (Setup, Foundational and US1–US3 first).
- 🧠 Reflection: the payment step lives in US3 and the other three steps in US8, so the MVP stays usable without the catalog.
