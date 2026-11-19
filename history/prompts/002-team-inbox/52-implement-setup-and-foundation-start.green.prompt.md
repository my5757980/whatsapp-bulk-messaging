---
id: 52
title: Implement Setup And Foundation Start
stage: green
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 002-team-inbox
branch: 002-team-inbox
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "live-chat", "tdd", "migration"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/common/config/config.ts
 - packages/shared/src/permissions.ts
 - tools/mock-meta/src/server.ts
 - tools/mock-meta/src/inbound-cli.ts
 - samples/media/*
 - apps/api/src/modules/inbox/inbox-common.ts
 - apps/api/src/modules/inbox/conversations/conversation-state.ts
 - apps/api/src/modules/inbox/conversations/window.ts
 - apps/api/src/modules/inbox/conversations/visibility.ts
 - apps/api/src/modules/inbox/inbound/message-parser.ts
 - apps/api/src/modules/inbox/realtime/event-filter.ts
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261120000000_live_chat/migration.sql
tests:
 - apps/api/test/unit/config.spec.ts (4 pass)
 - packages/shared/src/permissions.test.ts (43 pass)
 - apps/api/test/unit/inbox/*.spec.ts (82 pass, red first)
 - mock-meta smoke test (all send shapes, media download, read receipt)
 - npm run lint:contracts (pass)
---

## Prompt

continue

## Response snapshot

Phase 1 is complete (T001-T005) and pushed: web-push 3.6.7 with optional WEB_PUSH_* settings, 7 inbox permissions, mock-meta free-form sends, read receipts, media download and a 131047 test number, an inbound CLI covering every message type, sample media, and the inbox contract in lint:contracts.

Phase 2 has started. Done:
- unit tests T006, T007, T009 and T010 (red, then green)
- pure modules T014, T015 and T017, plus the event filter
- schema and migration T013 (diffed offline; Docker was down)

Left in Phase 2:
- T008's SQL agreement integration test, and T016's rule-loader cache
- integration tests T011 and T012
- T018-T023: event bus, fan-out, SSE endpoint, priorities, wiring, web hook

The usage limit was reached mid-phase.

## Outcome

- ✅ Impact: Setup is done; the foundation has its pure rules and schema.
- 🧪 Tests: 82 new inbox unit tests pass. The migration is not yet applied to a database because Docker is down; CI will cover it.
- 📁 Files: listed above
- 🔁 Next prompts: "continue" → T008 integration, T011/T012, then T018-T023
- 🧠 Reflection: Generating the migration offline with migrate diff avoided needing Docker.

## Evaluation notes (flywheel)

- Failure modes observed: CRLF files broke string patches (normalised in the scripts); a shell heredoc with nested quotes failed (switched to script files).
- Graders run and results (PASS/FAIL): unit PASS, contract lint PASS
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): N/A
