---
id: 81
title: Fix Boot And Implement US3 API
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["ci", "wiring", "us3", "preview", "test-numbers", "versions", "opt-out"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/ai.module.ts
 - apps/api/test/unit/app-module.spec.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/turns/ai-router.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
 - apps/api/src/modules/ai/turns/preview.service.ts
 - apps/api/src/modules/ai/turns/preview.controller.ts
 - apps/api/src/modules/ai/turns/decisions.ts
 - apps/api/src/modules/ai/agents/agents.service.ts
 - apps/api/src/modules/ai/agents/agents.controller.ts
 - apps/api/src/modules/ai/agents/versions.service.ts
 - apps/api/src/modules/ai/agents/versions.controller.ts
 - apps/api/test/unit/audit-coverage.spec.ts
 - apps/api/test/integration/ai-testing.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - CI run for 985ed57 (US2): the API did not boot, so every integration test failed in createTestContext and the container smoke test failed.
 - CI run for 3c1baed (boot fix): the containers pass; one test still failed (STOP left the AI conversation ACTIVE).
 - New unit test app-module.spec.ts compiles the HTTP app, the worker, and both together (no database needed). API unit tests 385/385; eslint and tsc clean.
---

## Prompt

continueee to jum to best save lagyyy wo karoo

(After a session restart, the user wrote:)

continue

## Response snapshot

- **US2 CI failure:** the new AI state controller needed `ConversationsService`, and only `InboxApiModule` exports it. Nest refused to start, so every integration test and the container smoke test failed.
  - **Fix:** `AiApiModule` imports `InboxApiModule`, as the flows API module does.
  - **New wiring tests:** compile the API (main.ts), the worker (worker.ts) and both together in seconds without a database, so mistakes like this are caught before a push.
  - The model call in the turn service became a reusable `think()`.
- **STOP left the AI conversation ACTIVE:** the flow router answers opt-out keywords and the handler returns there, so the AI router never ran. The handler now calls `aiAgents.onOptOut` before the flow router.
- **US3 API (test-first):**
  - Preview (`POST /ai-agents/:id/preview`): the draft answers a sample conversation through the shared `think()`. The reply gets an introduction on the first turn and shows its sources. "Would do" items are listed instead of done: hand-over, remember, start flow, opt-out, unanswered. Usage is recorded as PREVIEW and not counted. Each member gets 20 previews a minute (429 `PREVIEW_RATE_LIMITED`), and an unavailable AI service returns 503.
  - Test numbers (`PUT /ai-agents/:id/test-numbers`): up to 3, normalised to E.164 with the default country, audited `ai.test_numbers_updated`. The selector already gives test senders the draft.
  - Versions: list, newest first with the current one marked; restore copies a version into the draft with a revision bump, audited `ai.agent_restored`.
  - Two audit actions left the pending list.
- **Tests written:**
  - integration `ai-testing`: preview, rate limit, test numbers versus published, versions and restore;
  - US3 contract cases.

- **US3 web:**
  - A Test tab: a preview chat with an optional customer name, sources, "would do" items and cost; the draft is saved first; and up to 3 test numbers.
  - A Versions tab: versions with "Customers meet this one" on the published version, and restore with a confirm, which reloads the editor.
- **e2e `ai-us3-testing`:** the preview answers with the draft and sends nothing; a test number gets the draft reply while another phone gets version 1's answer; restoring version 1 brings its goal back.

## Outcome

- ✅ Impact: the US2 boot problem is fixed with a guard against repeats; US3 done (63 of 113 tasks).
- 🧪 Tests: unit, lint and typecheck pass locally; CI re-runs on push.
- 📁 Files: listed above.
- 🔁 Next prompts: US3 web (the Test and Versions tabs, T063) and e2e (T059); then US4.
- 🧠 Reflection: provider wiring can be checked without infrastructure. That test belongs in every Nest repo's unit suite.

## Evaluation notes (flywheel)

- Failure modes observed: DI wiring not covered by unit tests; an early return in the inbound handler hid the opt-out branch.
- Graders run and results (PASS/FAIL): CI US2 FAIL (boot); CI boot fix FAIL (1 test); local unit PASS 385.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): for every new hook, assert in the integration test that the path reaches it.
