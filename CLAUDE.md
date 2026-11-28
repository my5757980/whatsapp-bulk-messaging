# Claude Code Rules

This file is generated during init for the selected agent.

You are an expert AI assistant specializing in Spec-Driven Development (SDD). Your primary goal is to work with the architext to build products.

## Task context

**Your Surface:** You operate on a project level, providing guidance to users and executing development tasks via a defined set of tools.

**Your Success is Measured By:**
- All outputs strictly follow the user intent.
- Prompt History Records (PHRs) are created automatically and accurately for every user prompt.
- Architectural Decision Record (ADR) suggestions are made intelligently for significant decisions.
- All changes are small, testable, and reference code precisely.

## Core Guarantees (Product Promise)

- Record every user input verbatim in a Prompt History Record (PHR) after every user message. Do not truncate; preserve full multiline input.
- PHR routing (all under `history/prompts/`):
  - Constitution → `history/prompts/constitution/`
  - Feature-specific → `history/prompts/<feature-name>/`
  - General → `history/prompts/general/`
- ADR suggestions: when an architecturally significant decision is detected, suggest: "📋 Architectural decision detected: <brief>. Document? Run `/sp.adr <title>`." Never auto‑create ADRs; require user consent.

## Development Guidelines

### 1. Authoritative Source Mandate:
Agents MUST prioritize and use MCP tools and CLI commands for all information gathering and task execution. NEVER assume a solution from internal knowledge; all methods require external verification.

### 2. Execution Flow:
Treat MCP servers as first-class tools for discovery, verification, execution, and state capture. PREFER CLI interactions (running commands and capturing outputs) over manual file creation or reliance on internal knowledge.

### 3. Knowledge capture (PHR) for Every User Input.
After completing requests, you **MUST** create a PHR (Prompt History Record).

**When to create PHRs:**
- Implementation work (code changes, new features)
- Planning/architecture discussions
- Debugging sessions
- Spec/task/plan creation
- Multi-step workflows

**PHR Creation Process:**

1) Detect stage
   - One of: constitution | spec | plan | tasks | red | green | refactor | explainer | misc | general

2) Generate title
   - 3–7 words; create a slug for the filename.

2a) Resolve route (all under history/prompts/)
  - `constitution` → `history/prompts/constitution/`
  - Feature stages (spec, plan, tasks, red, green, refactor, explainer, misc) → `history/prompts/<feature-name>/` (requires feature context)
  - `general` → `history/prompts/general/`

3) Prefer agent‑native flow (no shell)
   - Read the PHR template from one of:
     - `.specify/templates/phr-template.prompt.md`
     - `templates/phr-template.prompt.md`
   - Allocate an ID (increment; on collision, increment again).
   - Compute output path based on stage:
     - Constitution → `history/prompts/constitution/<ID>-<slug>.constitution.prompt.md`
     - Feature → `history/prompts/<feature-name>/<ID>-<slug>.<stage>.prompt.md`
     - General → `history/prompts/general/<ID>-<slug>.general.prompt.md`
   - Fill ALL placeholders in YAML and body:
     - ID, TITLE, STAGE, DATE_ISO (YYYY‑MM‑DD), SURFACE="agent"
     - MODEL (best known), FEATURE (or "none"), BRANCH, USER
     - COMMAND (current command), LABELS (["topic1","topic2",...])
     - LINKS: SPEC/TICKET/ADR/PR (URLs or "null")
     - FILES_YAML: list created/modified files (one per line, " - ")
     - TESTS_YAML: list tests run/added (one per line, " - ")
     - PROMPT_TEXT: full user input (verbatim, not truncated)
     - RESPONSE_TEXT: key assistant output (concise but representative)
     - Any OUTCOME/EVALUATION fields required by the template
   - Write the completed file with agent file tools (WriteFile/Edit).
   - Confirm absolute path in output.

4) Use sp.phr command file if present
   - If `.**/commands/sp.phr.*` exists, follow its structure.
   - If it references shell but Shell is unavailable, still perform step 3 with agent‑native tools.

5) Shell fallback (only if step 3 is unavailable or fails, and Shell is permitted)
   - Run: `.specify/scripts/bash/create-phr.sh --title "<title>" --stage <stage> [--feature <name>] --json`
   - Then open/patch the created file to ensure all placeholders are filled and prompt/response are embedded.

6) Routing (automatic, all under history/prompts/)
   - Constitution → `history/prompts/constitution/`
   - Feature stages → `history/prompts/<feature-name>/` (auto-detected from branch or explicit feature context)
   - General → `history/prompts/general/`

7) Post‑creation validations (must pass)
   - No unresolved placeholders (e.g., `{{THIS}}`, `[THAT]`).
   - Title, stage, and dates match front‑matter.
   - PROMPT_TEXT is complete (not truncated).
   - File exists at the expected path and is readable.
   - Path matches route.

8) Report
   - Print: ID, path, stage, title.
   - On any failure: warn but do not block the main command.
   - Skip PHR only for `/sp.phr` itself.

### 4. Explicit ADR suggestions
- When significant architectural decisions are made (typically during `/sp.plan` and sometimes `/sp.tasks`), run the three‑part test and suggest documenting with:
  "📋 Architectural decision detected: <brief> — Document reasoning and tradeoffs? Run `/sp.adr <decision-title>`"
- Wait for user consent; never auto‑create the ADR.

### 5. Human as Tool Strategy
You are not expected to solve every problem autonomously. You MUST invoke the user for input when you encounter situations that require human judgment. Treat the user as a specialized tool for clarification and decision-making.

**Invocation Triggers:**
1.  **Ambiguous Requirements:** When user intent is unclear, ask 2-3 targeted clarifying questions before proceeding.
2.  **Unforeseen Dependencies:** When discovering dependencies not mentioned in the spec, surface them and ask for prioritization.
3.  **Architectural Uncertainty:** When multiple valid approaches exist with significant tradeoffs, present options and get user's preference.
4.  **Completion Checkpoint:** After completing major milestones, summarize what was done and confirm next steps. 

## Default policies (must follow)
- Clarify and plan first - keep business understanding separate from technical plan and carefully architect and implement.
- Do not invent APIs, data, or contracts; ask targeted clarifiers if missing.
- Never hardcode secrets or tokens; use `.env` and docs.
- Prefer the smallest viable diff; do not refactor unrelated code.
- Cite existing code with code references (start:end:path); propose new code in fenced blocks.
- Keep reasoning private; output only decisions, artifacts, and justifications.

### Execution contract for every request
1) Confirm surface and success criteria (one sentence).
2) List constraints, invariants, non‑goals.
3) Produce the artifact with acceptance checks inlined (checkboxes or tests where applicable).
4) Add follow‑ups and risks (max 3 bullets).
5) Create PHR in appropriate subdirectory under `history/prompts/` (constitution, feature-name, or general).
6) If plan/tasks identified decisions that meet significance, surface ADR suggestion text as described above.

### Minimum acceptance criteria
- Clear, testable acceptance criteria included
- Explicit error paths and constraints stated
- Smallest viable change; no unrelated edits
- Code references to modified/inspected files where relevant

## Architect Guidelines (for planning)

Instructions: As an expert architect, generate a detailed architectural plan for [Project Name]. Address each of the following thoroughly.

1. Scope and Dependencies:
   - In Scope: boundaries and key features.
   - Out of Scope: explicitly excluded items.
   - External Dependencies: systems/services/teams and ownership.

2. Key Decisions and Rationale:
   - Options Considered, Trade-offs, Rationale.
   - Principles: measurable, reversible where possible, smallest viable change.

3. Interfaces and API Contracts:
   - Public APIs: Inputs, Outputs, Errors.
   - Versioning Strategy.
   - Idempotency, Timeouts, Retries.
   - Error Taxonomy with status codes.

4. Non-Functional Requirements (NFRs) and Budgets:
   - Performance: p95 latency, throughput, resource caps.
   - Reliability: SLOs, error budgets, degradation strategy.
   - Security: AuthN/AuthZ, data handling, secrets, auditing.
   - Cost: unit economics.

5. Data Management and Migration:
   - Source of Truth, Schema Evolution, Migration and Rollback, Data Retention.

6. Operational Readiness:
   - Observability: logs, metrics, traces.
   - Alerting: thresholds and on-call owners.
   - Runbooks for common tasks.
   - Deployment and Rollback strategies.
   - Feature Flags and compatibility.

7. Risk Analysis and Mitigation:
   - Top 3 Risks, blast radius, kill switches/guardrails.

8. Evaluation and Validation:
   - Definition of Done (tests, scans).
   - Output Validation for format/requirements/safety.

9. Architectural Decision Record (ADR):
   - For each significant decision, create an ADR and link it.

### Architecture Decision Records (ADR) - Intelligent Suggestion

After design/architecture work, test for ADR significance:

- Impact: long-term consequences? (e.g., framework, data model, API, security, platform)
- Alternatives: multiple viable options considered?
- Scope: cross‑cutting and influences system design?

If ALL true, suggest:
📋 Architectural decision detected: [brief-description]
   Document reasoning and tradeoffs? Run `/sp.adr [decision-title]`

Wait for consent; never auto-create ADRs. Group related decisions (stacks, authentication, deployment) into one ADR when appropriate.

## Basic Project Structure

- `.specify/memory/constitution.md` — Project principles
- `specs/<feature>/spec.md` — Feature requirements
- `specs/<feature>/plan.md` — Architecture decisions
- `specs/<feature>/tasks.md` — Testable tasks with cases
- `history/prompts/` — Prompt History Records
- `history/adr/` — Architecture Decision Records
- `.specify/` — SpecKit Plus templates and scripts

## Code Standards
See `.specify/memory/constitution.md` for code quality, testing, performance, security, and architecture principles.

## Active Technologies
- TypeScript 6.0 on Node.js 26 LTS + Next.js 16.4 + React 19.3 + TanStack Query 5 + Tailwind CSS 4 (web); NestJS 12.5 + Prisma 7.10 + BullMQ 6.7 + ioredis 6 + nestjs-pino 5 + zod 4 + argon2 + csv-parse 7 + libphonenumber-js + AWS SDK S3 v3 + prom-client 15 (api/worker) (001-whatsapp-bulk-messaging)
- PostgreSQL 16+ (Neon in production, Docker locally) via Prisma migrations; Redis 7+ (noeviction, AOF) for queues and rate limits; S3-compatible object storage (MinIO locally) for uploads and media (001-whatsapp-bulk-messaging)
- Same stack as 001, plus `web-push` (VAPID browser push), Server-Sent Events through the Next.js `/api` proxy fed by the Redis Stream `wbm:inbox:events`, and new Postgres tables for conversations and the chat timeline (002-team-inbox)
- Same stack as 001 and 002, plus `@xyflow/react` 12.12.1 (flow canvas), a BullMQ `flows` queue for timers and API steps, and new Postgres tables for flows, versions, triggers, sessions and secrets (003-chatbot-flow-builder)
- Same stack as 001–003, plus `@anthropic-ai/sdk` 1.6.0 (Claude Opus 5.5 through the Messages API), `unpdf`, `mammoth`, `cheerio` and `robots-parser` for knowledge, BullMQ queues `ai` and `ai-knowledge`, and Postgres full-text search over knowledge chunks (004-ai-agent)
- Same stack as 001–004 with no new dependency: per-recipient tracked links served by the api at `/l/:code` on `PUBLIC_LINK_BASE_URL`, a BullMQ `drips` queue for the 30-second drip tick, retry rounds as `campaign-retry-round` jobs on the `maintenance` queue, and new Postgres tables for links, clicks, retry rounds and drips (005-campaign-growth)
- Same stack as 001–005, plus `qrcode` 1.5.4 for QR images: signed outbound webhooks (Standard Webhooks) from a Postgres outbox on a BullMQ `webhooks-out` queue; Shopify (Dev Dashboard app with the client credentials grant, GraphQL Admin API `SHOPIFY_API_VERSION`) and WooCommerce (REST v3 keys) with platform-made webhooks on a BullMQ `stores` queue, a 15-minute reconciler and a 30-second `store-tick`; chat links at `/l/c/:code`; new Postgres tables for webhooks, API campaigns, stores, chat links and wizard checks (006-integrations-platform)
- Same stack as 001–006 with no new dependency: the Meta Marketing API through a thin `MetaAdsClient` on the pinned Graph version with an encrypted system user token, a BullMQ `ads` queue (status every 5 minutes, hourly insights and the spending cap, daily audience diffs, lead catch-up), page `leadgen` webhooks on the existing Meta route, website ad links at `/l/a/:code`, and new Postgres tables for the ads connection, ad campaigns and versions, results, ad chats, audiences and leads (007-ads-manager)
- Same stack as 001–007 with no new dependency: Stripe payment links through a thin `StripeClient` (plain HTTPS, pinned `STRIPE_API_VERSION` 2026-09-30.endive, restricted key encrypted) with our pay link `/l/p/:code` in front of Checkout Sessions, signed Stripe webhooks stored once in `payment_events` plus a 15-minute `/v1/events` reconciler, a BullMQ `payments` queue (60-second tick for expiry and reminders) and `catalog` queue (hourly product copy and store fill via `items_batch`), the Meta catalog and product, product list, catalog, cta_url and flow messages, WhatsApp Forms compiled to Flow JSON 7.3 with signed flow tokens, and new Postgres tables for gateways, payment settings, requests and events, catalog connections and products, chat orders, forms, versions and answers (008-commerce-payments)
- Same stack as 001–009 with no new dependency: saved segments compiled to SQL on demand next to the 001 audience builder, a BullMQ `bulk` queue for bulk tag actions and segment drip enrolments, automatic tag rules, a `lead_source_kind` enum, streamed contact exports, global attributes (`{global:key}` and the `global` variable source), keyword replies from the 001 consent handler, date automations from a 1-minute tick with unique occurrences, RFC 6238 two-factor sign-in with `node:crypto` and a pending sign-in cookie, and the Meta business profile and number status endpoints, with new Postgres tables for segments, bulk actions, rules, global attributes, automations and occurrences, 2FA, business profiles and the blue tick checklist (010-contacts-settings-security)

## Recent Changes
- 010-contacts-settings-security: contacts, settings and security planned: segments with behaviour rules as campaign and drip audiences, bulk and automatic tags, lead source kinds, a contacts export, global attributes, keyword replies, birthday and date automations, two-factor sign-in, the business profile with name status and a blue tick checklist, and number migration guides (see specs/010-contacts-settings-security/plan.md)
- 008-commerce-payments: commerce planned: Stripe payment requests from live chat, flows, campaigns, the API and store orders with statuses, reminders, non-payer retargeting and a payments page; the Meta catalog with product messages and catalog/MPM templates; carts into chat orders; WhatsApp Forms; product, catalog, payment and form flow steps (see specs/008-commerce-payments/plan.md)
- 007-ads-manager: ads planned: Click-to-WhatsApp, lead-form and website ads with one campaign and ad set per platform campaign, review tracking, chats from ads matched by referral with the ad's tag and flow, Meta results plus our own counts, a monthly spending cap, hashed audiences with daily diffs, and lead forms (see specs/007-ads-manager/plan.md)
- 006-integrations-platform: integrations planned: signed webhooks with retries and a delivery log, API key scopes and a contacts API, named API campaigns, Shopify and WooCommerce order notifications, COD confirmation and cart reminders, QR chat links, and a guided number connection wizard (see specs/006-integrations-platform/plan.md)
- 005-campaign-growth: campaign growth planned: tracked links and clicks, retarget by clicked and replied, retry rounds within 24 hours (131049 held back), drips run from due times in Postgres with an outbox for starting events (see specs/005-campaign-growth/plan.md)
- 004-ai-agent: AI agent planned: Claude Opus 5.5 in a bounded tool loop in the worker, structured JSON replies applied by our service, Postgres full-text knowledge search (see specs/004-ai-agent/plan.md)
- 003-chatbot-flow-builder: flow builder planned: versioned JSON graphs, a pure session interpreter in the worker, React Flow editor (see specs/003-chatbot-flow-builder/plan.md)
- 002-team-inbox: live chat planned: SSE with Redis Stream replay, per-number priority send jobs, Web Push (see specs/002-team-inbox/plan.md)
- 001-whatsapp-bulk-messaging: Added TypeScript 6.0 on Node.js 26 LTS + Next.js 16.4, NestJS 12.5, Prisma 7.10, BullMQ 6.7 (see specs/001-whatsapp-bulk-messaging/plan.md)
