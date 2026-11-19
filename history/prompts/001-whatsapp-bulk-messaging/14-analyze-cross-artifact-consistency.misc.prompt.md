---
id: 14
title: Analyze Cross Artifact Consistency
stage: misc
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.analyze
labels: ["analyze", "consistency", "coverage", "constitution", "read-only"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - history/prompts/001-whatsapp-bulk-messaging/14-analyze-cross-artifact-consistency.misc.prompt.md
tests:
 - Read-only analysis of spec.md, plan.md, tasks.md against constitution v1.0.0 (no artifact modified)
---

## Prompt

/sp.analyze

(no additional user input)

## Response snapshot

The read-only analysis produced 20 findings: 5 CRITICAL, 0 HIGH, 11 MEDIUM, 4 LOW.

The CRITICAL findings are constitution gaps in the MVP increment and in cross-cutting tasks:
- C1: STOP/opt-out keyword processing exists only in US2 (T107/T113/T118).
- C2: there is no way to stop a running broadcast in the MVP. Pause is in US4 (T145), and the `sending_enabled` kill switch is checked only at launch (T090), not in T092/T094.
- C3: contact deletion exists only in US2 (T121).
- C4: phone masking in logs is missing from T034.
- C5: /health and /metrics are unauthenticated, against Principle III's "every request MUST be authenticated".

The MEDIUM findings:
- Settings UI missing for FR-004.
- Template sync is not triggered on connect, and there is no periodic status fallback (FR-016, US3 AS-3).
- No tasks for SC-008, SC-009 and SC-010; no measurement for SC-005.
- `headerMediaUrl` in the public contract is untasked.
- No task for the "delayed" outage indicator.
- No explicit dead-letter configuration or replay.
- No manual messaging-limit tier input in the UI.
- PENDING/SENDING status terminology drifts from FR-025.

The LOW findings:
- Paths missing from the plan structure.
- [P] markers on dependent tasks (T082, T050).
- Notification bell only in US4.
- Vague "strong password policy" and the upload limit missing from the spec.

Coverage is 45/48 requirements (93.8%): all 38 FRs have tasks (2 only partially), and 7/10 SCs do. There are no duplications and no unmapped tasks.

Recommended resolving the criticals before /sp.implement, and offered concrete remediation edits.

## Outcome

- ✅ Impact: The constitution gaps were found before implementation. They are cheap to fix now by editing tasks, and expensive after coding.
- 🧪 Tests: none (analysis only).
- 📁 Files: no spec, plan or tasks file modified; only this PHR was written.
- 🔁 Next prompts: user approves remediation, then tasks.md and plan.md are edited (C1–C5, then the MEDIUMs), then /sp.implement.
- 🧠 Reflection: Story-ordered tasks can quietly push constitution-mandated safety controls out of the MVP slice. Check each deliverable increment against every MUST, not just the final product.

## Evaluation notes (flywheel)

- Failure modes observed: the earlier /sp.tasks run followed the spec's priority split without re-checking MVP compliance with Principles I, III and VI.
- Graders run and results (PASS/FAIL): constitution alignment FAIL (5 criticals); coverage 93.8%; duplication 0.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Add a "constitution gate per increment" check to the tasks workflow.
