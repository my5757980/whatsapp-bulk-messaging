---
id: 12
title: ADR Review Platform Decisions
stage: misc
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.adr
labels: ["adr", "architecture", "frontend", "backend", "data", "delivery", "security"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0001-frontend-stack.md, history/adr/0002-backend-runtime-process-model-and-monorepo.md, history/adr/0003-data-queue-and-storage-architecture.md, history/adr/0004-campaign-delivery-and-webhook-processing.md, history/adr/0005-security-access-and-api-key-architecture.md
  pr: null
files:
 - history/adr/0001-frontend-stack.md
 - history/adr/0002-backend-runtime-process-model-and-monorepo.md
 - history/adr/0003-data-queue-and-storage-architecture.md
 - history/adr/0004-campaign-delivery-and-webhook-processing.md
 - history/adr/0005-security-access-and-api-key-architecture.md
 - specs/001-whatsapp-bulk-messaging/plan.md (ADR links added)
 - history/prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md
tests:
 - Significance test (impact, alternatives, scope) passed for all 5 clusters
 - Grader per ADR (clustered, at least 1 alternative with rationale, pros and cons, concise) - 5/5 PASS
 - No existing ADRs, so no conflicts
---

## Prompt

/sp.adr

(no additional user input)

## Response snapshot

check-prerequisites.ps1 reported FEATURE_DIR = specs/001-whatsapp-bulk-messaging, with docs research, data-model, contracts and quickstart. `create-adr.sh` does not exist in this repo (only PowerShell scripts), so the ADRs were created agent-natively from `.specify/templates/adr-template.md`.

Extracted 5 decision clusters, kept apart per the clustering rules (the frontend and backend stacks evolve independently):
1. Frontend Stack: Next.js 16 App Router as the UI layer only, TanStack Query, Tailwind + owned shadcn components, shared zod forms, polling.
2. Backend Runtime, Process Model and Monorepo: Node 26 / TS 6, NestJS 12 with API and worker entrypoints, npm workspaces, thin Graph client.
3. Data, Queue and Storage: Postgres/Neon + Prisma 7.10, jsonb attributes, USD micros, database idempotency constraints, Redis noeviction + BullMQ queues, S3 storage.
4. Campaign Delivery and Webhook Processing: snapshot, dispatcher, per-number limiter, claim-before-send at-most-once, error classes, verify-store-enqueue webhooks, precedence.
5. Security, Access and API Keys: argon2id + opaque DB sessions + CSRF, shared permission matrix guard, masking interceptor, AES-GCM tokens, audit, hashed keys + idempotency + Redis rate limit.

All are Proposed, with context, a decision listing every component, positive and negative consequences, alternatives with rejection reasons, and references. Each ADR is linked from plan.md.

## Outcome

- ✅ Impact: Five reviewable ADRs record the "why" before tasks and implementation.
- 🧪 Tests: significance test and the 4-point grader pass for every ADR.
- 📁 Files: 5 ADRs and a plan.md reference block.
- 🔁 Next prompts: /sp.tasks; team review to change ADR status from Proposed to Accepted.
- 🧠 Reflection: Avoided over-granular ADRs (e.g. no separate ADRs for Tailwind or pino). Observability and testing strategy stay in research.md, since they are lower risk.

## Evaluation notes (flywheel)

- Failure modes observed: the command references the bash `create-adr.sh`, which is missing in this PowerShell-only scaffold; the template fallback was used.
- Graders run and results (PASS/FAIL): clustering PASS, alternatives PASS, pros/cons PASS, conciseness PASS (x5).
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Add a PowerShell `create-adr.ps1` to `.specify/scripts/powershell/` so future ADRs get IDs from a script.
