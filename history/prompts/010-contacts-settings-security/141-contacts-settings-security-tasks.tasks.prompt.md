---
id: 141
title: Contacts Settings Security Tasks
stage: tasks
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 010-contacts-settings-security
branch: 010-contacts-settings-security
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "test-first", "segments", "bulk-tags", "lead-source", "global-attributes", "date-automations", "2fa", "business-profile"]
links:
  spec: specs/010-contacts-settings-security/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/010-contacts-settings-security/tasks.md
tests:
 - none (task list); every story phase starts with failing unit, integration, contract and e2e tasks
---

## Prompt

continue

(The agreed flow continued after the plan: /sp.tasks for 010.)

## Response snapshot

- **89 test-first tasks** in tasks.md:
  - Setup (4): contract lint, mock-meta business profile, a TOTP helper, the 200,000-contact perf
    seed.
  - Foundational (13): the migration with the legacy lead source mapping; shared segment rules, lead
    sources, due dates, profile limits, checklist and guides; audit actions; the lead source helper;
    the `bulk` queue; module wiring; web types; updates to the 001 and 005 contracts.
  - Stories: US1 segments (12), US2 bulk and automatic tags, lead source and export (12), US3 global
    attributes (8), US4 keyword replies (5), US5 date automations (9), US6 2FA (9), US7 business
    profile and checklist (8), US8 guides (2).
  - Polish (7): metrics and alerts, retention and erasure, the audit list, RBAC, perf, docs (marking
    the inventory, including the 002 and 003 rows built earlier), the release checklist.
- **Batches:** US1–US2 (the MVP), US3–US6, then US7–US8 with Polish. US5 waits for US3.

## Outcome

- ✅ Impact: 010 is ready for /sp.implement once 009 is merged.
- 🧪 Tests: none run (planning); each story has its failing tests listed first.
- 📁 Files: tasks.md.
- 🔁 Next prompts: merge 009 when its e2e run is green, merge main into 010, then /sp.implement
  starting with the MVP batch.
- 🧠 Reflection: the bulk action base (T027) serves both segment drip enrolment and bulk tags, so it
  sits in US1 and US2 builds on it.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): format check PASS (89 tasks, sequential ids, story labels on
  story phases).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
