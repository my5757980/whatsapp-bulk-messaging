---
id: 136
title: Templates Growth Tasks
stage: tasks
date: 2026-11-27
surface: agent
model: claude-opus-5-5
feature: 009-templates-growth
branch: 009-templates-growth
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "test-first", "templates", "otp", "reports", "website-widget"]
links:
  spec: specs/009-templates-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/009-templates-growth/tasks.md
tests:
 - none (task planning; a format check confirmed 96 sequential tasks with story labels)
---

## Prompt

haaaaa

(The user's yes to "make the tasks?"; /sp.tasks ran with: "Test-first tasks for 009 in the plan's delivery order: Setup and Foundational, then the MVP batch US1-US3 (codes, carousels, offers), then US4-US5, then US6-US8 with Polish (metrics and alerts, retention and erasure, the code leak scan, RBAC, audit, docs, release checklist). Each story: tests (unit, integration, contract, e2e) before implementation, exact file paths, and [P] where files differ.")

## Response snapshot

- Wrote specs/009-templates-growth/tasks.md with 96 tasks:
  - Setup T001–T004; Foundational T005–T018
  - US1 11, US2 10, US3 8, US4 9, US5 9, US6 7, US7 6, US8 11
  - Polish T090–T096
- 63 tasks can run in parallel. Each story has its tests first and an independent test from the quickstart.
- Batches: US1–US3, then US4–US5, then US6–US8 with Polish.

## Outcome

- ✅ Impact: 009 is ready for /sp.implement.
- 🧪 Tests: the format check passed.
- 📁 Files: tasks.md.
- 🔁 Next prompts: /sp.implement, starting with Setup, Foundational and the MVP batch.
- 🧠 Reflection: the widget script cannot import shared code at runtime, so the build inlines the shared matcher (T087).

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): format check PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
