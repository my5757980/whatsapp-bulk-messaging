---
id: 116
title: Tasks Click To WhatsApp Ads
stage: tasks
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 007-ads-manager
branch: 007-ads-manager
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "ads", "test-first", "batches"]
links:
  spec: specs/007-ads-manager/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/007-ads-manager/tasks.md
tests:
 - none (task list; each story starts with its tests)
---

## Prompt

Test-first per story, stories in the plan's delivery order (Foundation, US1-US3 MVP, US4-US6, US7-US8, Polish), following the 006 tasks.md style; keep tasks concrete with file paths and batch-friendly.

## Response snapshot

- **72 tasks:**
  - Setup: T001–T004
  - Foundational: T005–T018 (schema, shared rules with tests, `MetaAdsClient` with unit tests, wiring, audit, redaction, web types, the referral CLI option)
  - US1: T019–T023
  - US2: T024–T031
  - US3: T032–T037
  - US4: T038–T043
  - US5: T044–T048
  - US6: T049–T054
  - US7: T055–T060
  - US8: T061–T066
  - Polish: T067–T072
- **Format:** every task has a checkbox, an id, a story label where needed and file paths. Each
  story begins with integration, contract and e2e tests and the mock-meta routes it needs.
- **Batches:** MVP US1–US3, then US4–US6, then US7–US8 with Polish; tasks are marked done only after
  CI.

## Outcome

- ✅ Impact: 007 can be implemented story by story.
- 🧪 Tests: planned per story (unit, integration with nock, contract, e2e on mock-meta).
- 📁 Files: specs/007-ads-manager/tasks.md
- 🔁 Next prompts: /sp.implement, starting with Setup, Foundational and the MVP batch.
- 🧠 Reflection: grouping pushes by batch matches the user's request for speed while keeping each
  story's tests first.
