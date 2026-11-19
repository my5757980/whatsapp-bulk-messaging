---
id: 30
title: Implement US7 Public API
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us7", "public-api", "api-keys", "idempotency", "rate-limit"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0005-security-access-and-api-key-architecture.md
  pr: null
files:
 - apps/api/src/modules/api-keys/api-keys.service.ts
 - apps/api/src/modules/public-api/{api-key.guard,rate-limit.guard,idempotency.service,idempotency-cleanup.processor,public-api.service,public-messages.controller,public-templates.controller}.ts
 - apps/api/src/modules/reports/api-messages.controller.ts
 - apps/api/src/modules/sending/{send.processor,send-queue.manager,template-payload.builder}.ts
 - apps/api/src/modules/contacts/consent.service.ts
 - apps/api/src/modules/domain.module.ts
 - apps/api/src/worker-features.module.ts
 - apps/web/src/app/(dashboard)/settings/api-keys/page.tsx
 - apps/web/src/app/(dashboard)/settings/layout.tsx
 - apps/web/src/app/(dashboard)/api-messages/page.tsx
 - specs/001-whatsapp-bulk-messaging/tasks.md
tests:
 - apps/api/test/integration/api-keys.int-spec.ts (3 pass)
 - apps/api/test/integration/public-api.int-spec.ts (10 pass)
 - apps/api/test/contract/public-api.contract-spec.ts (3 pass)
 - apps/api/test/integration/rbac.int-spec.ts (NOT_YET emptied) and test/unit/audit-coverage.spec.ts (PENDING_US7 emptied) pass
 - apps/api/test/integration/{campaign-send,consent-keywords,imports,campaign-upload,media-and-buffer,masking,audit}.int-spec.ts pass
 - apps/api unit project (130 pass)
 - apps/web/e2e/us7-api.spec.ts (written, not run)
---

## Prompt

continue

## Response snapshot

Did Phase 9 (US7), tests first.

- **API keys:** keys look like `wbk_` + 32 base62 characters. Only the SHA-256 hash, prefix and last 4 are stored, and the full key is shown once. List and revoke are admin-only and audited (`api_key.created`/`api_key.revoked`).
- **Public API v1 (`/api/v1`):**
  - Requests use a Bearer key guard plus a per-key fixed-window rate limit: Redis MULTI INCR + EXPIRE NX, 429 with Retry-After.
  - `POST /messages` checks the number, template (404/422 TEMPLATE_NOT_APPROVED), phone, params (PARAMS_MISMATCH), opt-out and marketing opt-in. It can upsert the contact with an API opt-in that needs a source note, then creates an API-origin message and enqueues it straight to the number's send queue.
  - `Idempotency-Key`: same body returns 200 with the same id, a different body returns 409. Records last 24 h and are cleaned up hourly.
  - A malformed body returns 400, as the public contract says.
  - `GET /messages/{id}` only answers the key that sent the message and returns its history. `GET /templates` lists approved templates with their variable keys.
- **Other backend changes:**
  - The dashboard `GET /api-messages` log masks phones for agents.
  - Header media for API sends goes to Meta as a link.
  - A 30 s `send-workers` sync starts workers for numbers connected after boot.
  - An API call can never undo an opt-out.
- **Web:** Settings > API keys (one-time secret dialog, copy, revoke) and an API messages page with a status timeline.
- **Status:** tasks T181–T193 are marked except the unrun e2e T184; 186 done, 15 open (Phase 10 Polish plus the unrun e2e specs).

## Outcome

- ✅ Impact: Other company systems can send approved templates with an API key, safely retry with an idempotency key, and check delivery. All seven user stories are now implemented.
- 🧪 Tests: US7 integration 13/13, contract 3/3, unit 130/130. The RBAC, audit, masking, media and send suites pass. The e2e spec is written but not run (chromium build missing, low RAM). The full regression run still waits for the user ("tests chalao").
- 📁 Files: see the list above.
- 🔁 Next prompts: "continue" (Phase 10 Polish, T194–T201); "tests chalao" for the full regression.
- 🧠 Reflection: The strict request schema rejected tests that passed whole template rows. Contract details matter: the public API uses 400 for malformed bodies while the dashboard uses 422, and an id that is not a UUID should be 404, not 400.

## Evaluation notes (flywheel)

- Failure modes observed: The first run returned 422 for valid sends because the test fixtures sent extra template fields to a strict schema. The fix was in the tests, not the API.
- Graders run and results (PASS/FAIL): vitest unit/integration/contract PASS; typecheck and eslint PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Run the full integration project in two or three batches when RAM allows.
