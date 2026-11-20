# Implementation Plan: AI Agent

**Branch**: `004-ai-agent` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-ai-agent/spec.md`

## Summary

Add AI agents that answer customers in WhatsApp chats from the company's own instructions and
knowledge, with the market leader's documented behaviour and our own design and wording:
- agents with instructions, tone, guardrails, reply languages, hand-over rules and skills, a draft,
  numbered versions, test numbers and a preview chat; four starter agents written by us
- knowledge from written answers, website pages and PDF/DOCX files, with unanswered questions
  listed for the team
- answers inside the 24-hour window that give way to flows, people, consent and blocking rules,
  hand over to *Waiting for agent* with a summary, and never send, spend or act without the checks
  in code
- buttons, lists, media, memory in allowed attributes, company API lookups, and flows in both
  directions
- usage counting with a monthly limit, alerts and an estimated cost in USD
- a team assistant that only drafts templates, flows and campaigns, and asks for confirmation on a
  preview before anything is sent, spent or deleted

**Technical approach** (see research.md):
- **AI service:** Anthropic's Messages API through `@anthropic-ai/sdk` 1.6.0, model
  `claude-opus-5-5` (setting `AI_MODEL`), effort `low` for customer replies and `medium` for the
  assistant, server-side refusal fallback, prompt caching. Anthropic does not train on API data and
  deletes it within 30 days (R1, R17).
- **Loop:** our worker runs a bounded tool loop (SDK tool runner, at most 4 iterations, 30-second
  deadline). Tools only gather information (`search_knowledge`, API skills); the final answer is
  JSON (structured output) that our service validates and applies in one transaction (R2, R3).
- **Pipeline:** the 002 inbound handler calls `AiAgentRouter` after the 003 flow router and before
  automatic replies; turns are debounced BullMQ jobs on a new `ai` queue; replies are 002 chat
  items (origin `AUTOMATIC`) on the number's send queue (R5, R6, R9).
- **Knowledge:** chunks in Postgres with full-text search; whole knowledge in the cached prompt up to
  120,000 characters, search above that (R4). Files and websites are read on a separate
  `ai-knowledge` queue, one at a time (R11).
- **Guards in code:** sensitive-number masking, introduction text, output limits, attribute and
  skill checks, confirmation protocol for skills that change data, atomic monthly limit (R10, R12).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, same as 001–003
**Primary Dependencies**:
- Existing: NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, Next.js 16.4, React 19.3,
  TanStack Query 5, Tailwind CSS 4, the 003 safe HTTPS client and secrets vault
- **New (api):** `@anthropic-ai/sdk` 1.6.0, `unpdf` 2.1.0, `mammoth` 1.13.0, `cheerio` 1.2.0,
  `robots-parser` 3.0.1 (each the newest release at least two weeks old on 2026-11-20). No new web
  dependency.

**Storage**:
- PostgreSQL: 14 new tables, `settings` columns, 6 existing enums extended, a generated `tsvector` column
  with a GIN index (data-model.md)
- Redis: new BullMQ queues `ai` (turns, expiry, assistant) and `ai-knowledge` (file and website
  processing, weekly refresh)
- S3/MinIO: knowledge files under `ai-knowledge/`

**Testing**:
- Vitest unit tests for pure logic: config and reply schemas, reply sanitiser, prompt builder
  (order, cache breakpoints, no phone numbers), masking, chunker, HTML/PDF/DOCX extraction on
  fixtures, search query building, usage maths, eligibility, confirmation protocol
- Integration tests per story with nock for `api.anthropic.com`, Graph and API-skill endpoints;
  contract tests against `contracts/ai-api.openapi.yaml`
- Playwright e2e per story against mock-meta's fake model (`ANTHROPIC_BASE_URL`)
- Answer quality with the real model by `npm run eval:ai`, by hand before release (costs money)

**Target Platform**: the same Docker images (api/worker and web) as 001–003; the worker needs
outbound HTTPS to `api.anthropic.com`

**Project Type**: web monorepo (`apps/api`, `apps/web`, `packages/shared`, `tools/mock-meta`)

**Performance Goals**:
- SC-001: p95 ≤ 10 s from a customer message reaching the platform to the AI reply being queued,
  with 50 customers at once (debounce 2 s + one model call in whole-knowledge mode)
- SC-008: a 100-page website and 10 files of 50 pages ready within 15 minutes
- SC-006: a new agent from a starter set up, tested and published in under 20 minutes

**Constraints**:
- free-form replies only inside the 24-hour window; one active AI conversation per chat; flows and
  people always come first
- the per-number send rate is shared with campaigns, live chat and flows (chat priority)
- no message text, knowledge, replies, summaries or remembered values in logs; phone numbers never
  sent to the AI service
- Anthropic rate limits depend on the company's account tier; 429s are retried within the deadline
  and then fall back to people
- the dev machine has 3.9 GB of RAM: heavy test runs go to CI; PDF parsing runs one at a time

**Scale/Scope**: a handful of agents; up to a few thousand AI replies a day; per agent up to 500
written answers, 5 sites × 100 pages and 50 files × 300 pages; about 8 new screens and panels; 9
user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0). Result: **PASS** before research and
**PASS** after design.

- [x] **I. Official API & Policy**:
  - Only Cloud API messages (text, media, interactive buttons and lists) are sent, through the 002
    send path.
  - AI replies go out only inside the 24-hour window: checked before the model call, again before
    applying, and by the 002 send processor (FR-016).
  - Opt-out holds on the AI path (named in Principle I): opt-out keywords are handled by the 001
    consent rules before the agent; a clear request in other words is recorded as an opt-out with no
    reply (FR-027); opted-out and blocked contacts never get AI replies.
  - Meta's AI rules: the agent stays on the company's business; WhatsApp data is never used for
    training (Anthropic's commercial terms, R17); a person is always reachable (deterministic
    keywords plus hand-over); the agent never asks for card, bank or ID numbers (rules plus masking).
  - The kill switch is unaffected: a number with sending turned off refuses AI sends (002 path).
- [x] **II. Original Product**: behaviour only. Starter agents, platform rules, introductions and
  all screen texts are written by us; research used public pages only.
- [x] **III. Security & Privacy**:
  - Session + CSRF on every endpoint; new least-privilege permissions `ai.manage`, `ai.usage`,
    `assistant.use`; the assistant acts with the member's own permissions.
  - `ANTHROPIC_API_KEY` lives in the environment; API-skill secrets are stored per agent with the
    001 cipher, like 003 flow secrets, and never returned, logged or sent to the AI service.
  - Website reading and API skills use the 003 SSRF-safe HTTPS client.
  - Phone numbers are never sent to the AI service; card, ID and IBAN numbers are masked first.
  - Audit entries for agent, knowledge, skill, number, limit and assistant changes (FR-050); contact
    deletion erases AI records (FR-051).
- [x] **IV. Reliable Messaging**:
  - Every AI reply is queued on the number's send queue (claim-before-send, retries, statuses as in
    002).
  - Debounced turns, the per-chat lock, one active AI conversation per chat and an idempotent apply
    step prevent double replies; the final re-check drops a reply when a member acted first.
  - Failures never leave a customer unanswered: fallback message and hand-over. Failed jobs stay
    visible on the queues.
- [x] **V. Test-First**: each story starts with failing unit, integration and e2e tests; Claude is
  mocked with nock and mock-meta's fake model, Meta with nock and mock-meta; CI gates unchanged plus
  the new contract in `lint:contracts`; quality evals run by hand with approval.
- [x] **VI. Observability**:
  - Logs carry `agentId`, `aiConversationId` and `conversationId`; prompts, knowledge, replies,
    summaries and remembered values are on the redaction list.
  - New metrics: `wbm_ai_turns_total{result}`, `wbm_ai_turn_duration_seconds`,
    `wbm_ai_tokens_total{kind}`, `wbm_ai_replies_total{test}`,
    `wbm_ai_knowledge_jobs_total{kind,outcome}`, `wbm_ai_assistant_requests_total{outcome}`.
  - New alert `WbmAiFailing` (more than 20% of turns failing over 15 minutes, at least 10 turns),
    mirrored by an in-app alert for admins.
- [x] **VII. Simplicity**: no new service or process. One SDK, four parsing libraries and two
  queues, each justified below. Postgres full-text search instead of a vector database; our own
  bounded loop instead of hosted agents.

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker; costs in USD. All are satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/004-ai-agent/
├── spec.md
├── plan.md                        # this file
├── research.md                    # Phase 0: R1–R18
├── data-model.md                  # Phase 1: tables, AI conversation states, validation, retention
├── quickstart.md                  # Phase 1: local validation per story
├── contracts/
│   ├── ai-api.openapi.yaml        # dashboard endpoints and the new permissions
│   ├── agent-config.md            # the agent configuration document (draft, versions)
│   └── claude-messages.md         # calls to the Claude API, the reply JSON, the fake model
├── checklists/requirements.md
└── tasks.md                       # Phase 2 (/sp.tasks)
```

### Source Code (repository root)

```text
packages/shared/src/ai/
├── config.ts             # AgentConfigSchema + limits (contracts/agent-config.md)
├── reply.ts              # AgentReplySchema + sanitiser (pure)
├── masking.ts            # card, Emirates ID and IBAN masking (pure)
├── chunking.ts           # text → chunks with headings and overlap (pure)
├── usage.ts              # cost maths, alert levels, month keys in a time zone (pure)
└── starters/             # 4 starter agents written by us
packages/shared/src/flows/graph.ts, validate.ts   # + aiAgent step
packages/shared/src/permissions.ts                # + ai.manage, ai.usage, assistant.use
apps/api/
├── prisma/migrations/20261127000000_ai_agent/    # 14 tables, settings columns, enums, tsvector + GIN
├── src/modules/ai/
│   ├── agents/      agents.service.ts + agents.controller.ts (CRUD, draft, duplicate, numbers,
│   │                test numbers), publish.service.ts, versions.service.ts, starters.controller.ts
│   ├── knowledge/   knowledge.service.ts + knowledge.controller.ts, extract/ (pdf.ts, docx.ts,
│   │                html.ts), crawler.ts (safe fetch, robots, sitemap), knowledge.processor.ts,
│   │                knowledge-search.ts (full-text search), unanswered.service.ts + controller
│   ├── claude/      claude.client.ts (SDK wrapper: fallback, deadline, usage), prompt.ts,
│   │                platform-rules.ts, tools.ts (search_knowledge, API skill tools, confirmation)
│   ├── turns/       ai-router.ts (eligibility, debounced queueing), turn.processor.ts,
│   │                turn.service.ts (pre-check, run, re-check), apply.ts (effects in one
│   │                transaction), ai-conversations.service.ts (start, end, expire),
│   │                expiry.processor.ts, preview.controller.ts
│   ├── usage/       usage.service.ts (counting, atomic limit, alerts), usage.controller.ts,
│   │                ai-settings.controller.ts
│   ├── assistant/   assistant.service.ts + assistant.controller.ts, assistant.processor.ts,
│   │                assistant-tools.ts, assistant-actions.service.ts
│   ├── live-chat/   ai-state.controller.ts (GET /inbox/conversations/:id/ai)
│   └── ai.module.ts
├── src/modules/inbox/inbound/inbound-chat.handler.ts        # + AiAgentRouter after the flow router
├── src/modules/inbox/conversations/*, messages/*, routing/* # + end the AI conversation on take,
│                                                            #   reply, template, flow start,
│                                                            #   Waiting for agent and close
├── src/modules/flows/engine/run.ts, session.service.ts      # + aiAgent step, startedBy AI_AGENT
├── src/modules/maintenance/retention.processor.ts, contacts/contact-deletion.service.ts  # + AI records
├── src/common/metrics/metrics.service.ts, common/logging/redaction.ts, ops/alerts.yml
└── test/
    ├── unit/ai/             config, reply, masking, chunking, usage, prompt, extraction, search, eligibility
    ├── integration/         ai-agents-build-publish, ai-knowledge, ai-turns, ai-live-chat, ai-testing,
    │                        ai-replies-memory, ai-skills, ai-flows, ai-usage, ai-starters, ai-assistant
    ├── contract/            ai.contract-spec.ts
    └── fixtures/ai/         sample PDF (text and scanned), DOCX, HTML pages, robots.txt, sitemap.xml
apps/web/
├── src/app/(dashboard)/ai-agents/page.tsx           # list, create, starters
├── src/app/(dashboard)/ai-agents/[id]/page.tsx      # tabs: Instructions, Knowledge, Skills,
│                                                    # Hand-over, Test (preview + test numbers),
│                                                    # Versions, Unanswered
├── src/app/(dashboard)/ai-usage/page.tsx            # usage, limits, prices (admins)
├── src/components/ai/                               # forms, knowledge list and upload, preview chat,
│                                                    # assistant panel and action previews
├── src/components/inbox/                            # + AI banner, sources popover, agent label
├── src/components/flows/steps/ai-agent-form.tsx     # + Hand to AI agent step
└── e2e/                                             # ai-us1 … ai-us9
tools/mock-meta/src/ai.ts                            # fake Claude endpoint and rules
tools/perf/ai-latency.ts                             # SC-001 with the fake model
tools/eval/ai-agent-eval.ts + sets/                  # SC-002, SC-003, SC-005, SC-010 with the real model
```

**Structure Decision**: keep the monorepo layout. The feature is one NestJS module (`modules/ai`)
wired like 002 and 003: shared services in a global domain module (router, AI conversations, usage,
Claude client), HTTP controllers in the API module, and the `ai` and `ai-knowledge` processors in
`WorkerFeaturesModule`. Pure logic that the editor also needs lives in `packages/shared/src/ai`.

## Delivery Order (input for /sp.tasks)

| Phase | Scope | Exit check |
|---|---|---|
| Setup and foundation | Migration; permissions; shared config, reply, masking, chunking and usage schemas; `ai` and `ai-knowledge` queues; SDK dependency, `ClaudeClient` and env; mock-meta fake model; contract added to `lint:contracts` | Unit tests for the shared schemas are green; the fake model answers a scripted request |
| US1 (P1) | Agent CRUD, draft, publish, number assignment; written answers, websites and files with processing and search; prompt builder and platform rules; router, debounced turns, plain text replies with the introduction; reply records and usage counting; unanswered questions; list page and editor (Instructions, Knowledge) | `ai-agents-build-publish`, `ai-knowledge`, `ai-turns` and e2e `ai-us1` |
| US2 (P1) | Hand-over (asked, topics, unsure, repeat, reply cap) with summary notes; Open-only, member actions, keywords, opt-out requests, blocked contacts, window, flows first, no welcome message; fallback on failure and the `AI_FAILING` alert; AI banner in live chat | `ai-live-chat` and e2e `ai-us2` |
| US3 (P2) | Preview (dry run), test numbers on the draft, versions and restore | `ai-testing` and e2e `ai-us3` |
| US4 (P2) | Buttons, lists and media replies; memory with journey entries; sensitive-number guards | `ai-replies-memory` and e2e `ai-us4` |
| US5 (P2) | API skills on the 003 safe client; agent secrets and the skill test request; confirmation protocol for skills that change data | `ai-skills` and e2e `ai-us5` |
| US6 (P2) | `aiAgent` flow step (schema, engine, editor), Start a flow skills, AI conversations across flows | `ai-flows` and e2e `ai-us6` |
| US7 (P2) | Atomic monthly limit, alerts at 80% and 100%, usage page and AI settings | `ai-usage` and e2e `ai-us7` |
| US8 (P3) | Starter agents, attribute creation offer, `REPLACE_ME_LEFT` check | `ai-starters`, unit tests on starters, e2e `ai-us8` |
| US9 (P3) | Assistant requests, tools, drafts, action previews and confirmation; assistant panel | `ai-assistant` and e2e `ai-us9` |
| Polish | Metrics and alert, retention and erasure, redaction, audit coverage, RBAC from all contracts, docs (README, inventory), perf check (SC-001), eval tool and sets (SC-002/3/5/10), release checklist | All gates green in CI |

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `@anthropic-ai/sdk` | FR-047: replies come from an external AI service | **Raw HTTP calls:** lose typed errors, retries, structured outputs and the tool runner, and the SDK is the supported path |
| `unpdf`, `mammoth`, `cheerio`, `robots-parser` | FR-011: knowledge from PDF and DOCX files and websites that respects robots rules | **Hand-written parsers:** PDF and DOCX formats are not practical to parse by hand; regular expressions over HTML break on real pages |
| Queues `ai` and `ai-knowledge` | Model calls take seconds and must not block inbound handling (SC-001); PDF parsing is memory-heavy and must run one at a time | **Turns in the inbound worker:** stalls webhooks. **One shared queue:** a large PDF would delay customer replies |
| Whole-knowledge and search modes | SC-002 answer quality for small knowledge; FR-011 sizes for large knowledge | **Search only:** misses answers a small cached prompt gets right. **Whole only:** large knowledge cannot fit |
| 14 new tables and a generated `tsvector` | Agents, versions and secrets, knowledge and chunks, AI conversations and replies, unanswered questions, usage, and the assistant have separate lifecycles; full-text search needs the index | **JSON blobs on fewer tables:** no atomic limit counting, no search index, no erasure by contact |

## Architectural decisions to record

📋 Architectural decision detected: **AI agent architecture**. Claude Opus 5.5 through the Messages
API in our own bounded tool loop, structured JSON replies applied by our service, knowledge in
Postgres full-text search with a whole-knowledge cached prompt below 120,000 characters, and the
Anthropic data terms that satisfy Meta's no-training rule. Document the reasoning and tradeoffs?
Run `/sp.adr ai-agent-architecture`
