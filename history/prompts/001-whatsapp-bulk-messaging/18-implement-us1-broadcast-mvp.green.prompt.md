---
id: 18
title: Implement US1 Broadcast MVP
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us1", "mvp", "campaigns", "sending", "bullmq", "webhooks", "consent", "nextjs"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0002-backend-runtime-process-model-and-monorepo.md
  pr: null
files:
 - apps/api/src/modules/numbers/{numbers.service,numbers.controller,number-refresh.processor}.ts
 - apps/api/src/modules/templates/{templates-sync.service,templates.controller}.ts
 - apps/api/src/modules/media/{media.service,media.controller}.ts
 - apps/api/src/modules/campaigns/{campaigns.service,campaigns.controller,campaign-messages.controller,variable-resolver,audience-upload.service,audience-upload.processor,audience-snapshot.service,estimate.service,launch.service,campaign-control.service,campaign-progress.processor,dispatch-scheduler,csv,imports}.ts
 - apps/api/src/modules/contacts/{consent.service,contact-deletion.service,contact-deletion.controller}.ts
 - apps/api/src/modules/imports/imports.controller.ts
 - apps/api/src/modules/sending/{dispatch-planner,send-outcome,template-payload.builder,send-queue.manager,dispatcher.processor,send.processor}.ts
 - apps/api/src/modules/webhooks/handlers/{status-update,status.handler,inbound.handler}.ts
 - apps/api/src/modules/domain.module.ts, apps/api/src/worker-features.module.ts, app.module.ts, worker.module.ts
 - apps/api/src/common/{queue/processor.registry,prisma/prisma-errors,validation/pagination,validation/uploaded-file}.ts
 - apps/api/test/support/{test-context,fixtures}.ts
 - apps/web/src/app/(dashboard)/{settings/numbers,templates,campaigns,campaigns/new,campaigns/[id]}/page.tsx
 - apps/web/src/components/campaigns/{campaign-controls,wizard/basics-step,wizard/audience-step,wizard/mapping-step,wizard/review-step}.tsx
 - apps/web/src/components/{confirm-dialog,ui/native-select}.tsx, apps/web/src/lib/{types,format,errors}.ts
 - apps/web/e2e/us1-broadcast.spec.ts, samples/contacts-10.csv
 - specs/001-whatsapp-bulk-messaging/tasks.md (T071-T082, T084-T113 marked done; notes on T075, T083, T097)
tests:
 - apps/api unit - 92 pass (new - variable resolver, dispatch planner, send decisions, status precedence/parsing, template payload builder)
 - apps/api integration - 50 pass (new - numbers, template sync, audience upload, send-now flow, consent keywords, contact deletion, pause/resume/cancel and kill switch, media, early status buffering)
 - apps/api contract - 6 pass (US1 responses vs dashboard-api.openapi.yaml)
 - packages/shared - 28 pass; typecheck (all workspaces) and eslint clean
 - live HTTP smoke run (real API + BullMQ worker + mock-meta) - 10 unique sends, 9 delivered + 1 failed 131026, campaign COMPLETED in about 4 s, no phone numbers in logs
 - apps/web/e2e/us1-broadcast.spec.ts - written, NOT executed (Playwright needs chromium v1255; machine has about 650 MB free RAM)
---

## Prompt

continue

(continuation of /sp.implement after the Phase 2 checkpoint; earlier consent for test DB resets, verbatim: "Haan, test DB reset karo")

## Response snapshot

Implemented Phase 3, User Story 1 (the MVP) test-first:
- **Red step:** wrote the failing unit, integration and contract tests first and confirmed they failed.
- **Backend:**
  - connect/refresh/disconnect numbers; the token is encrypted and write-only
  - template sync with derived variables; media upload with a lazy per-number Meta media id
  - campaign drafts; CSV audience upload with mandatory opt-in confirmation (an opt-out always wins)
  - estimate with masked previews; atomic send-now snapshot
  - dispatcher using claim-before-send (`FOR UPDATE SKIP LOCKED`, buffer of rate x 2)
  - send worker with the R9 retry/blocking policy and at-most-once ambiguous handling
  - status webhooks with dedupe, precedence and a 24 h buffer for early events
  - STOP/START keywords with per-message dedupe; contact data deletion with anonymisation
  - pause/resume/cancel and kill-switch auto-pause with notifications and audits
  - progress processor with stale-message recovery
- **Web:** numbers settings, templates list with sync, 4-step campaign wizard, campaign detail with live polling and recipient table, controls, campaigns list.

## Outcome

- ✅ Impact: The US1 checkpoint is met. An admin can connect a number, sync templates, upload an opted-in list, map variables, send, and track every recipient. The MVP covers each constitution MUST (STOP handling, data deletion, pause, kill switch).
- 🧪 Tests: 176 automated tests pass, plus a live end-to-end smoke run; the Playwright e2e is still pending execution.
- 📁 Files: about 45 new or changed source files across api/web/tests, plus the sample CSV and tasks.md updates.
- 🔁 Next prompts:
  - run T083 after `npx playwright install chromium`
  - continue /sp.implement with Phase 4 (US2 contacts, T114-T131)
- 🧠 Reflection: The integration tests drive processors directly with a stub registry, so a live run with real BullMQ workers was needed to validate the global rate limit, custom backoff and job schedulers. It passed on the first attempt.

## Evaluation notes (flywheel)

- Failure modes observed:
  - nock 15 hangs native fetch when a reply is a function; fixed by using static per-recipient interceptors with body matchers.
  - BullMQ rejects `:` in job ids, hence `msg-{id}`.
  - Literal BOM characters written into sources tripped no-irregular-whitespace; fixed by char-code checks.
- Graders run and results (PASS/FAIL): unit PASS, integration PASS, contract PASS, typecheck PASS, lint PASS, live smoke PASS, Playwright NOT RUN.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Install Playwright chromium v1255 and run us1-broadcast.spec.ts against `next start` to limit memory.
