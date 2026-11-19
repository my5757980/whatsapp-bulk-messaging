---

description: "Task list for feature 001-whatsapp-bulk-messaging"
---

# Tasks: WhatsApp Bulk Messaging Core

**Input**: Design documents from `/specs/001-whatsapp-bulk-messaging/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (dashboard-api.openapi.yaml, public-api.openapi.yaml, meta-webhooks.md), quickstart.md; ADR-0001 to ADR-0005 in `history/adr/`

**Tests**: REQUIRED. Constitution Principle V (Test-First) makes tests mandatory for every user story.
- Write the story's test tasks first and confirm they fail, then implement.
- Meta is always mocked (nock in unit/integration tests, `tools/mock-meta` in e2e); no test sends a real WhatsApp message.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested and
demoed on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on unfinished tasks)
- **[Story]**: User story from spec.md (US1–US7)
- Every task names the exact file(s) to create or change

## Path Conventions (npm-workspaces monorepo, see plan.md)

| Package | Code | Tests |
|---|---|---|
| Backend | `apps/api/src/` | `apps/api/test/{unit,integration,contract}/` |
| Database | `apps/api/prisma/` | — |
| Frontend | `apps/web/src/` | Vitest in `apps/web/tests/`, Playwright in `apps/web/e2e/` |
| Shared | `packages/shared/src/` | tests next to the source (`*.test.ts`) |
| Tooling | `tools/mock-meta/src/` and `tools/perf/` | — |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo, tooling and local infrastructure.

- [X] T001 Create the root `package.json`. It must contain:
  - npm workspaces `apps/*`, `packages/*`, `tools/*`
  - `"engines": {"node": ">=26"}`
  - scripts: `dev`, `build`, `lint`, `lint:contracts`, `typecheck`, `test`, `test:integration`, `test:contract`, `test:e2e`, `db:migrate`, `db:seed`, `mock:inbound`
- [X] T002 [P] Create a strict shared TypeScript config in tsconfig.base.json:
  - `strict`, `noUncheckedIndexedAccess`, target ES2023
  - pin `typescript@~6.0` as a root devDependency (research R1: not 7.0)
- [X] T003 [P] Configure ESLint (flat config with typescript-eslint; `no-explicit-any` as an error) and Prettier in eslint.config.mjs, .prettierrc, .editorconfig
- [X] T004 [P] Create .gitignore covering node_modules, .env, dist, .next, coverage, playwright-report, test-results and *.log
- [X] T005 [P] Create docker-compose.yml with these services:

  | Service | Configuration |
  |---|---|
  | `postgres` | postgres:16, db `wbm`, user `wbm` |
  | `redis` | redis:7 with `--maxmemory-policy noeviction --appendonly yes` |
  | `minio` | `cgr.dev/chainguard/minio` (MinIO community images were discontinued in Oct 2025); the API creates bucket `wbm` on startup |
  | *(not in Compose)* | mock-meta runs with `npm run dev -w @wbm/mock-meta` on port 4010 |

- [X] T006 [P] Create .env.example documenting every variable in quickstart.md §2:
  - `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
  - `TOKEN_ENCRYPTION_KEY`, `APP_URL`, `COOKIE_SECURE`
  - `META_GRAPH_BASE_URL`, `META_GRAPH_API_VERSION=v27.0`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`
  - `SMTP_URL`, `LOG_LEVEL`, `OPS_TOKEN` (protects /health and /metrics)
- [X] T007 Scaffold `packages/shared` in packages/shared/package.json, packages/shared/tsconfig.json, packages/shared/src/index.ts: name `@wbm/shared`, zod 4 dependency, barrel export
- [X] T008 Scaffold the NestJS 12.5 API with pinned dependencies in apps/api/package.json, apps/api/tsconfig.json, apps/api/nest-cli.json:
  - runtime: @nestjs/core 12.5, prisma + @prisma/client + @prisma/adapter-pg 7.10.x, pg, bullmq 6.7, ioredis 6, nestjs-pino 5, pino 10, zod 4, argon2 0.45, csv-parse 7, libphonenumber-js, @aws-sdk/client-s3 3, prom-client 15, cookie-parser
  - dev: vitest 5, unplugin-swc, @swc/core, supertest 7, nock 15
- [X] T009 Scaffold the Next.js 16.4 app in apps/web/package.json, apps/web/next.config.ts, apps/web/tsconfig.json, apps/web/src/app/layout.tsx: React 19.3, TanStack Query 5, Tailwind CSS 4, react-hook-form, zod 4, workspace dependency on `@wbm/shared`
- [X] T010 [P] Scaffold the `tools/mock-meta` package (TypeScript, plain `node:http` server, start script) in tools/mock-meta/package.json, tools/mock-meta/tsconfig.json
- [X] T011 [P] Configure Vitest for the API in apps/api/vitest.config.ts (projects `unit`, `integration`, `contract`; SWC plugin for decorator metadata) and apps/api/test/setup/global-setup.ts:
  - unit tests: `test/unit/**/*.spec.ts`
  - integration tests: `test/integration/**/*.int-spec.ts`
  - `globalSetup` runs `prisma migrate reset --force` on the test database and flushes Redis
- [X] T012 [P] Configure Vitest + Testing Library (jsdom) for the web app in apps/web/vitest.config.ts, apps/web/vitest.setup.ts
- [X] T013 [P] Configure Playwright with `webServer` entries for mock-meta, api, worker and web, base URL `http://localhost:3000`, in apps/web/playwright.config.ts
- [X] T014 [P] Add `@redocly/cli` as a root devDependency and the `lint:contracts` script that lints specs/001-whatsapp-bulk-messaging/contracts/*.openapi.yaml, in package.json
- [X] T015 [P] Create the contract-test helper in apps/api/test/contract/openapi-validator.ts. It dereferences an OpenAPI file with @apidevtools/swagger-parser and validates a response body against the operation's schema with ajv (draft 2020-12).
- [X] T016 [P] Create the GitHub Actions CI workflow in .github/workflows/ci.yml with these steps: install, lint, lint:contracts, typecheck, unit, integration (postgres + redis services), contract, e2e smoke
- [X] T017 [P] Initialise shadcn/ui (components.json) and add base components in apps/web/src/components/ui/: button, input, label, table, dialog, form, select, badge, tabs, toast, dropdown-menu, card

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared domain helpers, database, auth/RBAC, logging, queues, the Meta client, webhook
ingestion, mock-meta and the web shell.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared package

- [X] T018 [P] Define the shared enums in packages/shared/src/enums.ts, mirroring data-model.md: Role, ConsentStatus, ConsentSource, TemplateCategory, TemplateStatus, CampaignState, AudienceType, MessageStatus, SkipReason, NotificationType
- [X] T019 [P] Write failing tests for the role → permission matrix in packages/shared/src/permissions.test.ts, covering every row of the spec.md role table
- [X] T020 Implement the permission matrix and `can(role, permission)` in packages/shared/src/permissions.ts, with these permissions:
  - `users.manage`, `settings.view`, `settings.manage`, `numbers.view`, `numbers.manage`
  - `contacts.view`, `contacts.manage`, `contacts.delete`, `attributes.manage`
  - `templates.view`, `templates.manage`, `campaigns.view`, `campaigns.manage`, `campaigns.launch`
  - `data.export`, `phones.full`, `apikeys.manage`, `ratecard.manage`, `audit.view`
- [X] T021 [P] Write failing tests for message status precedence in packages/shared/src/status.test.ts: `canTransition`, FAILED only below DELIVERED, out-of-order updates, duplicates
- [X] T022 Implement the status precedence helpers from data-model.md §5 in packages/shared/src/status.ts
- [X] T023 [P] Write failing tests for the variable-key helpers in packages/shared/src/variables.test.ts: extracting `{{1}}` and named placeholders from template components, and building keys `BODY.n`, `HEADER.n`, `BUTTON.i.n`
- [X] T024 Implement the variable-key helpers in packages/shared/src/variables.ts

### Database

- [X] T025 Write the Prisma schema in apps/api/prisma/schema.prisma for every entity, enum, relation, unique constraint and index in data-model.md (users through notifications)
- [X] T026 Create the initial migration in apps/api/prisma/migrations/0001_init/migration.sql, with raw SQL for:
  - `citext` and `pg_trgm` extensions
  - trigram indexes on `contacts.name` and `contacts.phone_e164`
  - GIN index on `contacts.attributes`
  - partial unique index `messages(campaign_id, contact_id) WHERE campaign_id IS NOT NULL`
- [X] T027 Implement the seed script in apps/api/prisma/seed.ts:
  - args `--admin-email`, `--admin-password`, `--country` (default `US`), `--timezone` (default `UTC`)
  - creates an ACTIVE ADMIN with an argon2id hash
  - creates the settings row with keywords STOP/UNSUBSCRIBE and START
- [X] T028 Implement PrismaService (connect on init, shutdown hooks, typed helper for raw `FOR UPDATE SKIP LOCKED` queries) in apps/api/src/common/prisma/prisma.service.ts

### Common backend infrastructure

- [X] T029 Implement zod-validated env config for all `.env.example` variables in apps/api/src/common/config/config.ts. It must fail fast, and refuse to start unless Redis `maxmemory-policy` is `noeviction`.
- [X] T030 [P] Write failing unit tests for the AES-256-GCM token cipher in apps/api/test/unit/token-cipher.spec.ts: round trip, random IV, tampered data rejected, `v1:` prefix, wrong key rejected
- [X] T031 Implement the token cipher in apps/api/src/common/crypto/token-cipher.ts
- [X] T032 [P] Write failing unit tests for the phone utilities in apps/api/test/unit/phone.spec.ts: E.164 normalisation with the default country, invalid input, country derivation, masking to `•••• 1234`
- [X] T033 Implement the phone utilities with libphonenumber-js in apps/api/src/common/phone/phone.ts
- [X] T034 [P] Write failing unit tests for log redaction in apps/api/test/unit/log-masking.spec.ts: secrets and message text are removed, and phone fields (`phone`, `phone_e164`, `to`, `from`, `recipient_id`, `wa_id`) are masked to the last 4 digits (Principle VI)
- [X] T035 Configure logging in apps/api/src/common/logging/logging.module.ts:
  - nestjs-pino with redaction of authorization, cookie, accessToken, secrets and message text
  - phone fields masked with the phone utility (T033) through a pino serializer
  - an `x-request-id` correlation middleware
  - async context carrying userId, campaignId and messageId
- [X] T036 [P] Write failing integration tests in apps/api/test/integration/ops-endpoints.int-spec.ts: GET /health and GET /metrics return 401 without an `X-Ops-Token` header or with a wrong one, and 200 with the right one (Principle III)
- [X] T037 [P] Implement the metrics registry and the `/metrics` endpoint, protected by the `X-Ops-Token` header (env `OPS_TOKEN`, timing-safe compare), in apps/api/src/common/metrics/metrics.service.ts, with metrics `wbm_messages_total`, `wbm_send_errors_total`, `wbm_queue_depth`, `wbm_webhook_lag_seconds`, `wbm_campaigns_running`
- [X] T038 [P] Implement the global exception filter in apps/api/src/common/filters/http-exception.filter.ts. It returns the contract `Error` shape `{code, message, details, requestId}`; zod errors become 422 `VALIDATION_FAILED`.
- [X] T039 Implement the queue module in apps/api/src/common/queue/queue.module.ts:
  - ioredis connection factory
  - BullMQ queues `campaign-dispatch`, `webhooks`, `imports`, `maintenance`
  - a registry that creates `send:{numberId}` queues on demand
- [X] T040 [P] Implement the S3 storage service (put stream, get stream, delete, presigned GET) in apps/api/src/common/storage/storage.service.ts
- [X] T041 Create the entrypoints in apps/api/src/main.ts, apps/api/src/app.module.ts, apps/api/src/worker.ts, apps/api/src/worker.module.ts:
  - HTTP: global prefix `/api`, `rawBody: true`, cookie-parser, global exception filter, logging
  - worker: registers the BullMQ processors only

### Auth, RBAC, audit, notifications, settings

- [X] T042 [P] Write failing integration tests for POST /auth/login, POST /auth/logout and GET /auth/me in apps/api/test/integration/auth.int-spec.ts:
  - `sid` and `csrf` cookies are set on login
  - wrong password → 401; deactivated user → 401
  - logout requires CSRF
  - idle (12 h) and absolute (7 d) expiry
  - throttling → 429
- [X] T043 Implement AuthService in apps/api/src/modules/auth/auth.service.ts: argon2id verify, random session token with SHA-256 hash storage, sliding expiry, revoke-all for a user
- [X] T044 Implement login throttling (Redis fixed window, 10 attempts per 15 min per email+IP) in apps/api/src/modules/auth/login-throttle.service.ts
- [X] T045 Implement AuthController for /auth/login, /auth/logout and /auth/me per dashboard-api.openapi.yaml (httpOnly `sid` cookie + readable `csrf` cookie; audits `auth.login` and `auth.login_failed`) in apps/api/src/modules/auth/auth.controller.ts
- [X] T046 Implement the guards in apps/api/src/common/guards/session.guard.ts and apps/api/src/common/guards/csrf.guard.ts:
  - global SessionGuard: loads the user, rejects DEACTIVATED, updates `last_seen_at`
  - CsrfGuard: double-submit check on non-GET requests
  - `@Public()` decorator to opt out of both
- [X] T047 Implement PermissionsGuard and the `@Require(permission)` decorator using `@wbm/shared` permissions in apps/api/src/common/guards/permissions.guard.ts
- [X] T048 [P] Write failing unit tests for PhoneMaskInterceptor in apps/api/test/unit/phone-mask.interceptor.spec.ts: masks `@PhoneField` properties in nested objects and arrays for AGENT; leaves ADMIN and MANAGER untouched
- [X] T049 Implement the `@PhoneField()` decorator and PhoneMaskInterceptor in apps/api/src/common/interceptors/phone-mask.interceptor.ts
- [X] T050 Implement `AuditService.record(actor, action, target, metadata)` with the action list from data-model.md §1 as a typed union in apps/api/src/modules/audit/audit.service.ts
- [X] T051 [P] Implement NotificationsService (create for all admins or for one user) and GET /notifications and POST /notifications/{id}/read in apps/api/src/modules/notifications/notifications.service.ts, apps/api/src/modules/notifications/notifications.controller.ts
- [X] T052 [P] Implement GET/PATCH /settings in apps/api/src/modules/settings/settings.controller.ts: validate the ISO-2 country, IANA timezone, and uppercase non-overlapping keyword lists; audit `settings.updated`
- [X] T053 [P] Implement GET /health with database and Redis checks (503 when a dependency is down), protected by the same `X-Ops-Token` check as /metrics, in apps/api/src/modules/health/health.controller.ts

### Meta integration and webhook ingestion

- [X] T054 [P] Write failing unit tests for the Meta error classifier in apps/api/test/unit/meta-error-classifier.spec.ts. Cover every code in research R9 (transient, permanent, campaign-blocking); an unknown code counts as permanent.
- [X] T055 Implement the Meta error classifier in apps/api/src/modules/meta/meta-error-classifier.ts
- [X] T056 [P] Write failing nock-based unit tests for MetaGraphClient in apps/api/test/unit/meta-graph-client.spec.ts, covering:
  - `sendTemplate` request shape and the `messages[0].id` response
  - `listTemplates` with cursor paging, `createTemplate`, `deleteTemplate`
  - `getPhoneNumber` fields, `uploadMedia`
  - Graph error parsing
  - connection refused (pre-send error) vs. timeout after write (ambiguous outcome)
- [X] T057 Implement MetaGraphClient in apps/api/src/modules/meta/meta-graph.client.ts: fetch-based, uses `META_GRAPH_BASE_URL` + `META_GRAPH_API_VERSION`, bearer token, 10 s timeout, typed errors
- [X] T058 [P] Write failing unit tests for webhook signature verification in apps/api/test/unit/webhook-signature.spec.ts: valid, invalid, missing header, timing-safe compare over the raw bytes
- [X] T059 Implement the `X-Hub-Signature-256` verifier in apps/api/src/modules/webhooks/signature.ts
- [X] T060 [P] Write failing integration tests for webhook ingestion in apps/api/test/integration/webhooks-ingest.int-spec.ts:
  - GET /webhooks/meta handshake: 200 with the challenge, or 403
  - POST with a bad signature: 401 and a stored row with `payload = null`
  - POST with a valid signature: 200, a `webhook_events` row, and a queued job
- [X] T061 Implement WebhooksController (GET verify; POST verify → store → enqueue; `@Public`; no CSRF) in apps/api/src/modules/webhooks/webhooks.controller.ts
- [X] T062 Implement the webhook processor in apps/api/src/modules/webhooks/webhooks.processor.ts. It routes each `entry[].changes[]` item by `field` to registered handlers and records `processed_at` or `error` on `webhook_events`.

### Mock Meta (test double)

- [X] T063 Implement the mock Graph API in tools/mock-meta/src/server.ts. It accepts only the token `mock-token` and serves:
  - `POST /:ver/:phoneId/messages` returning a `wamid`
  - `GET`/`POST`/`DELETE /:ver/:wabaId/message_templates`, auto-approving new templates after 10 s
  - `GET /:ver/:phoneId` (number fields)
  - `POST /:ver/:phoneId/media`
  - phones ending in `0000` produce a 131026 failure
- [X] T064 Implement the signed webhook emitter in tools/mock-meta/src/webhook-emitter.ts. It posts to `MOCK_WEBHOOK_TARGET`:
  - a sent → delivered → read sequence including the `pricing` object
  - failed statuses
  - template status updates
  - configurable delays
- [X] T065 [P] Implement the inbound-message CLI `npm run mock:inbound -- --from <phone> --text <text>`, which sends a signed `messages` webhook, in tools/mock-meta/src/inbound-cli.ts

### Web foundation

- [X] T066 Implement the API client in apps/web/src/lib/api-client.ts: fetch with `credentials: 'include'`, copies the `csrf` cookie into `X-CSRF-Token`, parses the contract Error shape, redirects to /login on 401
- [X] T067 [P] Implement the TanStack Query provider and query-key factory in apps/web/src/lib/query.tsx
- [X] T068 [P] Implement the `usePermissions()` hook and `<Can permission>` component using `@wbm/shared` in apps/web/src/lib/permissions.tsx
- [X] T069 Implement the login page (email/password form, error and throttled states) in apps/web/src/app/(auth)/login/page.tsx
- [X] T070 Implement the dashboard shell in apps/web/src/app/(dashboard)/layout.tsx: loads `/auth/me`; sidebar filtered by permissions (Campaigns, Contacts, Templates, API messages, Settings)

**Checkpoint**: Foundation ready. A seeded admin can sign in, webhooks are verified and stored,
and mock-meta runs.

---

## Phase 3: User Story 1 - Send a broadcast to an uploaded contact list (Priority: P1) 🎯 MVP

**Goal**: An admin connects a number, syncs approved templates, uploads an opted-in list, maps
variables, sends, and sees each recipient's status (FR-001–FR-003, FR-016, FR-019–FR-022,
FR-025).

**Also in this phase** (moved earlier so the MVP meets the constitution):
- STOP/START keyword handling, from US2 (FR-012–FR-014, Principle I)
- contact data deletion, from US2 (FR-015, Principle III)
- pause/resume/cancel and the per-number kill switch, from US4 (FR-023, Principle I)

**Independent Test**: Use mock-meta with a test number and one approved template. Upload a 10-row
list and send. Every row ends as delivered/read or failed with a reason, and campaign totals
match the rows.

### Tests for User Story 1 (REQUIRED - Constitution Principle V) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T071 [P] [US1] Write failing integration tests in apps/api/test/integration/numbers.int-spec.ts:
  - POST /numbers with valid credentials (nock) → CONNECTED with display name, quality and throughput
  - invalid token → 422 and no row saved
  - duplicate `phone_number_id` → 409
  - the token is never returned
  - POST /numbers/{id}/refresh updates the fields
- [X] T072 [P] [US1] Write failing integration tests for POST /templates/sync in apps/api/test/integration/templates-sync.int-spec.ts: multi-page listing, upsert by waba+name+language, derived variables, status mapping, GET /templates
- [X] T073 [P] [US1] Write failing integration tests for POST /campaigns/{id}/audience-upload in apps/api/test/integration/campaign-upload.int-spec.ts:
  - `optInConfirmed` and a source note are required
  - valid rows → `campaign_upload_rows` + contacts upserted with UPLOAD_CONFIRMATION consent
  - invalid, duplicate and opted-out rows are counted
  - detected columns are returned
- [X] T074 [P] [US1] Write failing unit tests for the variable resolver in apps/api/test/unit/variable-resolver.spec.ts: column, field, attribute and static sources; fallback used; missing value without fallback → `MISSING_VARIABLE`
- [X] T075 [P] [US1] Write failing unit tests for the dispatcher in apps/api/test/unit/dispatcher.spec.ts: selects at most rate×2 PENDING rows, stops when the campaign is not RUNNING, uses idempotent job IDs `msg:{id}`, and auto-pauses the campaign (`sending_disabled`) when the number's kill switch is off
  - _Implemented:_ BullMQ forbids `:` in custom job ids, so send jobs use `msg-{id}`; they are removed on completion so a paused message can be re-enqueued after resume.
- [X] T076 [P] [US1] Write failing unit tests for the send processor in apps/api/test/unit/send-processor.spec.ts:

  | Case | Expected |
  |---|---|
  | Claim | QUEUED → SENDING before calling Meta |
  | Success | SENT with `wa_message_id` |
  | Transient error | back to QUEUED and retried, backoff 30 s / 2 min / 8 min, max 3 retries, then FAILED |
  | Permanent error | FAILED via UnrecoverableError |
  | Ambiguous timeout | FAILED with `unknown_outcome_not_retried` |
  | Campaign-blocking error | message back to PENDING; campaign auto-paused |
  | Consent changed meanwhile | SKIPPED `OPTED_OUT` |
  | API-origin message | sent without campaign checks |
  | Kill switch off (`sending_enabled = false`) | message back to PENDING with no Meta call; campaign auto-paused `sending_disabled` |

- [X] T077 [P] [US1] Write failing unit tests for the status webhook handler in apps/api/test/unit/status-handler.spec.ts:
  - dedupe on `wamid:status`
  - precedence rules; out-of-order timestamps filled
  - FAILED after DELIVERED is ignored
  - pricing stored
  - unknown wamid buffered 24 h
- [X] T078 [P] [US1] Write a failing end-to-end integration test for send-now in apps/api/test/integration/campaign-send.int-spec.ts:
  - flow: draft → upload → launch → nock Meta → signed status webhooks
  - exactly one message per recipient
  - the 131026 recipient is FAILED with a readable reason
  - totals match the rows; the campaign ends COMPLETED
- [X] T079 [P] [US1] Write failing integration tests for consent keywords via signed inbound webhooks in apps/api/test/integration/consent-keywords.int-spec.ts:
  - "STOP", "stop" and " Unsubscribe " → OPTED_OUT with source KEYWORD
  - "START" → OPTED_IN
  - an unknown sender is created
  - edited keyword lists are respected
- [X] T080 [P] [US1] Write a failing integration test for contact deletion in apps/api/test/integration/contact-deletion.int-spec.ts:
  - personal data and consent events are removed
  - messages keep status and country, with `contact_id` and phone set to null
  - campaign totals are unchanged
  - `contact.deleted` is audited
- [X] T081 [P] [US1] Write failing integration tests for pause/resume/cancel in apps/api/test/integration/campaign-control.int-spec.ts:
  - no sends more than 10 s after a pause; QUEUED messages return to PENDING
  - resume sends only to unsent recipients
  - cancel → remaining messages CANCELLED
  - zero duplicate Meta sends across the run
  - audits recorded
- [X] T082 [P] [US1] Write failing contract tests in apps/api/test/contract/us1.contract-spec.ts validating US1 responses against dashboard-api.openapi.yaml: /numbers, /templates, /templates/sync, /campaigns, /campaigns/{id}, /audience-upload, /estimate, /launch, /messages, /pause, /resume, /cancel, DELETE /contacts/{id}
- [ ] T083 [P] [US1] Write a failing Playwright e2e for the quickstart US1 row in apps/web/e2e/us1-broadcast.spec.ts: connect the mock number, sync templates, upload samples/contacts-10.csv, map BODY.1 → name, send, and see 9 delivered/read + 1 failed
  - _Status:_ spec written (apps/web/e2e/us1-broadcast.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack. The same flow passed as an HTTP smoke run against the real API, worker and mock-meta.

### Implementation for User Story 1

- [X] T084 [P] [US1] Create a sample file with 10 contacts (name, phone, city; one phone ending in 0000) in samples/contacts-10.csv
- [X] T085 [US1] Implement NumbersService in apps/api/src/modules/numbers/numbers.service.ts:
  - validate credentials via `MetaGraphClient.getPhoneNumber`, encrypt the token
  - map quality and throughput; refresh
  - disconnect auto-pauses running campaigns
  - audits: `number.connected`, `number.disconnected`, `number.credentials_changed`
- [X] T086 [US1] Implement NumbersController in apps/api/src/modules/numbers/numbers.controller.ts: GET/POST /numbers, GET/PATCH/DELETE /numbers/{id}, POST /numbers/{id}/refresh; `accessToken` is write-only
- [X] T087 [P] [US1] Implement the repeatable number refresh job in apps/api/src/modules/numbers/number-refresh.processor.ts: runs every 6 h; on an auth error sets CONNECTED → ERROR and creates a CREDENTIALS_FAILED notification
- [X] T088 [US1] Implement TemplatesSyncService in apps/api/src/modules/templates/templates-sync.service.ts: pages through `message_templates` per WABA, upserts, derives `variables` with the shared helper, maps statuses
- [X] T089 [US1] Implement the read and sync endpoints of TemplatesController (GET /templates, GET /templates/{id}, POST /templates/sync) in apps/api/src/modules/templates/templates.controller.ts
- [X] T090 [P] [US1] Implement MediaService and POST /media in apps/api/src/modules/media/media.service.ts, apps/api/src/modules/media/media.controller.ts: type and size validation, S3 upload, lazy per-number Meta media upload cached in `meta_media_ids`
- [X] T091 [US1] Implement CampaignsService and its controller in apps/api/src/modules/campaigns/campaigns.service.ts, apps/api/src/modules/campaigns/campaigns.controller.ts:
  - draft CRUD: POST/GET/PATCH/DELETE /campaigns, GET /campaigns/{id} with cached totals
  - `autoPause(campaignId, reason)`: RUNNING → PAUSED, sets `paused_reason`, creates a CAMPAIGN_AUTO_PAUSED notification, audits `campaign.auto_paused`
- [X] T092 [US1] Implement ConsentService in apps/api/src/modules/contacts/consent.service.ts: each status change and its `consent_events` row are written in one transaction; sources IMPORT, UPLOAD_CONFIRMATION, API, KEYWORD, MANUAL
- [X] T093 [US1] Implement the audience-upload endpoint and processor in apps/api/src/modules/campaigns/audience-upload.processor.ts:
  - stream the CSV from storage with csv-parse
  - normalise phones
  - write `campaign_upload_rows`
  - upsert contacts with UPLOAD_CONFIRMATION consent + consent_events
  - store counts and columns on `import_jobs`
- [X] T094 [US1] Implement the variable resolver in apps/api/src/modules/campaigns/variable-resolver.ts
- [X] T095 [US1] Implement POST /campaigns/{id}/estimate in apps/api/src/modules/campaigns/estimate.service.ts: eligible and excluded counts by reason, 3 rendered previews with masked phones; cost stays null until a rate card exists (US5)
- [X] T096 [US1] Implement LaunchService for send-now and POST /campaigns/{id}/launch in apps/api/src/modules/campaigns/launch.service.ts:
  - validate: APPROVED template, CONNECTED number with sending enabled, complete variable mapping
  - snapshot the UPLOAD audience into `messages` (PENDING or SKIPPED with reason), in batches
  - set RUNNING, enqueue dispatch, audit `campaign.launched`
- [X] T097 [US1] Implement SendQueueManager in apps/api/src/modules/sending/send-queue.manager.ts: creates and closes `send:{numberId}` queues and workers with limiter `{max: send_rate_per_second, duration: 1000}`, and applies rate changes live
  - _Implemented:_ the per-number rate is a BullMQ queue-level global rate limit (`setGlobalRateLimit(rate, 1000)`) set by the API on connect/PATCH, so rate changes apply live without restarting workers.
- [X] T098 [US1] Implement the dispatcher processor in apps/api/src/modules/sending/dispatcher.processor.ts. Every ~1 s while the campaign is RUNNING it:
  - first checks the number: if `sending_enabled` is false or the number is not CONNECTED, it calls `CampaignsService.autoPause` (T091) with `sending_disabled` or `number_unavailable` and stops
  - moves the next rate×2 PENDING rows to QUEUED using `FOR UPDATE SKIP LOCKED`
  - `addBulk`s jobs with jobId `msg:{id}`
  - re-schedules itself, stopping when nothing is pending
- [X] T099 [P] [US1] Implement the template payload builder in apps/api/src/modules/sending/template-payload.builder.ts: maps `resolved_params` to Meta components (header text or media id, body, URL button suffix)
- [X] T100 [US1] Implement the send processor in apps/api/src/modules/sending/send.processor.ts:
  - origins CAMPAIGN and API
  - re-check campaign state, consent and the number's kill switch (`sending_enabled = false` → message back to PENDING with no Meta call, campaign auto-paused `sending_disabled`)
  - claim QUEUED → SENDING; `MetaGraphClient.sendTemplate`
  - apply the classifier: retries with attempts 4 and backoff 30 s / 2 min / 8 min; UnrecoverableError for permanent; `CampaignsService.autoPause` for blocking
  - write `message_events` and metrics
- [X] T101 [US1] Implement the status webhook handler in apps/api/src/modules/webhooks/handlers/status.handler.ts: event dedupe, shared precedence helper, timestamps, pricing, errors → `failure_code` and `failure_reason`, metrics
- [X] T102 [US1] Implement the inbound message handler in apps/api/src/modules/webhooks/handlers/inbound.handler.ts:
  - normalise the text and match the settings keyword lists
  - update consent through ConsentService
  - create unknown contacts
  - dedupe on `id:inbound`
- [X] T103 [US1] Implement contact deletion with anonymisation of linked messages, plus DELETE /contacts/{id} (`contacts.delete` permission, audit `contact.deleted`), in apps/api/src/modules/contacts/contact-deletion.service.ts, apps/api/src/modules/contacts/contact-deletion.controller.ts
- [X] T104 [US1] Implement the campaign progress processor in apps/api/src/modules/campaigns/campaign-progress.processor.ts. Every 5 s for RUNNING and PAUSED campaigns it:
  - recomputes the totals JSON
  - marks the campaign COMPLETED once nothing is PENDING, QUEUED or SENDING
  - creates a CAMPAIGN_COMPLETED notification
- [X] T105 [US1] Implement CampaignControlService and POST /campaigns/{id}/pause, /resume and /cancel in apps/api/src/modules/campaigns/campaign-control.service.ts:
  - resume is guarded until the number is CONNECTED with sending enabled and the template is APPROVED
  - cancel marks PENDING and QUEUED messages CANCELLED
  - audits `campaign.paused`, `campaign.resumed`, `campaign.cancelled`
- [X] T106 [US1] Implement GET /campaigns/{id}/messages (paged, status filter, phone as `@PhoneField`) in apps/api/src/modules/campaigns/campaign-messages.controller.ts
- [X] T107 [P] [US1] Build the Numbers settings page in apps/web/src/app/(dashboard)/settings/numbers/page.tsx: list with status, quality and tier; connect dialog; refresh; edit send rate and kill switch
- [X] T108 [P] [US1] Build the Templates list page (status badges, category, language, Sync button) in apps/web/src/app/(dashboard)/templates/page.tsx
- [X] T109 [US1] Build campaign wizard steps 1–2 in apps/web/src/components/campaigns/wizard/basics-step.tsx and apps/web/src/components/campaigns/wizard/audience-step.tsx:
  - step 1: name, number, approved template
  - step 2: CSV upload with mandatory opt-in confirmation and source note, upload progress and skip counts
- [X] T110 [US1] Build campaign wizard steps 3–4 in apps/web/src/components/campaigns/wizard/mapping-step.tsx, apps/web/src/components/campaigns/wizard/review-step.tsx, apps/web/src/app/(dashboard)/campaigns/new/page.tsx:
  - step 3: map each variable key to a column, field, attribute or static value, with a fallback; preview
  - step 4: review eligible and excluded counts; Send now
- [X] T111 [US1] Build the campaign detail page in apps/web/src/app/(dashboard)/campaigns/[id]/page.tsx: live totals via 5 s polling while RUNNING, progress bar, recipient table with status filter and failure reasons, and an admin-only "Delete contact data" row action (calls DELETE /contacts/{id}, with confirmation)
- [X] T112 [P] [US1] Build the campaign controls (Pause, Resume and Cancel with confirmations; paused-reason banner) in apps/web/src/components/campaigns/campaign-controls.tsx
- [X] T113 [P] [US1] Build the campaigns list page (state, totals, creator, pagination) in apps/web/src/app/(dashboard)/campaigns/page.tsx

**Checkpoint**: User Story 1 is fully functional and testable on its own. This is the MVP, and it
already meets every constitution MUST: STOP handling, data deletion, pause, kill switch.

---

## Phase 4: User Story 2 - Manage contacts, tags, attributes and consent (Priority: P2)

**Goal**: A reusable contact base with imports, tags, typed attributes, filter-based audiences and
contact screens (FR-009–FR-011, FR-014). STOP/START handling and the deletion API already ship in
US1.

**Independent Test**: Import 100 contacts with tags and attributes. Send "STOP" from one test
phone. Build an audience filter, and verify that the counts exclude the unsubscribed contact.

### Tests for User Story 2 (REQUIRED - Constitution Principle V) ⚠️

- [X] T114 [P] [US2] Write failing integration tests in apps/api/test/integration/contacts.int-spec.ts for contacts CRUD, search by name or phone, filters by tag and consent, and POST /contacts/bulk (add/remove tag, set a typed attribute)
- [X] T115 [P] [US2] Write failing integration tests for tags and attribute definitions in apps/api/test/integration/tags-attributes.int-spec.ts: unique names and keys, value type validation, deleting an attribute removes its values
- [X] T116 [P] [US2] Write failing integration tests for POST /imports in apps/api/test/integration/imports.int-spec.ts:
  - column mapping; create vs. update by phone
  - tag, attribute and opt-in columns
  - row-level error CSV via GET /imports/{id}/errors
  - malformed file → 422
- [X] T117 [P] [US2] Write failing unit tests for the audience query builder in apps/api/test/unit/audience-query.builder.spec.ts:
  - tag rules and attribute operators eq, neq, contains, gt, lt, before, after, is_true, is_false
  - OPTED_OUT is always excluded; non-OPTED_IN contacts are excluded for MARKETING templates
- [X] T118 [P] [US2] Write failing contract tests for contacts, tags, attributes, imports and audience-preview responses in apps/api/test/contract/us2.contract-spec.ts
- [ ] T119 [P] [US2] Write a failing Playwright e2e for the quickstart US2 row in apps/web/e2e/us2-contacts.spec.ts: import samples/contacts-100.csv, check the error report, send STOP via mock:inbound, confirm the audience count excludes the contact
  - _Status:_ spec written (apps/web/e2e/us2-contacts.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack. The same flow passed as an HTTP smoke run against the real API, worker and mock-meta.

### Implementation for User Story 2

- [X] T120 [P] [US2] Create a sample file with 100 contacts, including tags, `city` and `last_order_date` attributes, and 3 invalid rows, in samples/contacts-100.csv
- [X] T121 [US2] Implement the attribute definitions service and controller, plus a typed value validator (TEXT, NUMBER, DATE, BOOLEAN), in apps/api/src/modules/contacts/attributes.controller.ts, apps/api/src/modules/contacts/attribute-validator.ts
- [X] T122 [P] [US2] Implement the tags controller (GET with contact counts, POST, DELETE) in apps/api/src/modules/contacts/tags.controller.ts
- [X] T123 [US2] Implement ContactsService and its controller in apps/api/src/modules/contacts/contacts.service.ts, apps/api/src/modules/contacts/contacts.controller.ts: create, read, update and list (delete already ships in US1 via T103), trigram search, tag and consent filters, bulk actions, phones as `@PhoneField`
- [X] T124 [US2] Implement the import endpoints and processor in apps/api/src/modules/imports/imports.controller.ts, apps/api/src/modules/imports/import.processor.ts:
  - multipart upload to storage
  - csv-parse streaming with BOM and delimiter detection
  - batch upserts of 1,000 rows (`INSERT … ON CONFLICT`)
  - tag, attribute and opt-in mapping
  - error CSV written to storage; counts recorded
- [X] T125 [US2] Implement AudienceQueryBuilder and POST /contacts/audience-preview in apps/api/src/modules/contacts/audience-query.builder.ts
- [X] T126 [US2] Extend LaunchService and the estimate service to support FILTER and ALL_OPTED_IN audiences through AudienceQueryBuilder, in apps/api/src/modules/campaigns/launch.service.ts, apps/api/src/modules/campaigns/estimate.service.ts
- [X] T127 [P] [US2] Build the contacts list page in apps/web/src/app/(dashboard)/contacts/page.tsx: search, tag and consent filters, multi-select bulk tag and attribute actions, masked phones for agents
- [X] T128 [P] [US2] Build the contact detail page in apps/web/src/app/(dashboard)/contacts/[id]/page.tsx: edit name, tags and attributes; consent status and history; delete with confirmation
- [X] T129 [P] [US2] Build the import page in apps/web/src/app/(dashboard)/contacts/import/page.tsx: file upload, column mapping with preview, opt-in confirmation, progress polling, error report download
- [X] T130 [P] [US2] Build the attributes & tags settings page and the consent keywords settings page in apps/web/src/app/(dashboard)/settings/attributes/page.tsx, apps/web/src/app/(dashboard)/settings/keywords/page.tsx
- [X] T131 [US2] Extend the wizard audience step with a Filter option (tag/attribute rule builder) and an All opted-in option, each with a live eligible count, in apps/web/src/components/campaigns/wizard/audience-step.tsx

**Checkpoint**: User Stories 1 and 2 both work on their own.

---

## Phase 5: User Story 3 - Create and submit message templates (Priority: P2)

**Goal**: Create, validate and submit templates in-platform, and see approval status update
automatically (FR-017–FR-019).

**Independent Test**: Create a marketing template with one variable and one URL button, then
submit it. The status appears as pending, then approved or rejected, without a manual refresh.

### Tests for User Story 3 (REQUIRED - Constitution Principle V) ⚠️

- [X] T132 [P] [US3] Write failing unit tests for the template rules in packages/shared/src/template-rules.test.ts:
  - name pattern; body ≤1024 chars; header and footer ≤60 chars
  - sequential placeholders; sample values required
  - ≤10 buttons, with URL ≤2 and phone ≤1
  - header media type and size
- [X] T133 [P] [US3] Write failing integration tests in apps/api/test/integration/templates-create.int-spec.ts:
  - POST /templates: 422 with field details on invalid input; nock Meta create → PENDING with `meta_template_id`
  - POST /templates/{id}/duplicate
  - DELETE /templates/{id}: 409 when the template is used by a scheduled or running campaign
- [X] T134 [P] [US3] Write failing integration tests for `message_template_status_update` webhooks in apps/api/test/integration/template-status.int-spec.ts:
  - APPROVED
  - REJECTED, with the reason stored
  - PAUSED or DISABLED auto-pauses the RUNNING campaigns that use the template and notifies admins
- [X] T135 [P] [US3] Write failing contract tests for template create, duplicate and delete, and for media responses, in apps/api/test/contract/us3.contract-spec.ts
- [ ] T136 [P] [US3] Write a failing Playwright e2e for the quickstart US3 row in apps/web/e2e/us3-templates.spec.ts: a marketing template with 1 variable and a URL button goes Pending → Approved without refresh; an invalid name is blocked
  - _Status:_ spec written (apps/web/e2e/us3-templates.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack.

### Implementation for User Story 3

- [X] T137 [US3] Implement the shared template rules, returning field-level issues for both web and api, in packages/shared/src/template-rules.ts
  - _Scope:_ AUTHENTICATION templates use Meta's fixed one-time-code format and are refused by the editor rules for now (create them in WhatsApp Manager; they still sync).
- [X] T138 [US3] Implement the template components builder (TemplateInput → Meta components with examples; header handle for media samples) in apps/api/src/modules/templates/template-components.builder.ts
- [X] T139 [P] [US3] Implement the Meta resumable upload for template header samples, returning `header_handle`, in apps/api/src/modules/media/meta-resumable-upload.ts. Verify the request and response shapes against Meta's docs.
  - _Implemented:_ verified against Meta's Resumable Upload guide (Graph v27.0): POST /{app-id}/uploads?file_name&file_length&file_type -> {id: "upload:..."}; POST /upload:<session> with `Authorization: OAuth`, `file_offset: 0` and the bytes -> {h}. Needs the new optional `META_APP_ID` setting.
- [X] T140 [US3] Implement TemplatesService and its endpoints in apps/api/src/modules/templates/templates.service.ts: create and submit, duplicate, delete (local + Meta); POST /templates, POST /templates/{id}/duplicate, DELETE /templates/{id}
- [X] T141 [US3] Implement the template status webhook handler in apps/api/src/modules/webhooks/handlers/template-status.handler.ts:
  - idempotent status and reason update
  - for PAUSED or DISABLED, call `CampaignsService.autoPause(…, 'template_<status>')` for every RUNNING campaign that uses the template
- [X] T142 [US3] Build the template editor in apps/web/src/app/(dashboard)/templates/new/page.tsx and apps/web/src/components/templates/template-preview.tsx:
  - fields: category, language, header type, body with variable insertion and sample inputs, footer, buttons
  - live phone preview
  - field errors from the shared rules
- [X] T143 [P] [US3] Build the template detail page in apps/web/src/app/(dashboard)/templates/[id]/page.tsx: status, rejection reason, variables, "Duplicate & edit", Delete; polls every 10 s while PENDING

**Checkpoint**: Templates can be authored in the platform. US1 and US2 are still independent.

---

## Phase 6: User Story 4 - Schedule and control running campaigns (Priority: P3)

**Goal**: Scheduling with timezones, the messaging-limit warning, quality alerts and the
notifications bell (FR-026, FR-027, FR-038). Pause/resume/cancel (FR-023) already ships in US1.

**Independent Test**: Schedule a 1,000-recipient campaign 5 minutes ahead, pause it midway, then
resume. It must start on time, no recipient may get two messages, and simulated temporary failures
must be retried.

### Tests for User Story 4 (REQUIRED - Constitution Principle V) ⚠️

- [X] T144 [P] [US4] Write failing integration tests for scheduling in apps/api/test/integration/campaign-schedule.int-spec.ts:
  - launch with a future `scheduledAt` → SCHEDULED + a delayed job
  - the campaign starts within 1 min via the reconciler after a simulated job loss
  - a past time → 422
  - POST /campaigns/{id}/unschedule → DRAFT
- [X] T145 [P] [US4] Write failing integration tests in apps/api/test/integration/campaign-autopause.int-spec.ts:
  - _Implemented:_ blocking send errors now also mark their cause - credential/account codes (190, 10, 368, 133010) move the number to ERROR (resume stays blocked until the token is fixed); 132015/132016 mark the template PAUSED/DISABLED.
  - token expired (190) mid-campaign and number disconnected both auto-pause the campaign with a reason
  - resume is rejected while the blocking condition persists
  - a `phone_number_quality_update` downgrade creates a QUALITY_DROPPED notification
- [ ] T146 [P] [US4] Write a failing Playwright e2e for the quickstart US4 row in apps/web/e2e/us4-control.spec.ts: schedule 1,000 recipients 2 min ahead, pause at ~30%, resume, and assert 1,000 unique sends recorded by mock-meta
  - _Status:_ spec written (apps/web/e2e/us4-control.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack. A live HTTP smoke (real worker + mock-meta) scheduled 109 recipients 70 s ahead: started 0.2 s after the scheduled time, 109 unique sends.

### Implementation for User Story 4

- [X] T147 [US4] Implement scheduling and POST /campaigns/{id}/unschedule in apps/api/src/modules/campaigns/schedule.service.ts: a launch with `scheduledAt` sets SCHEDULED and adds a delayed `start:{campaignId}` job; the audience snapshot is taken at start time
  - _Implemented:_ BullMQ forbids `:` in job ids, so the start job is `start-{campaignId}-{epochMs}` on the maintenance queue (job name `campaign-start`). Cancel and unschedule remove it.
- [X] T148 [US4] Implement the schedule reconciler (repeatable every 30 s; starts due SCHEDULED campaigns idempotently) in apps/api/src/modules/campaigns/schedule-reconciler.processor.ts
- [X] T149 [US4] Add the messaging-limit warning (eligible count > stored `messaging_limit_tier`) to the estimate response in apps/api/src/modules/campaigns/estimate.service.ts
- [X] T150 [P] [US4] Implement the `phone_number_quality_update` webhook handler in apps/api/src/modules/webhooks/handlers/quality.handler.ts: updates quality and tier; creates a QUALITY_DROPPED notification on a downgrade
  - _Implemented:_ per Meta's reference (Graph v27) the webhook carries `display_phone_number`, `event` and the tier (`max_daily_conversations_per_business`, deprecated `current_limit`/`old_limit`) but no quality colour, so the handler re-reads quality from the Graph API; a lower tier (or legacy FLAGGED/DOWNGRADE) notifies admins.
- [X] T151 [US4] Add scheduling (date-time + timezone picker, defaulting to the company timezone) and the messaging-limit warning to the wizard review step, plus an Unschedule button and the scheduled time on the campaign detail page, in apps/web/src/components/campaigns/wizard/review-step.tsx, apps/web/src/app/(dashboard)/campaigns/[id]/page.tsx
- [X] T152 [P] [US4] Build the notifications bell (unread count, list, mark read, deep links) in apps/web/src/components/layout/notifications-bell.tsx

**Checkpoint**: Scheduled campaigns start on time, and quality problems reach admins.

---

## Phase 7: User Story 5 - Campaign reports, cost estimate and retargeting (Priority: P3)

**Goal**: Reports with rates, failure reasons and a USD cost estimate; recipient export; one-click
retargeting (FR-028–FR-031).

**Independent Test**: After a test campaign, report totals equal the recipient export, the cost
matches the rate card, and "Retarget → Not read" creates a correct draft.

### Tests for User Story 5 (REQUIRED - Constitution Principle V) ⚠️

- [X] T153 [P] [US5] Write failing unit tests for the cost calculator in apps/api/test/unit/cost-calculator.spec.ts:
  - picks the latest effective rate per category + country, falling back to `*`
  - a message is billable from the webhook pricing, else when delivered
  - results are integer micros
- [X] T154 [P] [US5] Write failing integration tests in apps/api/test/integration/reports.int-spec.ts:
  - GET /campaigns/{id}/report: totals, delivery and read rates, failure reasons, estimated cost flagged as an estimate
  - GET /campaigns/{id}/export: rows equal the report totals; audited; 403 for AGENT
- [X] T155 [P] [US5] Write failing integration tests in apps/api/test/integration/retarget-ratecard.int-spec.ts:
  - POST /campaigns/{id}/retarget for FAILED, NOT_READ, READ and DELIVERED; opted-out contacts excluded; the new DRAFT has `source_campaign_id`
  - PUT /rate-card validation
- [X] T156 [P] [US5] Write failing contract tests for report, rate-card and retarget responses in apps/api/test/contract/us5.contract-spec.ts
- [ ] T157 [P] [US5] Write a failing Playwright e2e for the quickstart US5 row (report, export, retarget) in apps/web/e2e/us5-reports.spec.ts
  - _Status:_ spec written (apps/web/e2e/us5-reports.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack.

### Implementation for User Story 5

- [X] T158 [P] [US5] Implement the rate card service and GET/PUT /rate-card in apps/api/src/modules/rate-card/rate-card.controller.ts: USD ↔ micros conversion, unique category/country/date, audit `rate_card.updated`
- [X] T159 [US5] Implement CostCalculator in apps/api/src/modules/reports/cost-calculator.ts, and call it from apps/api/src/modules/webhooks/handlers/status.handler.ts to set `cost_usd_micros` on billable delivered messages
- [X] T160 [US5] Add the pre-launch cost estimate (eligible × rate for the template category and each recipient's country) in apps/api/src/modules/campaigns/estimate.service.ts
- [X] T161 [US5] Implement ReportsService and GET /campaigns/{id}/report (totals, rates, failure-reason breakdown, cost) in apps/api/src/modules/reports/reports.service.ts
- [X] T162 [US5] Implement the streaming CSV export GET /campaigns/{id}/export (requires `data.export`; audit `data.exported`) in apps/api/src/modules/reports/export.controller.ts
  - _Implemented:_ CSV cells starting with = + - @ are prefixed with ' against spreadsheet formula injection, except plain numbers and E.164 phone numbers.
- [X] T163 [US5] Implement RetargetService and POST /campaigns/{id}/retarget (RETARGET audience snapshotted from the source campaign's messages by status) in apps/api/src/modules/campaigns/retarget.service.ts
  - _Contract fix:_ dashboard-api.openapi.yaml now lists RETARGET in `audienceType` (set only by POST /campaigns/{id}/retarget) and `retargetStatus` on Campaign; groups are FAILED=failed, NOT_READ=sent or delivered, READ=read, DELIVERED=delivered or read; recipients are snapshotted at launch and uploaded columns of the source campaign still feed variables.
- [X] T164 [P] [US5] Build the campaign report page in apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx: stat cards, rates, failure-reason table, cost-estimate note, Export and Retarget actions
- [X] T165 [P] [US5] Build the rate card settings page (editable table by category, country and effective date) in apps/web/src/app/(dashboard)/settings/rate-card/page.tsx

**Checkpoint**: Campaign results and costs can be measured and acted on.

---

## Phase 8: User Story 6 - Team access, roles and audit (Priority: P3)

**Goal**: Invitations, role and status management, permission enforcement on every endpoint,
masking for agents, and a complete audit log (FR-005–FR-008).

**Independent Test**: Invite one user per role, check each permission in the role table from each
account, and confirm the audit log shows the actions.

### Tests for User Story 6 (REQUIRED - Constitution Principle V) ⚠️

- [X] T166 [P] [US6] Write failing integration tests in apps/api/test/integration/users.int-spec.ts:
  - invitations: creating one returns a link; email is sent when SMTP is configured; accepting sets the password and activates the user; an expired or used token → 404
  - PATCH /users/{id}: role change; deactivation revokes sessions; the last active admin is protected (409)
- [X] T167 [P] [US6] Write failing table-driven integration tests in apps/api/test/integration/rbac.int-spec.ts asserting each endpoint's `x-permission` for ADMIN, MANAGER and AGENT (403 when the permission is missing)
  - _Implemented:_ the test reads every operation with `x-permission` from dashboard-api.openapi.yaml and checks all three roles against the shared role table (the US7 key endpoints are covered since US7).
- [X] T168 [P] [US6] Write failing integration tests for AGENT phone masking on contacts, campaign messages, API messages and estimate previews in apps/api/test/integration/masking.int-spec.ts
- [X] T169 [P] [US6] Write failing integration tests in apps/api/test/integration/audit.int-spec.ts: each audited action in data-model.md §1 writes an entry; GET /audit-logs is admin-only and supports filters
- [ ] T170 [P] [US6] Write a failing Playwright e2e for the quickstart US6 row (manager and agent permissions, masked phones, audit entries) in apps/web/e2e/us6-roles.spec.ts
  - _Status:_ spec written (apps/web/e2e/us6-roles.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack.

### Implementation for User Story 6

- [X] T171 [US6] Implement InvitationsService and its endpoints in apps/api/src/modules/users/invitations.service.ts:
  - POST /users/invitations, GET /auth/invitations/{token}, POST /auth/invitations/{token}/accept
  - hashed token, 7-day expiry, single use
  - audit `user.invited`
- [X] T172 [P] [US6] Implement the optional SMTP mailer (nodemailer when `SMTP_URL` is set, otherwise a no-op that logs) in apps/api/src/modules/users/mailer.service.ts
- [X] T173 [US6] Implement UsersController (GET /users; PATCH /users/{id} for role and status, with session revocation, the last-admin guard and audits) in apps/api/src/modules/users/users.controller.ts
- [X] T174 [US6] Implement GET /audit-logs with action and actor filters and pagination in apps/api/src/modules/audit/audit.controller.ts
- [X] T175 [US6] Audit-coverage pass in apps/api/src/modules/audit/audit-actions.ts: make sure every action in data-model.md §1 is recorded across the auth, numbers, campaigns, contacts, reports, settings and rate-card modules, and keep the typed action list there in sync
  - _Implemented:_ the typed list lives in apps/api/src/modules/audit/audit-actions.ts; test/unit/audit-coverage.spec.ts fails if an action is never recorded (api_key.* recorded since US7).
- [X] T176 [US6] Masking-coverage pass: apply `@PhoneField()` to every response DTO that exposes phones, in apps/api/src/modules/contacts/dto/, apps/api/src/modules/campaigns/dto/, apps/api/src/modules/reports/dto/
  - _Implemented:_ response mappers live next to their services (no dto/ folders); the global PhoneMaskInterceptor masks `phone`/`phoneE164` for agents and `@PhoneField` is set on the contacts and campaign-messages controllers; verified by masking.int-spec.ts.
- [X] T177 [P] [US6] Build the invitation accept page (name + password) in apps/web/src/app/(auth)/invite/[token]/page.tsx
- [X] T178 [P] [US6] Build the team settings page in apps/web/src/app/(dashboard)/settings/team/page.tsx: invite dialog with a copyable link, role change, deactivate/reactivate
- [X] T179 [P] [US6] Build the audit log page (filters, pagination) in apps/web/src/app/(dashboard)/settings/audit/page.tsx
- [X] T180 [US6] Gate the launch, export, delete and manage actions with `<Can>` across campaign, contact, template and settings pages, in apps/web/src/app/(dashboard)/

**Checkpoint**: Team rollout is safe. Every permission is enforced server-side and reflected in the
UI.

---

## Phase 9: User Story 7 - Send template messages from other company systems (Priority: P4)

**Goal**: Keyed public API v1 for template sends and status lookup, with idempotency and rate
limits (FR-032–FR-037).

**Independent Test**: Create a key and send one approved template to a test number, then look up
its status. Repeat with the same idempotency key, and send to an opted-out number.

### Tests for User Story 7 (REQUIRED - Constitution Principle V) ⚠️

- [X] T181 [P] [US7] Write failing integration tests for API keys in apps/api/test/integration/api-keys.int-spec.ts: create (secret shown once, hash stored), list (last4 only), revoke
- [X] T182 [P] [US7] Write failing integration tests for the public API in apps/api/test/integration/public-api.int-spec.ts:

  | Case | Expected |
  |---|---|
  | Valid send | 202, status QUEUED |
  | Invalid or revoked key | 401 |
  | Unknown template | 404 |
  | Not sendable | 422: TEMPLATE_NOT_APPROVED, INVALID_NUMBER, CONTACT_OPTED_OUT, NO_OPT_IN, PARAMS_MISMATCH |
  | Same Idempotency-Key, same body | 200 with the same id |
  | Same key, different body | 409 |
  | Over the limit | 429 with Retry-After |

  Also cover GET /api/v1/messages/{id} history and GET /api/v1/templates.
- [X] T183 [P] [US7] Write failing contract tests against public-api.openapi.yaml in apps/api/test/contract/public-api.contract-spec.ts
- [ ] T184 [P] [US7] Write a failing Playwright e2e for the quickstart US7 row, using Playwright's request API for the two idempotent calls, in apps/web/e2e/us7-api.spec.ts
  - _Status:_ spec written (apps/web/e2e/us7-api.spec.ts); not yet executed - needs `npx playwright install chromium` (v1255) and the full local stack.

### Implementation for User Story 7

- [X] T185 [US7] Implement ApiKeysService and its controller in apps/api/src/modules/api-keys/api-keys.service.ts:
  - GET/POST /api-keys, DELETE /api-keys/{id}
  - key format `wbk_` + 32 base62 chars; store the SHA-256 hash, prefix and last4
  - audits `api_key.created` and `api_key.revoked`
- [X] T186 [US7] Implement ApiKeyGuard (parse Bearer, look up by prefix, compare hash, check revoked, update `last_used_at`) in apps/api/src/modules/public-api/api-key.guard.ts
  - _Implemented:_ the key is found by its unique SHA-256 `key_hash` (same check as prefix + hash compare, with no timing-sensitive comparison in code); `last_used_at` is written at most once a minute.
- [X] T187 [P] [US7] Implement the per-key rate-limit guard (Redis INCR + EXPIRE 60 s, default 60/min from the key, 429 + Retry-After) in apps/api/src/modules/public-api/rate-limit.guard.ts
  - _Implemented:_ INCR and `EXPIRE 60 NX` run in one MULTI, so every window key gets its TTL; responses also carry X-RateLimit-Limit/Remaining.
- [X] T188 [P] [US7] Implement IdempotencyService in apps/api/src/modules/public-api/idempotency.service.ts: normalised body hash, 24 h records, 409 on a body mismatch, and an hourly cleanup job on the `maintenance` queue
  - _Implemented:_ hourly `idempotency-cleanup` job scheduler in idempotency-cleanup.processor.ts; when a message cannot be queued its key is freed so the caller can retry.
- [X] T189 [US7] Implement POST /api/v1/messages and GET /api/v1/messages/{id} in apps/api/src/modules/public-api/public-messages.controller.ts:
  - validate the template is APPROVED, the phone, the consent rules and the params
  - optional contact upsert with API consent
  - create an API-origin message and enqueue it directly to `send:{numberId}`
  - _Implemented:_ checks live in public-api.service.ts. A malformed body is 400 (public contract), a missing opt-in source note too; an API call never undoes an opt-out; `headerMediaUrl` goes to Meta as a header `link`; send workers for numbers connected after boot start within 30 s (`send-workers` maintenance job).
- [X] T190 [P] [US7] Implement GET /api/v1/templates (approved templates with variable keys) in apps/api/src/modules/public-api/public-templates.controller.ts
- [X] T191 [P] [US7] Implement the GET /api-messages log (paged, filter by key, phones as `@PhoneField`) in apps/api/src/modules/reports/api-messages.controller.ts
  - _Implemented:_ items add template name/language, key name and createdAt; the page shows each message's status timeline.
- [X] T192 [P] [US7] Build the API keys settings page (create with a one-time secret dialog and copy button, list, revoke) in apps/web/src/app/(dashboard)/settings/api-keys/page.tsx
- [X] T193 [P] [US7] Build the API messages log page in apps/web/src/app/(dashboard)/api-messages/page.tsx

**Checkpoint**: All seven user stories work on their own.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Operations, performance, security, packaging and release validation.

- [X] T194 [P] Write Prometheus alert rules in ops/alerts.yml:
  - failure rate >5% over 10 min
  - queue depth not decreasing for 5 min
  - webhook lag p95 >60 s
  - no webhooks for 15 min while campaigns are running
  - _Implemented:_ 6 rules, including a send-queue stall rule (send queues keep a steady buffer, so their depth alone is no stall signal) and a target-down rule. Both processes now fill `wbm_queue_depth` at scrape time. promtool passes, and test/unit/alerts.spec.ts keeps the metric names in sync.
- [X] T195 [P] Implement retention jobs in apps/api/src/modules/maintenance/retention.processor.ts: purge campaigns and messages older than 12 months, and `webhook_events` and import files older than 30 days; keep audit logs at least 12 months
  - _Implemented:_ a daily job at 03:15 UTC (not monthly). It purges COMPLETED/CANCELLED campaigns 12 months after they end, with their messages, events, upload rows and import jobs, and API messages after 12 months. Webhook events and `uploads/` objects go after 30 days, and their error-report links are cleared. Audit logs are untouched. Covered by retention.int-spec.ts.
- [X] T196 [P] Create performance scripts in tools/perf/campaign-10k.ts and tools/perf/import-50k.ts:
  - a 10k-recipient campaign against mock-meta finishes within 20 min at the configured rate (SC-002)
  - a 50k-row import finishes within 5 min (SC-007)
  - _Implemented:_ the scripts call the API directly (`npm run perf:campaign`, `npm run perf:import`) and print PASS/FAIL. They have not been run yet (see T200).
- [X] T197 [P] Add multi-stage Dockerfiles in apps/api/Dockerfile and apps/web/Dockerfile: the api image runs `node dist/main.js` or `node dist/worker.js`; the web image uses Next.js standalone output; the api HEALTHCHECK calls /api/health with the `X-Ops-Token` header
  - _Implemented:_ the api image has a `migrate` target. `healthcheck.mjs` checks /api/health or the worker's /health, depending on PID 1's command. The web build takes `API_INTERNAL_URL` as a build argument (standalone output, tracing root = repo root). `docker build --check` passes; full builds run in the CI `docker-images` job.
- [X] T198 Security hardening in apps/api/src/main.ts, apps/web/next.config.ts, .github/workflows/ci.yml:
  - helmet headers; production cookie flags (Secure, SameSite)
  - CSP for the web app
  - a clean `npm audit`
  - a gitleaks secret-scan step in CI
  - _Implemented:_ helmet sends `default-src 'none'` on API responses. Production refuses `COOKIE_SECURE=false` or a non-https `APP_URL`. Web CSP and security headers are in next.config.ts (tests/security-headers.test.ts). `npm audit` is clean and gated in CI, and a gitleaks job was added. The API also trusts X-Forwarded-For from private peers, so the login throttle sees real client IPs.
- [X] T199 [P] Write the root README (overview, architecture summary, links to the spec, plan, quickstart and ADRs) in README.md
- [ ] T200 Run every quickstart.md validation row end to end, fix any gaps, and record the results in specs/001-whatsapp-bulk-messaging/checklists/release.md
  - _Status:_ the automated gates pass and four gaps were fixed (see checklists/release.md). The full integration project passes (29 files, 127 tests, 2026-11-19), and SC-007 passes (50k import in 1m 13s). The live runs found three more bugs, all fixed with tests: the worker could not boot, imports failed on a 2-second connection wait, and delivery statuses were lost under load. SC-002 also passes: 10k sent in 10m 59s, no duplicates, all statuses final (9,999 read, 1 failed). Still to run: the Playwright specs and the Docker builds, which need more RAM than this machine has (CI).
- [X] T201 Check that ADR-0001 to ADR-0005 still match the implementation, then mark them Accepted or propose amendments, in history/adr/
  - _Implemented:_ all five ADRs are marked Accepted, with implementation notes: queue and job ID naming, daily retention, API sends skipping the dispatcher, hash lookup for API keys, and the proxy-aware client IP.

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | Depends on | Notes |
|---|---|---|
| Setup (Phase 1) | — | Start immediately |
| Foundational (Phase 2) | Setup | **Blocks all user stories** |
| US1 (Phase 3, P1, MVP) | Foundational | Creates templates read/sync, campaigns, sending, the status handler and `CampaignsService.autoPause`. It also delivers STOP/START handling, contact deletion and pause/resume/cancel (constitution safety controls). Later stories build on these |
| US2 (Phase 4, P2) | Foundational | Integrates with US1's LaunchService and wizard (T126, T131) |
| US3 (Phase 5, P2) | Foundational + US1 templates module (T088–T089) | Template status auto-pause uses T091 |
| US4 (Phase 6, P3) | US1 | Scheduling builds on US1's launch and control services |
| US5 (Phase 7, P3) | US1 | Messages and status handler; cost estimate extends T095 |
| US6 (Phase 8, P3) | Foundational | Coverage passes T175–T176 should run after the stories they cover |
| US7 (Phase 9, P4) | Foundational + US1 send processor and templates sync | |
| Polish (Phase 10) | All desired stories | |

### Story completion graph

```text
Setup → Foundational → US1 (MVP) ─┬─> US2 ─┐
                                  ├─> US3 ─┤
                                  ├─> US4 ─┼─> Polish
                                  ├─> US5 ─┤
                                  └─> US7 ─┘
            Foundational ───────────> US6 ─┘   (coverage passes T175–T176 after US1–US5)
```

### Within each user story

1. Write the tests and confirm they fail.
2. Build services in dependency order: models/schema → services → controllers/processors → UI.
3. Make all the story's tests pass, then check the story's checkpoint before moving on.

---

## Parallel Examples

### Foundational

```bash
# After T025–T028 (schema), run in parallel:
Task: "T030 token cipher tests in apps/api/test/unit/token-cipher.spec.ts"
Task: "T032 phone utils tests in apps/api/test/unit/phone.spec.ts"
Task: "T054 Meta error classifier tests in apps/api/test/unit/meta-error-classifier.spec.ts"
Task: "T056 MetaGraphClient tests in apps/api/test/unit/meta-graph-client.spec.ts"
Task: "T058 webhook signature tests in apps/api/test/unit/webhook-signature.spec.ts"
```

### User Story 1

```bash
# All US1 tests together (T071–T083), then models/services in parallel where marked:
Task: "T084 samples/contacts-10.csv"
Task: "T090 MediaService in apps/api/src/modules/media/media.service.ts"
Task: "T099 template payload builder in apps/api/src/modules/sending/template-payload.builder.ts"
Task: "T107 Numbers settings page" ; Task: "T108 Templates list page" ; Task: "T113 Campaigns list page"
```

### User Story 2

```bash
Task: "T114 contacts tests" ; Task: "T116 imports tests" ; Task: "T117 audience builder tests"
Task: "T122 tags controller" ; Task: "T127 contacts list page" ; Task: "T129 import page"
```

### User Story 3

```bash
Task: "T132 template rules tests" ; Task: "T133 template create tests" ; Task: "T134 template status tests"
Task: "T139 resumable upload" ; Task: "T143 template detail page"
```

### User Story 4

```bash
Task: "T144 scheduling tests" ; Task: "T145 auto-pause tests"
Task: "T150 quality handler" ; Task: "T152 notifications bell"
```

### User Story 5

```bash
Task: "T153 cost calculator tests" ; Task: "T154 report tests" ; Task: "T155 retarget/rate-card tests"
Task: "T158 rate card controller" ; Task: "T164 report page" ; Task: "T165 rate card page"
```

### User Story 6

```bash
Task: "T166 users tests" ; Task: "T167 RBAC tests" ; Task: "T168 masking tests" ; Task: "T169 audit tests"
Task: "T172 mailer" ; Task: "T177 invite page" ; Task: "T178 team page" ; Task: "T179 audit page"
```

### User Story 7

```bash
Task: "T181 API key tests" ; Task: "T182 public API tests" ; Task: "T183 public contract tests"
Task: "T187 rate-limit guard" ; Task: "T188 idempotency service" ; Task: "T190 public templates" ; Task: "T192 API keys page"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1: Setup (T001–T017)
2. Phase 2: Foundational (T018–T070). This is critical: it blocks every story.
3. Phase 3: US1 (T071–T113)
4. **Stop and validate**: run the quickstart US1 row and the US1 tests, then demo the first real
   broadcast on a test number.

### Incremental delivery

| Increment | Adds | Unlocks |
|---|---|---|
| 1 | US1 | First broadcasts (MVP) |
| 2 | US2 + US3 (both P2; can run in parallel) | Saved audiences and in-platform templates |
| 3 | US4 + US5 (P3) | Safe scheduling and control; measurement |
| 4 | US6 (P3) | Team rollout with roles and audit |
| 5 | US7 (P4) | System integrations |
| 6 | Polish | Release readiness (alerts, performance, security, Docker, README) |

### Parallel team strategy

After Foundational is done:

| Developer | Assignment |
|---|---|
| A | US1, then US4 |
| B | US2, then US5 |
| C | US3 + US6, then US7 |

---

## Notes

- [P] tasks touch different files and have no unfinished dependencies.
- [USn] labels map each task to its spec user story for traceability.
- Every story's tests must fail before its implementation starts (Constitution Principle V).
- Never call the real Meta API in automated tests. Use nock or `tools/mock-meta`.
- Commit after each task or logical group, and stop at each checkpoint to validate the story.
- Verify-at-implementation items:
  - the Meta messaging-limit field
  - the resumable-upload shape
  - the webhook field names

  Check them against Meta's docs when coding T057, T139, T150 and T062.
