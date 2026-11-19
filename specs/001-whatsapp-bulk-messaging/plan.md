# Implementation Plan: WhatsApp Bulk Messaging Core

**Branch**: `001-whatsapp-bulk-messaging` | **Date**: 2026-11-16 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-whatsapp-bulk-messaging/spec.md`

**Note**: This template is filled in by the `/sp.plan` command. See `.claude/commands/sp.plan.md` for the execution workflow.

## Summary

This is an internal, single-company platform for sending WhatsApp template broadcasts at scale
through Meta's Cloud API. It covers:
- number connection
- consent-aware contacts
- template authoring and sync
- throttled, pausable campaigns with per-recipient status tracking
- USD cost reports with one-click retargeting
- role-based team access with an audit log
- a keyed REST API for other company systems

**Technical approach:**
- **Code layout:** an npm-workspaces monorepo. A Next.js dashboard and a NestJS API + worker share
  one PostgreSQL schema (Prisma).
- **Queues:** Redis/BullMQ powers a campaign *dispatcher*, per-number rate-limited send queues,
  scheduled starts and webhook processing.
- **Webhooks:** Meta webhooks are signature-verified, stored raw, and processed idempotently with
  a status-precedence model.
- **Delivery guarantee:** each recipient gets at most one message per campaign (claim-before-send)
  to guarantee zero duplicates.

Decisions with rationale are in [research.md](./research.md). Entities are in
[data-model.md](./data-model.md). Interfaces are in [contracts/](./contracts/). The developer flow
is in [quickstart.md](./quickstart.md).

Architecture decisions (status: Proposed) are recorded as ADRs in `history/adr/`:
- [ADR-0001 Frontend Stack](../../history/adr/0001-frontend-stack.md)
- [ADR-0002 Backend Runtime, Process Model and Monorepo](../../history/adr/0002-backend-runtime-process-model-and-monorepo.md)
- [ADR-0003 Data, Queue and Storage Architecture](../../history/adr/0003-data-queue-and-storage-architecture.md)
- [ADR-0004 Campaign Delivery and Webhook Processing Model](../../history/adr/0004-campaign-delivery-and-webhook-processing.md)
- [ADR-0005 Security, Access and API Key Architecture](../../history/adr/0005-security-access-and-api-key-architecture.md)

## Technical Context

**Language/Version**: TypeScript 6.0 (ESM, module nodenext) on Node.js 26 LTS
**Primary Dependencies**: Next.js 16.4 + React 19.3 + TanStack Query 5 + Tailwind CSS 4 (web); NestJS 12.5 + Prisma 7.10 + BullMQ 6.7 + ioredis 6 + nestjs-pino 5 + zod 4 + argon2 + csv-parse 7 + libphonenumber-js + AWS SDK S3 v3 + prom-client 15 (api/worker)
**Storage**: PostgreSQL 16+ (Neon in production, Docker locally) via Prisma migrations; Redis 7+ (noeviction, AOF) for queues and rate limits; S3-compatible object storage (MinIO locally) for uploads and media
**Testing**: Vitest 5 (+ unplugin-swc for the API) for unit, integration and contract tests; Supertest 7 with Docker Compose Postgres/Redis; nock 15 for Meta Graph API mocks; Playwright 1.65 + tools/mock-meta (e2e)
**Target Platform**: Linux containers (Docker) for web, api and worker; evergreen browsers (last 2 versions of Chrome, Edge, Firefox, Safari)
**Project Type**: web - npm-workspaces monorepo with apps/web (Next.js), apps/api (NestJS HTTP + worker entrypoints), packages/shared, tools/mock-meta
**Performance Goals**: 10k-recipient campaign within 20 min (at least 9 msg/s sustained, configurable to 80 msg/s per number); 99% of status updates visible within 1 min; 99.5% of public-API sends accepted within 2 s; 50k-row import within 5 min; opt-out applied within 1 min; scheduled start within 1 min; pause effective within 10 s
**Constraints**: Meta Cloud API default throughput up to 80 msg/s per number, portfolio-level messaging limits and template rules; webhook acknowledgement must be fast (target p95 < 200 ms); at-most-once send per recipient; single tenant; secrets only in environment variables; money in integer USD micros
**Scale/Scope**: up to 5 numbers, 200k contacts, campaigns of 100k recipients, 10-20 team users, about 25 screens and 55 HTTP endpoints

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Each gate is marked below, and any failure
must be justified in Complexity Tracking.

- [x] **I. Official API & Policy**:
  - All sends go through the Meta Cloud API client in `apps/api/src/modules/meta`.
  - Campaigns and the API use approved templates only.
  - Opt-in is recorded with source and time (`contacts.consent_*`, `consent_events`).
  - Opt-out is enforced at the audience snapshot, in the send worker and in the public API (R11).
  - Kill switches: campaign pause plus a per-number `sending_enabled` flag.
- [x] **II. Original Product**: UI built from our own components and copy. No competitor assets.
  The research docs are reference only.
- [x] **III. Security & Privacy**:
  - Secrets come from env vars only; `.env.example` documents them.
  - Access tokens are AES-256-GCM encrypted.
  - Roles are enforced by an ADMIN/MANAGER/AGENT guard driven by the shared permission matrix.
  - Webhooks are checked with X-Hub-Signature-256.
  - `/health` and `/metrics` require the `X-Ops-Token` header (`OPS_TOKEN`).
  - `audit_logs` records sensitive actions.
  - A phone-masking interceptor covers agents.
  - Contact deletion keeps only anonymised aggregates.
- [x] **IV. Reliable Bulk Messaging**:
  - The dispatcher feeds per-number BullMQ queues with a limiter.
  - Retries are classified (R9) with exponential backoff.
  - Webhook processing is idempotent (unique `dedupe_key` + precedence).
  - Failed jobs are retained, and `webhook_events.error` gives a dead-letter view.
  - Pause/resume never duplicates: claim-before-send plus a unique (campaign, contact) constraint.
- [x] **V. Test-First**:
  - Every story starts with failing unit and integration tests.
  - Meta is mocked with nock or mock-meta; no real sends happen in tests.
  - CI gates: lint, typecheck, unit, integration, contract, e2e smoke.
- [x] **VI. Observability**:
  - pino JSON logs carry request, user, campaign and message IDs, with redaction.
  - prom-client exposes delivery, error, queue-depth and webhook-lag metrics.
  - Alert rules live in `ops/alerts.yml`.
- [x] **VII. Simplicity**:
  - npm workspaces (no Turborepo).
  - One NestJS codebase with two entrypoints.
  - Polling instead of WebSockets.
  - jsonb attributes instead of an EAV table.
  - A thin fetch-based Graph client instead of an SDK.
  - The deviations are justified below.

Platform constraints:
- [x] single tenant
- [x] Next.js + NestJS in TypeScript strict mode
- [x] PostgreSQL (Neon) with migrations
- [x] Redis + BullMQ
- [x] Docker
- [x] costs in USD

**Result: PASS.** No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-whatsapp-bulk-messaging/
├── spec.md                       # Feature specification (/sp.specify)
├── plan.md                       # This file (/sp.plan)
├── research.md                   # Phase 0 decisions R1-R22
├── data-model.md                 # Phase 1 entities, constraints, state machines
├── quickstart.md                 # Phase 1 developer setup and validation per story
├── contracts/
│   ├── dashboard-api.openapi.yaml   # Internal API for the dashboard (cookie session + CSRF)
│   ├── public-api.openapi.yaml      # v1 API for company systems (API keys)
│   └── meta-webhooks.md             # Inbound Meta webhook contract and processing rules
├── checklists/
│   └── requirements.md           # Spec quality checklist
└── tasks.md                      # Phase 2 output (/sp.tasks - NOT created by /sp.plan)
```

### Source Code (repository root)

```text
package.json                      # npm workspaces: apps/*, packages/*, tools/*
docker-compose.yml                # postgres:16, redis:7 (noeviction, AOF), minio, mock-meta
.env.example
ops/
└── alerts.yml                    # Prometheus alert rules (Principle VI)
samples/
└── contacts-10.csv, contacts-100.csv

apps/
├── api/                          # NestJS 12 - HTTP API + worker
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts               # first admin, default settings
│   ├── src/
│   │   ├── main.ts               # HTTP entrypoint (rawBody enabled for webhooks)
│   │   ├── worker.ts             # BullMQ processors entrypoint
│   │   ├── app.module.ts
│   │   ├── common/               # config (zod-validated env), crypto (AES-GCM), phone (libphonenumber),
│   │   │                         # guards (session, CSRF, permissions), interceptors (phone masking),
│   │   │                         # filters (error format), logging (pino, correlation IDs), metrics
│   │   └── modules/
│   │       ├── auth/             # login, logout, sessions, invitations
│   │       ├── users/
│   │       ├── audit/
│   │       ├── settings/
│   │       ├── meta/             # MetaGraphClient (thin fetch client), error classifier (R9)
│   │       ├── numbers/          # connect, refresh, quality sync job
│   │       ├── contacts/         # contacts, tags, attributes, consent, audience query builder
│   │       ├── imports/          # CSV upload + streaming import processor
│   │       ├── media/            # S3 storage, Meta media upload
│   │       ├── templates/        # create/validate/submit, sync, status updates
│   │       ├── campaigns/        # drafts, estimate, launch/schedule, pause/resume/cancel, retarget
│   │       ├── sending/          # dispatcher processor, send processor, rate limits, retries
│   │       ├── webhooks/         # controller (verify + ingest) and processors (statuses, inbound, templates, quality)
│   │       ├── reports/          # totals, rates, failure reasons, cost, export
│   │       ├── rate-card/
│   │       ├── api-keys/
│   │       ├── public-api/       # /api/v1 controllers, API-key guard, idempotency, rate limit
│   │       ├── notifications/
│   │       └── health/
│   └── test/
│       ├── unit/
│       ├── integration/
│       └── contract/
└── web/                          # Next.js 16 (App Router)
    ├── src/
    │   ├── app/
    │   │   ├── (auth)/login/, (auth)/invite/[token]/
    │   │   └── (dashboard)/
    │   │       ├── campaigns/ (list, new wizard, [id] detail/report)
    │   │       ├── contacts/ (list, [id], import)
    │   │       ├── templates/ (list, new, [id])
    │   │       ├── api-messages/
    │   │       └── settings/ (numbers, team, api-keys, rate-card, keywords, audit)
    │   ├── components/           # shadcn/ui-based primitives + feature components
    │   ├── lib/                  # api client (fetch + CSRF), TanStack Query hooks, permissions helpers
    │   └── styles/
    ├── tests/                    # Jest + Testing Library unit tests
    └── e2e/                      # Playwright specs per user story

packages/
└── shared/                       # zod DTOs, enums, permission matrix, variable-key helpers

tools/
└── mock-meta/                    # fake Graph API + signed webhook emitter for local/e2e
```

**Structure Decision**: a web application split into `apps/web` (frontend) and `apps/api`
(backend + worker), plus `packages/shared` for types used by both. The default "backend/frontend"
option was renamed to `apps/*` to match npm-workspaces conventions. Tests live inside each app;
cross-app e2e lives in `apps/web/e2e`.

## Delivery Order (input for /sp.tasks)

| Step | Scope | Unblocks |
|---|---|---|
| Setup | Workspaces, Docker Compose, env validation, lint/format, CI skeleton | everything |
| Foundation | Prisma schema + migrations, auth/sessions/CSRF, permission guard, audit service, logging/metrics, MetaGraphClient + error classifier, mock-meta, S3 storage | all stories |
| US1 (P1, MVP) | Number connect/refresh, template sync, campaign upload audience, variable mapping, send now, dispatcher + send worker, webhook statuses, recipient list | first broadcast |
| US2 (P2) | Contacts CRUD, tags, attributes, imports, consent keywords, audience filters | saved audiences |
| US3 (P2) | Template editor, validation, submit, status webhook | in-platform templates |
| US4 (P3) | Scheduling + reconciler, pause/resume/cancel, retries, auto-pause rules | safe campaign control |
| US5 (P3) | Reports, rate card, cost, export, retarget | measurement |
| US6 (P3) | Invitations, role management UI, masking, audit-log UI | team rollout |
| US7 (P4) | API keys, /api/v1 send + status, idempotency, rate limit, API message log | system integrations |
| Polish | Alert rules, performance test (10k campaign, 50k import), security review, docs | release |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Separate worker process (same NestJS codebase, second entrypoint) | Bulk sending, webhook processing and imports must run off the HTTP path (Principle IV) and scale on their own | Running processors inside the API process lets a 100k campaign starve HTTP requests and couples restarts. A second codebase was avoided |
| `tools/mock-meta` fake Graph API | E2E tests must never call Meta (Principle V) and need realistic signed webhooks | nock only works inside the test process; Playwright drives real running services |
| `packages/shared` workspace | One source of truth for DTOs, enums and the permission matrix used by both web and api | Duplicated types drift and break contract tests and permission checks |

## Post-Design Constitution Check

Re-evaluated after Phase 1 (data model + contracts): **PASS**.

| Gate | Evidence in design |
|---|---|
| I | <ul><li>`messages` rows are only created from APPROVED templates (contracts: 409 on launch, 422 `TEMPLATE_NOT_APPROVED`).</li><li>Consent fields plus `consent_events`.</li><li>Keyword processing in `meta-webhooks.md` §4.</li><li>`sending_enabled` kill switch.</li></ul> |
| II | No third-party UI kits that copy competitors; original copy and design |
| III | <ul><li>`access_token_enc` is never returned (writeOnly in the contract).</li><li>Sessions and API keys are stored hashed.</li><li>CSRF header on all mutations.</li><li>Masked `phone` fields for AGENT.</li><li>Audit action list in the data model.</li></ul> |
| IV | <ul><li>Unique (`campaign_id`, `contact_id`) and unique `message_events.dedupe_key`.</li><li>Precedence rules.</li><li>Dispatcher with a 2-second buffer.</li><li>Error classes R9.</li><li>`webhook_events` for replay.</li></ul> |
| V | Quickstart validation table per story; test layers in R21; mock-meta behaviours defined |
| VI | Metric names and log redaction in R19; alert rules file in the structure |
| VII | Three justified extras only; polling; no extra services beyond Postgres, Redis and object storage |

## Risks (top 3)

1. **Meta API drift**: field names, limits and webhook fields may change.
   - *Mitigation:* pinned Graph version, a single `MetaGraphClient`, contract tests against
     recorded fixtures, and the "verify at implementation" items in research R8/R10.
2. **Duplicate or lost sends during failures.**
   - *Mitigation:* claim-before-send, a unique recipient constraint, no retry on ambiguous
     timeouts, and the zero-duplicate e2e test (US4).
3. **Number quality and ban risk from poor targeting.**
   - *Mitigation:* opt-in enforcement, a pre-launch messaging-limit warning, quality alerts,
     auto-pause on blocking errors, and the per-number kill switch.
