---
id: 33
title: Implement Phase 10 Polish
stage: green
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "polish", "alerts", "retention", "docker", "security", "perf", "adr", "release"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0005-security-access-and-api-key-architecture.md
  pr: null
files:
 - ops/alerts.yml
 - apps/api/src/common/metrics/metrics.service.ts
 - apps/api/src/common/metrics/queue-depth.collector.ts
 - apps/api/src/modules/maintenance/retention.processor.ts
 - apps/api/src/common/storage/storage.service.ts
 - apps/api/src/modules/domain.module.ts
 - apps/api/src/worker-features.module.ts
 - apps/api/src/app.setup.ts
 - apps/api/src/common/config/config.ts
 - apps/api/Dockerfile
 - apps/api/healthcheck.mjs
 - apps/web/Dockerfile
 - apps/web/next.config.ts
 - apps/web/e2e/us1-broadcast.spec.ts … us7-api.spec.ts (default admin password)
 - tools/perf/client.ts, tools/perf/campaign-10k.ts, tools/perf/import-50k.ts, tools/perf/tsconfig.json
 - package.json (perf scripts, typecheck covers tools/perf)
 - .github/workflows/ci.yml
 - README.md
 - specs/001-whatsapp-bulk-messaging/checklists/release.md
 - specs/001-whatsapp-bulk-messaging/data-model.md
 - specs/001-whatsapp-bulk-messaging/tasks.md
 - history/adr/0001-0005 (status Accepted + implementation notes)
tests:
 - apps/api/test/integration/retention.int-spec.ts (3 pass, new)
 - apps/api/test/integration/ops-endpoints.int-spec.ts (6 pass, queue-depth series added)
 - apps/api/test/integration/auth.int-spec.ts (7 pass, proxy client-IP throttle added) and audit.int-spec.ts (3 pass)
 - apps/api/test/unit/alerts.spec.ts and config.spec.ts (new); api unit 136/136
 - apps/web/tests/security-headers.test.ts (3 pass, new)
 - contract project 5 files / 18 pass
 - promtool check rules (6 rules), gitleaks v8.30.1 (no leaks), docker build --check (api, web), npm audit (0)
---

## Prompt

continue

## Response snapshot

Did Phase 10 (Polish). T194–T199 and T201 are done. T200 is open (heavy runs pending).

- **T194 alerts:**
  - `ops/alerts.yml` has 6 rules: failure rate >5%/10 min, queue not draining 5 min, send-queue stall, webhook p95 >60 s, no webhooks for 15 min while running, and target down.
  - The rules found that `wbm_queue_depth` was never set. It is now filled from Redis at scrape time by both processes (waiting + prioritized).
  - promtool passes, and a unit test keeps the metric names in sync.
- **T195 retention:**
  - Runs as a daily job at 03:15 UTC.
  - It purges finished campaigns 12 months after they end (messages, events, upload rows and import jobs batched), API messages after 12 months, and webhook events and `uploads/` objects after 30 days (error-report links cleared).
  - Audit logs are kept.
- **T196 perf:** `npm run perf:campaign` (SC-002) and `npm run perf:import` (SC-007) call the API directly and print PASS/FAIL. They have not been run yet.
- **T197 Docker:**
  - The api/worker image has a `migrate` stage and a HEALTHCHECK script with X-Ops-Token that picks the API or the worker port.
  - The web image uses standalone output, with `API_INTERNAL_URL` as a build argument and the repo root as the tracing root.
  - `docker build --check` is clean, and CI builds both images.
- **T198 security:**
  - API helmet sends a `default-src 'none'` CSP.
  - Production refuses insecure cookies or a non-https APP_URL.
  - The web app sends a CSP and security headers.
  - `npm audit` reports 0 and is gated in CI, and a gitleaks job was added (two test passwords tagged).
- **T199:** root README.
- **T201 ADRs:**
  - All five ADRs are marked Accepted, with implementation notes.
  - Fixed a gap: the login throttle and audit IP saw the web proxy's address. The API now trusts X-Forwarded-For from private peers, and a test covers it.
- **T200 gaps fixed:**
  - The e2e and perf default password now matches the quickstart.
  - The CI e2e job now seeds the admin and starts MinIO.
  - `checklists/release.md` records the gates and the open items.

## Outcome

- ✅ Impact: The operations, packaging, security and documentation layers are in place. 193 tasks are done. Open: the 7 unrun e2e specs and T200.
- 🧪 Tests: all targeted suites, the contract project, typecheck and lint pass. The full integration run, the Playwright specs and the performance scripts wait for more free RAM or CI.
- 📁 Files: see the list above.
- 🔁 Next prompts: "tests chalao" (full regression in batches); allow a first commit so CI runs; run the perf/e2e on a bigger machine.
- 🧠 Reflection: Writing the alert rules exposed a metric that was never set, and the ADR review exposed the proxy-IP throttle gap. Checks against real behaviour beat checking the documents alone.

## Evaluation notes (flywheel)

- Failure modes observed: Docker was down after the reboot and was started for the tests. A type error in the retention step callback was fixed. Prettier is not enforced in this repo (44 existing files differ), so new files follow the existing style.
- Graders run and results (PASS/FAIL): vitest unit/integration/contract PASS; promtool PASS; gitleaks PASS; docker build --check PASS; npm audit PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): run `npm run perf:import` first (lightest heavy check) when RAM allows.
