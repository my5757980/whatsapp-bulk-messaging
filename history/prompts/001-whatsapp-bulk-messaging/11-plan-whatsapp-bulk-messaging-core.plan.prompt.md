---
id: 11
title: Plan WhatsApp Bulk Messaging Core
stage: plan
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "architecture", "nextjs", "nestjs", "prisma", "bullmq", "meta-cloud-api", "contracts"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/001-whatsapp-bulk-messaging/plan.md
 - specs/001-whatsapp-bulk-messaging/research.md
 - specs/001-whatsapp-bulk-messaging/data-model.md
 - specs/001-whatsapp-bulk-messaging/quickstart.md
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml
 - specs/001-whatsapp-bulk-messaging/contracts/public-api.openapi.yaml
 - specs/001-whatsapp-bulk-messaging/contracts/meta-webhooks.md
 - CLAUDE.md (Active Technologies / Recent Changes via update-agent-context.ps1)
 - history/prompts/001-whatsapp-bulk-messaging/11-plan-whatsapp-bulk-messaging-core.plan.prompt.md
tests:
 - Constitution Check pre-research PASS, post-design PASS (7 gates)
 - Package versions verified with npm view (2026-11-16)
 - Meta facts verified via developer docs (80 msg/s default throughput; error codes; phone-number fields) and Context7 (webhook status/pricing schema, template endpoints)
 - OpenAPI YAML machine-lint NOT run (npx js-yaml was denied by the permission classifier); manual review fixed 3 unquoted flow-scalar commas
---

## Prompt

/sp.plan

(no arguments given; used the plan direction provided in the previous turn (PHR 10):)

Monorepo: Next.js (App Router, TypeScript) dashboard in apps/web, NestJS (TypeScript) API and background worker in apps/api. PostgreSQL (Neon in production, local Postgres via Docker Compose) with Prisma migrations. Redis + BullMQ for the send queue: per-number rate limiter, retries with exponential backoff, dead-letter queue, scheduled campaigns, pause/resume. Meta WhatsApp Cloud API with a pinned Graph API version for templates and messages; webhook endpoint with X-Hub-Signature-256 verification and idempotent status processing. Auth: email/password (argon2) with session tokens, role guards for admin/manager/agent, audit log, AES-256-GCM encryption for access tokens. CSV import via streaming parser in background jobs. Media in S3-compatible storage. Tests: Jest unit tests, Supertest integration tests, Meta API mocked with nock, Playwright e2e for the campaign wizard. Structured JSON logs (pino) with correlation IDs and delivery metrics. Cost estimates in USD from a rate card table.

## Response snapshot

Ran setup-plan.ps1, which copied the plan template. Filled the plan with:
- Technical Context: TS 6.0 / Node 26 LTS; Next 16.4, NestJS 12.5, Prisma 7.10, BullMQ 6.7; Postgres/Redis/S3; scale and performance targets.
- Constitution Check: 7 gates passed with evidence.
- Monorepo structure, delivery order per user story, and Complexity Tracking for the worker entrypoint, mock-meta and the shared package.
- Post-design re-check and the top 3 risks.

research.md has 22 decisions. Key ones:
- TS 6 rather than 7, because of ts-jest and Nest CLI peers.
- Prisma 7.10 rather than the 8 RC.
- Dispatcher + per-number BullMQ limiter with claim-before-send, giving at-most-once delivery.
- Meta error-code retry classes.
- Webhook idempotency with a status-precedence rule.
- Three-point consent enforcement.
- Opaque DB sessions + CSRF.
- AES-GCM token encryption.
- API keys with idempotency records and a Redis rate limit.
- Rate-card cost in USD micros.
- pino + prom-client observability.
- The test layers.

data-model.md covers 20 entities with constraints, indexes, state machines (campaign, message precedence, template, consent, user) and retention.

Contracts:
- dashboard API: OpenAPI 3.1, about 55 operations, each with an x-permission.
- public API v1: send, status and template list, with Idempotency-Key, 429 and 422 codes.
- Meta webhooks contract.

quickstart.md covers setup, env vars, a validation table per story with mock-meta, CI commands, real-number setup and troubleshooting.

The agent context script updated CLAUDE.md. The section headers were added first; the script skipped the Recent Changes entry because of a section-adjacency bug, so that entry was added manually.

## Outcome

- ✅ Impact: The implementation plan and design artifacts are ready for /sp.tasks.
- 🧪 Tests: constitution gates pass; versions and Meta facts verified; YAML lint pending (blocked command).
- 📁 Files: plan, research, data-model, quickstart, 3 contracts, CLAUDE.md.
- 🔁 Next prompts: /sp.tasks. Optionally first `/sp.adr platform-stack` and `/sp.adr campaign-dispatch-at-most-once`.
- 🧠 Reflection: Checking the npm peer dependencies avoided a broken TypeScript 7 toolchain. The Meta docs showed the messaging-limit field is undocumented, so a manual fallback was planned.

## Evaluation notes (flywheel)

- Failure modes observed: the npx-based YAML validation was denied by the auto-mode classifier. update-agent-context.ps1 skips the Recent Changes entry when that section directly follows Active Technologies.
- Graders run and results (PASS/FAIL): Constitution Check PASS (pre and post); manual YAML review fixed 3 issues.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Add a contract-lint task (redocly or swagger-parser as a devDependency) in /sp.tasks so CI validates the OpenAPI files.
