---
id: 78
title: Open PR And Fix CI Failures
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: none
labels: ["ci", "pull-request", "ai-turns", "timestamps", "flaky-test", "us1"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261127000000_ai_agent/migration.sql
 - apps/api/src/modules/ai/turns/ai-router.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/turns/ai-conversations.service.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
 - apps/api/test/integration/ai-turns.int-spec.ts
 - apps/api/test/integration/flows-live-chat.int-spec.ts
 - specs/004-ai-agent/data-model.md
 - specs/004-ai-agent/research.md
tests:
 - CI run 44867634903 on PR #5. The migration applied, and all integration tests passed except three.
 - Fixed: ai-turns second turn returned NOTHING; the NEWER check returned SENT; flows-live-chat welcome expected [Welcome] but got [].
 - API unit tests 369/369, eslint, tsc pass locally after the fix
---

## Prompt

kar diaaa haiiigithub connected tests karooo

## Response snapshot

Opened draft PR #5 (004-ai-agent → main) so CI could run. The first CI run applied the 004 migration, and every integration test passed except three:

- **ai-turns:** both failures share one cause. WhatsApp message times have one-second precision, and turns picked "new" messages with a time cursor (`occurredAt > lastHandledAt`) and checked for newer messages the same way. A message arriving in the same second as the last handled one was skipped (`NOTHING`), or was not seen as newer (`SENT` instead of `NEWER`). Mixing our millisecond clock with WhatsApp's seconds made it worse.
  - **Fix:** a pending flag. The router sets `chat_messages.ai_pending` on each message it queues a turn for. A turn answers all flagged messages (the newest 10 go in the prompt). The applier treats any other flagged message as NEWER, and clears the flags when it sends or drops the reply. Ending an AI conversation clears what is still waiting.
  - **History:** a new AI conversation's `startedAt` is now the first customer message it covers, so later turns' history includes the first exchange (it used to depend on a 60-second margin).
  - The column and its partial index were added to the unreleased 004 migration. The data model and research R5 are updated.
- **flows-live-chat welcome (a 003 test):** it depended on the clock. Welcome messages go out only within working hours (Mon–Fri 09:00–18:00 UTC by default), and CI ran on a Saturday at 04:46 UTC. Both welcome tests now open every hour of the week while they run.
- **ai-turns test 1:** now also checks that the second request carries the first exchange as history.

## Outcome

- ✅ Impact: US1's turn pipeline no longer depends on clock precision; a pre-existing clock-dependent 003 test is fixed.
- 🧪 Tests: unit, eslint and tsc pass locally; CI re-runs on push.
- 📁 Files: listed above.
- 🔁 Next prompts: watch the second CI run; then "continue" starts US2.
- 🧠 Reflection: never compare WhatsApp timestamps (seconds, possibly out of order) with our clock, or with each other, to decide what is new; mark the items explicitly.

## Evaluation notes (flywheel)

- Failure modes observed: time-cursor precision bug; test dependent on the day and hour CI runs.
- Graders run and results (PASS/FAIL): CI run 1 FAIL (3 integration tests); local unit/lint/tsc PASS after the fix.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): add a lint-style review check that flags `occurredAt: { gt:` cursors in new code.
