---
id: 24
title: Implement US4 Scheduling And Alerts
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us4", "scheduling", "reconciler", "auto-pause", "quality-webhook", "notifications"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/modules/campaigns/{schedule.service,schedule-reconciler.processor,launch.service,campaigns.controller,campaign-control.service}.ts
 - apps/api/src/modules/webhooks/handlers/quality.handler.ts
 - apps/api/src/modules/numbers/numbers.service.ts (markUnavailable), apps/api/src/modules/sending/send.processor.ts (blocking causes)
 - apps/api/src/modules/domain.module.ts, apps/api/src/worker-features.module.ts
 - apps/web/src/lib/time.ts, apps/web/src/components/campaigns/wizard/review-step.tsx, apps/web/src/app/(dashboard)/campaigns/[id]/page.tsx
 - apps/web/src/components/layout/notifications-bell.tsx, apps/web/src/app/(dashboard)/layout.tsx, apps/web/src/lib/types.ts
 - apps/api/test/integration/{campaign-schedule,campaign-autopause}.int-spec.ts, apps/web/e2e/us4-control.spec.ts
 - specs/001-whatsapp-bulk-messaging/tasks.md (T144, T145, T147-T152 done; notes on T145, T146, T147, T150)
tests:
 - apps/api integration - campaign-schedule + campaign-autopause 8 pass (red confirmed first); campaign-send/control/filter 13 pass after the launch refactor
 - apps/api contract us1 - 6 pass; apps/api unit - 102 pass
 - web/api typecheck and eslint - clean; timezone helper checked against DST cases
 - live smoke (real API + worker + mock-meta) - scheduled 109 recipients 70 s ahead: started 0.2 s late, completed, 109 unique sends
 - full integration regression - not rerun (memory); Playwright us4-control - written, not executed
---

## Prompt

continue

## Response snapshot

Implemented Phase 6, User Story 4.
- **Scheduling:**
  - Launching with `scheduledAt` validates now, stores the time and timezone (default: company timezone), adds a delayed `campaign-start` job, and audits `campaign.scheduled`.
  - The snapshot is taken at start time.
  - A 30 s reconciler starts due campaigns whose job was lost.
  - Starting is idempotent.
  - Unschedule returns the campaign to DRAFT; cancel and unschedule remove the job.
- **Automatic pauses:**
  - Blocking send errors now mark their cause. Expired tokens and other account errors move the number to ERROR, so resume stays blocked until the token is fixed; template codes mark the template PAUSED/DISABLED.
  - Number-limit webhooks update the tier, re-read the quality from Meta, and notify admins on a downgrade.
- **Web:**
  - The review step can send now or schedule (date/time + timezone, DST-safe conversion).
  - The campaign page shows the scheduled time with an Unschedule button.
  - A notifications bell in the header (unread count, latest items, mark read, deep links).

## Outcome

- ✅ Impact: Scheduled campaigns start on time and blocked campaigns stay paused until fixed; admins see quality drops and other alerts in the bell.
- 🧪 Tests: targeted suites pass, plus a live scheduling smoke. A full regression rerun and the Playwright specs are still pending (machine memory).
- 📁 Files: about 15 source files changed or added.
- 🔁 Next prompts:
  - "tests chalao" (full regression when RAM is free)
  - continue with Phase 7 (US5 reports, cost, retargeting)
- 🧠 Reflection:
  - The first live run looked like an early start. The cause was the Windows system clock jumping about 37 minutes while V8 kept a per-process cached clock, so processes disagreed briefly.
  - Checking every component's clock (Date headers, Postgres, Redis) pinned it down quickly.
  - A rerun with synced clocks passed.

## Evaluation notes (flywheel)

- Failure modes observed:
  - A system clock correction during a live test (an environment issue).
  - Low RAM limits how many test files can run at once.
- Graders run and results (PASS/FAIL): US4 integration PASS, affected US1 suites PASS, contract us1 PASS, unit PASS, typecheck PASS, lint PASS, live smoke PASS (2nd run), Playwright NOT RUN.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Run the full integration project in two halves to stay under the memory limit.
