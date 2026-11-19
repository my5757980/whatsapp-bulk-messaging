<!--
Sync Impact Report
- Version change: unversioned template -> 1.0.0 (first ratification)
- Principles (template placeholders -> 7 principles; template had 6 slots, user specified 7):
  I. Official WhatsApp Cloud API & Policy Compliance
  II. Original Product, No Copying
  III. Security & Privacy by Default
  IV. Reliable Bulk Messaging
  V. Test-First (NON-NEGOTIABLE)
  VI. Observability
  VII. Simplicity & Smallest Viable Change
- Added sections: Technology & Platform Constraints; Development Workflow & Quality Gates
- Removed sections: none
- Templates:
  ✅ .specify/templates/plan-template.md (Constitution Check gates listed; command path fixed)
  ✅ .specify/templates/tasks-template.md (tests changed from OPTIONAL to REQUIRED per Principle V)
  ✅ .specify/templates/spec-template.md (reviewed; no change needed)
  ⚠ .specify/templates/commands/*.md (folder absent; commands live in .claude/commands/; nothing to update)
  ✅ CLAUDE.md (reviewed; no change needed; README.md and docs/quickstart.md absent)
- Deferred TODOs: none
-->

# WhatsApp Bulk Messaging Platform Constitution

## Core Principles

### I. Official WhatsApp Cloud API & Policy Compliance

- All WhatsApp messaging MUST go through Meta's official WhatsApp Business Platform (Cloud API).
  Unofficial clients, WhatsApp Web automation and scraping are forbidden.
- Business-initiated messages outside the 24-hour customer service window MUST use
  Meta-approved templates.
- Marketing messages MUST be sent only to contacts with a recorded opt-in (source + timestamp).
- Opt-out requests (e.g. a STOP keyword or manual unsubscribe) MUST take effect immediately and
  be enforced on every send path: broadcasts, API, chatbot flows and AI agents.
- Number quality rating and messaging-limit tier MUST be visible to admins, and every broadcast
  MUST be pausable (kill switch).

Rationale: policy violations get numbers restricted or banned, which stops the whole channel.

### II. Original Product, No Copying

- Feature parity with market tools (researched in `docs/research/aisensy/`) is allowed.
- Competitor UI designs, text, images, logos, template wording and brand names MUST NOT be copied.
- Competitor web or mobile apps MUST NOT be decompiled or scraped.

Rationale: protects the company from copyright, trademark and terms-of-service claims.

### III. Security & Privacy by Default

- Secrets (Meta access tokens, app secret, database/Redis URLs, API keys) MUST live in environment
  variables and never be committed; the repo ships only a `.env.example`.
- WhatsApp access tokens MUST be encrypted at rest.
- Every request MUST be authenticated; authorization uses least-privilege roles:
  admin, manager, agent.
- Incoming Meta webhooks MUST pass signature verification before any processing.
- Security-relevant actions (login, role change, token change, broadcast launch, data export,
  contact deletion) MUST be written to an audit log.
- Agents MUST see masked phone numbers (last 4 digits) unless their role grants full numbers.
- Contact data deletion requests MUST be honored.

Rationale: the platform stores customer phone numbers and conversations, which are personal data.

### IV. Reliable Bulk Messaging

- All outbound sends MUST go through a persistent queue; nothing is sent inline in a web request.
- Send rate MUST be limited per WhatsApp number and stay within Meta's throughput and
  messaging limits.
- Transient failures MUST retry with exponential backoff up to a maximum attempt count;
  permanent errors MUST NOT be retried.
- Webhook processing MUST be idempotent (keyed on WhatsApp message ID and status) so duplicates
  never double-count or double-send.
- Every message MUST have a traceable status timeline (queued -> sent -> delivered -> read, or
  failed with reason); failed processing goes to a dead-letter queue, never silently dropped.
- A broadcast MUST be pausable and resumable without sending duplicates.

Rationale: bulk messaging is the core product; lost or duplicate messages cost money and trust.

### V. Test-First (NON-NEGOTIABLE)

- For every feature, tests MUST be written before implementation and MUST fail first
  (red -> green -> refactor).
- Each user story MUST have unit tests for business logic and an integration test for its
  main journey.
- The Meta Cloud API and webhooks MUST be mocked in automated tests; tests MUST NOT send real
  WhatsApp messages.
- CI (lint, type check, tests) MUST pass before merge.

Rationale: queue, retry and webhook logic fails in subtle ways that only tests catch early.

### VI. Observability

- Services MUST emit structured JSON logs with correlation IDs (request, campaign, message).
- Metrics MUST cover messages queued, sent, delivered, read and failed (by error code), plus
  queue depth and webhook lag.
- Logs MUST NOT contain secrets or full message bodies; phone numbers in logs MUST be masked.
- Alerts MUST fire on failure-rate spikes, a stalled queue, or webhook delivery failures.

Rationale: operators must see delivery problems before customers report them.

### VII. Simplicity & Smallest Viable Change

- Start with the simplest design that meets the spec (YAGNI); any extra service, layer or
  pattern MUST be justified in the plan's Complexity Tracking table.
- Changes MUST be small, focused and testable; unrelated refactors stay out of feature work.
- TypeScript strict mode is mandatory; any use of `any` needs a justification comment.

Rationale: a small team ships faster and safer with fewer moving parts.

## Technology & Platform Constraints

- Deployment model: single company (single tenant), supporting one or more of the company's own
  WhatsApp Business numbers. Multi-tenant SaaS features (other companies signing up,
  subscription plans) are out of scope unless this constitution is amended.
- Frontend: Next.js (React) with TypeScript.
- Backend: Node.js with NestJS (TypeScript).
- Database: PostgreSQL (Neon); schema changes only through versioned migrations.
- Queue and cache: Redis with BullMQ.
- Packaging: Docker for local development and deployment.
- WhatsApp: Meta WhatsApp Cloud API with a pinned Graph API version, upgraded deliberately.
- Money: message costs and reports are tracked in USD.
- Configuration comes from environment variables; `.env.example` documents every variable.

## Development Workflow & Quality Gates

- Every feature follows Spec-Driven Development: `/sp.specify` -> `/sp.plan` -> `/sp.tasks` ->
  `/sp.implement`, on a numbered feature branch (`###-feature-name`).
- The plan's Constitution Check MUST pass before research and again after design; any violation
  is recorded with justification in Complexity Tracking.
- Every user prompt gets a Prompt History Record under `history/prompts/`.
- Architecturally significant decisions get an ADR under `history/adr/`, suggested via `/sp.adr`
  and created only with the owner's consent.
- Merge gates: lint, type check, unit and integration tests all green; the reviewer confirms
  constitution compliance.
- Definition of done: the spec's acceptance scenarios pass, quickstart docs are updated, and no
  secrets exist in code.

## Governance

- This constitution supersedes all other project practices; where guidance conflicts, it wins.
- Amendments are proposed in a PR that updates this file, includes a Sync Impact Report and
  updates dependent templates; the project owner must approve.
- Versioning follows semver: MAJOR for removed or redefined principles, MINOR for new principles,
  sections or materially expanded guidance, PATCH for clarifications and wording.
- Compliance: every plan runs the Constitution Check, every code review verifies compliance, and
  added complexity must be justified. Runtime agent guidance lives in `CLAUDE.md`.

**Version**: 1.0.0 | **Ratified**: 2026-11-16 | **Last Amended**: 2026-11-16
