---
id: 16
title: Fix Constitution Gaps In Tasks
stage: tasks
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: none (approval of /sp.analyze remediation)
labels: ["tasks", "remediation", "constitution", "mvp", "security", "privacy"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/001-whatsapp-bulk-messaging/tasks.md
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml
 - specs/001-whatsapp-bulk-messaging/quickstart.md
 - specs/001-whatsapp-bulk-messaging/research.md
 - specs/001-whatsapp-bulk-messaging/plan.md
 - history/prompts/001-whatsapp-bulk-messaging/16-fix-constitution-gaps-in-tasks.tasks.prompt.md
tests:
 - tasks.md format validator - 201/201 tasks valid, IDs sequential, story labels match phases, file paths present
 - Cross-references remapped (autoPause T091, deletion T103, dependency table, notes) and spot-checked
---

## Prompt

haaaa

(the user approved fixing the 5 critical issues from /sp.analyze, explained in PHR 15)

## Response snapshot

Fixed all 5 CRITICAL constitution gaps:

| ID | Problem | Fix |
|---|---|---|
| C1 | STOP keywords handled only in US2 | Moved the consent keyword tests, ConsentService and inbound handler into US1 (new T079, T092, T102) |
| C2 | No way to stop a running broadcast in the MVP | Moved pause/resume/cancel tests, service and UI into US1 (T081, T105, T112). The dispatcher and send processor now honour the per-number `sending_enabled` kill switch: message back to PENDING, campaign auto-paused `sending_disabled`. Tests updated |
| C3 | No contact deletion in the MVP | Moved the deletion test and service into US1 (T080, T103), adding a DELETE /contacts/{id} controller and an admin "Delete contact data" action on campaign recipients. US2's ContactsController no longer duplicates delete |
| C4 | Phones not masked in logs | Added a log-masking test (T034); logging (T035) masks phone fields through a pino serializer |
| C5 | /health and /metrics unauthenticated | Added an ops-endpoint test (T036); /health and /metrics require `X-Ops-Token` (`OPS_TOKEN`) |

C5 also needed consistency updates in other artifacts: the OpenAPI opsToken scheme plus a 401 on /health, the quickstart env table, research R19, the plan Constitution Check, `.env.example` (T006) and the Dockerfile HEALTHCHECK (T197).

Renumbered with a block-move script, which remapped every reference. There are now 201 tasks:

| Phase | Tasks | Range |
|---|---|---|
| Setup | 17 | T001–T017 |
| Foundational | 53 | T018–T070 |
| US1 (MVP) | 43 | T071–T113 |
| US2 | 18 | — |
| US3 | 12 | — |
| US4 | 9 | — |
| US5 | 13 | — |
| US6 | 15 | — |
| US7 | 13 | — |
| Polish | 8 | — |

Updated the story goals, checkpoints, parallel examples and dependency table to match.

## Outcome

- ✅ Impact: The MVP increment now satisfies every constitution MUST (Principles I, III, VI). The criticals from the analysis are resolved.
- 🧪 Tests: format validation passed; references remapped and checked.
- 📁 Files: tasks.md, dashboard-api contract, quickstart, research, plan.
- 🔁 Next prompts: /sp.implement (MVP T001–T113), or optionally re-run /sp.analyze. MEDIUM/LOW findings (G1–G6, U1–U3, I1–I4, A1–A2) remain as optional improvements. A possible constitution PATCH could explicitly exempt the auth endpoints and signed webhooks.
- 🧠 Reflection: Script-based block moves with global ID remapping were safer than hand-renumbering 200 tasks.

## Evaluation notes (flywheel)

- Failure modes observed: none; every Edit applied and the validator passed first time.
- Graders run and results (PASS/FAIL): format PASS; sequential IDs PASS; labels PASS; paths PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Re-run /sp.analyze to confirm 0 CRITICAL before implementation.
