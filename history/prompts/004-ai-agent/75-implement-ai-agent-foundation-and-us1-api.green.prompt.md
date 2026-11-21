---
id: 75
title: Implement AI Agent Foundation and US1 API
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "claude-api", "knowledge", "turn-pipeline", "us1"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261127000000_ai_agent/migration.sql
 - packages/shared/src/ai/config.ts
 - packages/shared/src/ai/reply.ts
 - packages/shared/src/ai/masking.ts
 - packages/shared/src/ai/usage.ts
 - packages/shared/src/ai/chunking.ts
 - apps/api/src/modules/ai/claude/claude.client.ts
 - apps/api/src/modules/ai/claude/platform-rules.ts
 - apps/api/src/modules/ai/claude/prompt.ts
 - apps/api/src/modules/ai/claude/tools.ts
 - apps/api/src/modules/ai/agents/agents.service.ts
 - apps/api/src/modules/ai/agents/agents.controller.ts
 - apps/api/src/modules/ai/agents/publish.service.ts
 - apps/api/src/modules/ai/knowledge/crawler.ts
 - apps/api/src/modules/ai/knowledge/extract/pdf.ts
 - apps/api/src/modules/ai/knowledge/extract/docx.ts
 - apps/api/src/modules/ai/knowledge/extract/html.ts
 - apps/api/src/modules/ai/knowledge/knowledge.service.ts
 - apps/api/src/modules/ai/knowledge/knowledge.processor.ts
 - apps/api/src/modules/ai/knowledge/knowledge-search.ts
 - apps/api/src/modules/ai/knowledge/unanswered.service.ts
 - apps/api/src/modules/ai/turns/ai-router.ts
 - apps/api/src/modules/ai/turns/agent-selector.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/usage/usage.service.ts
 - tools/mock-meta/src/ai.ts
 - apps/web/src/components/inbox/chat-item-view.tsx
 - specs/004-ai-agent/tasks.md
tests:
 - packages/shared unit tests for config, reply, masking, usage and chunking (29 new)
 - apps/api unit tests (40 files, 369 passing), including the Claude client with nock, extraction on PDF/DOCX/HTML fixtures, the website reader, the prompt builder and search query building
 - integration tests ai-agents-build-publish, ai-knowledge, ai-turns and the AI contract test, written; they run in CI once a draft PR exists
 - eslint and tsc clean for api, web, shared, mock-meta; NUL scans clean (binary fixtures only)
---

## Prompt

shuruuu karooooo

(After session restarts, the user wrote:)

continue

continue

## Response snapshot

Implementation of 004 started test-first:

- **Setup (T001–T006):** pinned `@anthropic-ai/sdk` 1.6.0, `unpdf` 2.1.0, `mammoth` 1.13.0, `cheerio` 1.2.0 and `robots-parser` 3.0.1; added the permissions, the `ai` and `ai-knowledge` queues, the env settings (a throwaway key in CI, the fake model for e2e) and the contract lint. A fake Claude endpoint was added to mock-meta.
  - A smoke test with the real SDK showed that the tool runner uses message threads by default. It now runs with `thread: false`, so every call carries the full history and nothing is held at the provider.
- **Foundation (T007–T021):** the migration with 14 tables, a generated tsvector, partial unique indexes and checks.
  - Shared schemas: config with publish problems, a strict reply JSON with a sanitiser, masking, usage maths.
  - The Claude client (fallback, deadline, summed usage, typed failures), the AI module, the conversation service and the router hook after flows. Live chat shows the agent's name.
  - BullMQ `keepLastIfActive` makes sure a message that arrives during a running turn gets one more turn.
- **US1, part 1:**
  - Chunking.
  - PDF, DOCX and HTML extraction. Fixtures were generated with PyMuPDF and jszip.
  - A website reader on the 003 safe lookup: robots rules, sitemap, same-host links, limits.
  - Platform rules and the prompt builder (cache-friendly order, knowledge as a user turn, masked text, never the phone).
  - Full-text search.
- **US1, part 2:**
  - Agents API: CRUD, duplicate with files and secrets, drafts, publish checks, versions, numbers.
  - Knowledge API and the background processor.
  - Unanswered questions.
  - The turn pipeline: selector, router, turn service, and an applier that re-checks the chat under locks, then writes the item, the reply record, usage and the AI conversation, and queues the 002 send.
- **Gaps found and fixed along the way:**
  - nock 15 passes a fetch Request to one-argument reply callbacks.
  - A delayed nock reply trips undici after an abort.
  - pdf.js in unpdf has no `destroy()`.
  - robots-parser needs an interop shim for its typings.
  - Shell escaping removed backslashes twice; those files were rewritten with the Write tool.

## Outcome

- ✅ Impact: Setup, Foundation and the US1 backend are done (42 of 113 tasks). Next: the US1 web pages and the e2e test, then US2.
- 🧪 Tests: unit tests are green locally. Integration, contract and e2e tests wait for CI.
- 📁 Files: listed above.
- 🔁 Next prompts: open a draft PR for 004 so CI runs. The GitHub connector failed to connect in this session, so the user may need to retry it or open the PR on GitHub. Then the US1 web pages (T044–T046) and the e2e test (T031).
- 🧠 Reflection: smoke-testing the real SDK against the fake endpoint early exposed the default message threads. That would have broken the design goal of keeping data at home, and the fake model too.

## Evaluation notes (flywheel)

- Failure modes observed: library behaviour changed under the plan (SDK threads by default, nock 15 callback shape, pdf.js destroy); shell escaping of regex backslashes.
- Graders run and results (PASS/FAIL): unit tests PASS (369 api, shared all); eslint/tsc PASS; integration/contract tests NOT RUN (no PR, GitHub connector down).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): run a smoke test of every new third-party client against its mock before building on it.
