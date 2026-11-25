---
id: 106
title: Tasks Integrations Platform
stage: tasks
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "integrations", "test-first", "webhooks", "stores", "public-api", "chat-links", "number-wizard"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/006-integrations-platform/tasks.md
tests:
 - none (task list); format check: 91 tasks, sequential ids, story labels only in story phases
---

## Prompt

haaa agayyycontinue karooo kaam

(This continues the same user message after the plan, PHR 105. Claude ran /sp.tasks with: "006-integrations-platform: tasks from plan.md, spec.md (8 stories), data-model.md, contracts and quickstart, test-first per story like 005.")

## Response snapshot

- **tasks.md has 91 tasks:**

| Phase | Tasks | Content |
|---|---|---|
| Setup | T001–T005 | config, queues, `qrcode`, contract lint, the mock-meta catcher |
| Foundational | T006–T017 | migration; permission; shared signing, retries, events and scopes tests and code; the shared safe HTTP client; audit; redaction; module wiring; web lib |
| US1 | 8 | webhooks: tests, outbox, delivery processor, endpoints, event hooks, web |
| US2 | 8 | contacts API: tests, scopes guard, key scopes, contacts and drip routes, web |
| US3 | 8 | API campaigns |
| US4 | 14 | stores: mapping tests, mock stores, Shopify and WooCommerce tests and clients, connections, events processor, reconciler, automations, live chat origin, web |
| US5 | 7 | COD, including quick-reply payloads in the template builder |
| US6 | 6 | carts |
| US7 | 8 | chat links |
| US8 | 8 | number wizard |
| Polish | T085–T091 | metrics and alerts, retention and erasure, audit, RBAC and scopes tests, perf scripts, docs, release checklist |

- **Order:** dependencies, two parallel examples, and the strategy (MVP: US1 + US2).
- **Code gaps found:**
  - the template builder supports only URL button parameters, so T059 adds quick-reply payloads
  - API key routes live in `api-keys.service.ts`

## Outcome

- ✅ Impact: 006 is ready for `/sp.implement`.
- 🧪 Tests: each story starts with its tests (integration, contract and e2e, plus unit tests for pure rules).
- 📁 Files: specs/006-integrations-platform/tasks.md.
- 🔁 Next prompts: `/sp.implement` for 006, story by story, verified in CI, after the user says yes.
- 🧠 Reflection: checking the code while writing tasks (button payload support, where routes live) makes each task exact.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): task format check PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
