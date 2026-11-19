---
id: 37
title: Live Perf And E2E Run
stage: misc
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: none
labels: ["perf", "e2e", "live-run", "bugfix", "webhooks", "worker", "imports", "release"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0004-campaign-delivery-and-webhook-processing.md
  pr: null
files:
 - apps/api/src/modules/domain.module.ts (team services moved to ApiFeaturesModule)
 - apps/api/src/common/queue/attempts.ts (new)
 - apps/api/src/modules/imports/import.processor.ts
 - apps/api/src/modules/campaigns/audience-upload.processor.ts
 - apps/api/src/modules/contacts/consent.service.ts
 - apps/api/src/modules/webhooks/handlers/status.handler.ts
 - apps/api/src/modules/webhooks/webhooks.processor.ts
 - apps/api/src/common/config/config.ts (DATABASE_POOL_MAX)
 - apps/api/src/common/prisma/prisma.service.ts
 - .env.example
 - tools/perf/import-50k.ts, tools/perf/campaign-10k.ts
 - specs/001-whatsapp-bulk-messaging/checklists/release.md
 - specs/001-whatsapp-bulk-messaging/tasks.md
tests:
 - apps/api/test/integration/worker-boot.int-spec.ts (new; red then green)
 - apps/api/test/integration/status-concurrency.int-spec.ts (new; red 10/12 stuck at DELIVERED, then green)
 - apps/api/test/integration/imports.int-spec.ts (retry status case added)
 - apps/api/test/unit/attempts.spec.ts (new)
 - Re-run green: worker-boot, users, imports, campaign-upload, status-concurrency, webhooks-ingest, campaign-send, media-and-buffer; unit 138/138
 - perf:import SC-007 PASS (50,000 rows in 1m 13s)
 - perf:campaign SC-002 first run: sending 12m 40s, but statuses lost; re-run killed by the low-memory guard
---

## Prompt

haaa karooo test manayy sab kuch band kar diaaaa haiiiii

## Response snapshot

The user had closed their other programs, so I ran the remaining live checks.

- **Setup:**
  - Installed Playwright chromium v1255 and migrated the dev DB.
  - Created a separate admin, `e2e-admin@company.test`, because the existing admin's password differs from the quickstart's.
  - Ran api, worker and mock-meta from the build.
- **The live run found three real bugs, each fixed test-first:**
  1. **Worker did not boot.** InvitationsService (needs AuthService) sat in the global DomainModule. The team services moved to ApiFeaturesModule, and a worker-boot test was added.
  2. **50k import was fragile.** A batch failed after Prisma's 2 s maxWait and restarted the import, and the job showed FAILED between retries. Batches now wait up to 30 s, and only the last attempt marks the job failed. Re-run: 50,000 rows in 1m 13s (PASS).
  3. **Statuses were lost under load.** Webhook processing had concurrency 1, and the first 10k run left 9,785 messages at SENT. Processing in parallel would also lose updates through a read-then-update race (new test: 10 of 12 messages stuck at DELIVERED). The fix runs webhooks 10 in parallel, locks the message row (`FOR NO KEY UPDATE`, so no deadlock with the FK key-share lock) with maxWait 10 s, and makes `DATABASE_POOL_MAX` configurable (default 20).
- **Stopped by memory:** the 10k campaign re-run, the api, the worker and mock-meta were killed by Claude Code's low-memory guard (about 390 MB free). Per that notice, they are not restarted without the user asking.
- **Not run:** the browser e2e tests and the Docker builds.

## Outcome

- ✅ Impact: Three production-grade bugs fixed that only a live run could reveal. SC-007 is met.
- 🧪 Tests: the new and affected suites pass; perf import PASS; campaign perf re-run pending.
- 📁 Files: see the list above.
- 🔁 Next prompts: retry the 10k campaign and the e2e here (risky at 3.9 GB), or push so CI runs e2e and the Docker builds.
- 🧠 Reflection: Integration tests that load the API and worker together hid a worker-only DI failure, and serial webhook processing hid a concurrency race. Live load testing earned its cost.

## Evaluation notes (flywheel)

- Failure modes observed: low memory killed the background stack. A one-character-splat bug in the batch helper had already been fixed earlier.
- Graders run and results (PASS/FAIL): vitest PASS; perf:import PASS; perf:campaign incomplete (killed).
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): run perf:campaign alone (no web, no other Docker project) or in CI.
