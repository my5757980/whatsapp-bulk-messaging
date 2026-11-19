---
id: 13
title: Generate Tasks WhatsApp Bulk Messaging
stage: tasks
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "tdd", "user-stories", "mvp", "monorepo"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0001-frontend-stack.md, history/adr/0004-campaign-delivery-and-webhook-processing.md
  pr: null
files:
 - specs/001-whatsapp-bulk-messaging/tasks.md
 - history/prompts/001-whatsapp-bulk-messaging/13-generate-tasks-whatsapp-bulk-messaging.tasks.prompt.md
tests:
 - Format validator - 199/199 tasks match "- [ ] T### [P?] [US?] description + file path"; IDs sequential; story labels only in story phases
---

## Prompt

/sp.tasks

(no arguments given)

## Response snapshot

Generated tasks.md from plan.md, spec.md, data-model.md, contracts/, research.md and quickstart.md. There are 199 tasks in 10 phases:

| Phase | Tasks | Range |
|---|---|---|
| Setup | 17 | T001–T017 |
| Foundational | 51 | T018–T068 |
| US1 (P1, MVP) | 35 | T069–T103 |
| US2 | 23 | T104–T126 |
| US3 | 12 | T127–T138 |
| US4 | 12 | T139–T150 |
| US5 | 13 | T151–T163 |
| US6 | 15 | T164–T178 |
| US7 | 13 | T179–T191 |
| Polish | 8 | T192–T199 |

Tests are included as REQUIRED because constitution Principle V (Test-First) overrides the command's "tests optional" default. Each story starts with failing unit, integration, contract and e2e tests, using nock or mock-meta.

Restructured against the spec's story split so the MVP is safe on its own:
- Transient-error retries and blocking-error auto-pause (`CampaignsService.autoPause`) live in US1's send processor.
- US3 reuses autoPause for template status changes.
- US4 covers scheduling, pause/resume/cancel, the resume guard, the messaging-limit warning, quality alerts and the notifications bell.

Also includes:
- a dependency table and story completion graph
- parallel examples per story; 112 tasks are marked [P]
- an MVP-first incremental strategy and a team split
- the verify-at-implementation items for the Meta docs

## Outcome

- ✅ Impact: The backlog is executable task by task for /sp.implement, with the MVP clearly bounded (T001–T103).
- 🧪 Tests: format validation passed for all 199 tasks.
- 📁 Files: tasks.md.
- 🔁 Next prompts: /sp.implement (MVP first). Optionally /sp.analyze for a cross-artifact consistency check before it.
- 🧠 Reflection: Moving retries into US1 keeps a standalone MVP compliant with constitution Principle IV.

## Evaluation notes (flywheel)

- Failure modes observed: the command template says tests are optional, which conflicts with the constitution. The constitution wins, and the tasks template was already updated in v1.0.0.
- Graders run and results (PASS/FAIL): checklist format PASS; sequential IDs PASS; label placement PASS; file paths PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Run /sp.analyze to cross-check FR coverage (FR-001–FR-038) against the task IDs.
