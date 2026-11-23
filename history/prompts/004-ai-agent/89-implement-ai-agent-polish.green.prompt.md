---
id: 89
title: Implement AI Agent Polish Phase
stage: green
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "polish", "metrics", "retention", "redaction", "rbac", "perf", "eval", "docs", "release"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/common/metrics/metrics.service.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/usage/usage.service.ts
 - apps/api/src/modules/ai/knowledge/knowledge.processor.ts
 - apps/api/src/modules/ai/assistant/assistant.runner.ts
 - ops/alerts.yml
 - apps/api/test/unit/alerts.spec.ts
 - apps/api/src/modules/maintenance/retention.processor.ts
 - apps/api/src/modules/contacts/contact-deletion.service.ts
 - apps/api/test/integration/retention.int-spec.ts
 - apps/api/test/integration/contact-deletion.int-spec.ts
 - apps/api/src/common/logging/redaction.ts
 - apps/api/test/unit/logging-redaction.spec.ts
 - apps/api/test/unit/audit-coverage.spec.ts
 - apps/api/test/integration/rbac.int-spec.ts
 - tools/perf/ai-latency.ts
 - tools/perf/client.ts
 - apps/web/src/components/inbox/journey-list.tsx
 - apps/web/tests/journey-list.test.ts
 - apps/web/e2e/ai-us4-rich-replies.spec.ts
 - tools/eval/ai-agent-eval.ts
 - tools/eval/tsconfig.json
 - tools/eval/sets/knowledge.json
 - tools/eval/sets/answerable.json
 - tools/eval/sets/unanswerable.json
 - tools/eval/sets/rule-breaking.json
 - tools/eval/sets/person-requests.json
 - tools/eval/sets/handovers.json
 - package.json
 - .gitignore
 - README.md
 - docs/research/aisensy/feature-inventory-2026-11-19.md
 - specs/004-ai-agent/quickstart.md
 - specs/004-ai-agent/checklists/release.md
 - specs/004-ai-agent/tasks.md
tests:
 - api unit 415/415 (46 files), shared 163/163 (17 files), web 6/6 (2 files), local
 - eslint and tsc clean for api, web, shared, mock-meta, tools/perf and tools/eval
 - CI green on 5ad94ad (retention, erasure, RBAC with the AI contract, metrics and the alert rules)
 - the eval dry run lists 500 calls and makes none without EVAL_CONFIRM=yes
---

## Prompt

continue

(Same request as PHR 88; after US9 was green in CI, the Polish phase followed.)

## Response snapshot

Polish, T104–T113:

- **T104 Metrics and alert:**
  - New metrics: turns by result, turn duration (only for turns that called the model), tokens by kind (counted where usage is recorded), counted replies by test, knowledge jobs by kind and outcome, and assistant requests by outcome.
  - New alert `WbmAiFailing`: more than 20% of the turns that called the model fail, with at least 10 turns, in 15 minutes.
- **T105 Retention and erasure:**
  - After 12 months the daily job removes ended AI conversations with their replies and asks, older replies and asks, questions nobody asked, and assistant requests with their actions. Question counts are recomputed.
  - Deleting a contact clears AI conversation links, summaries, pending confirmations and unanswered streaks, and deletes their asks (and questions only they asked). Reply counts and sources stay.
- **T106 Redaction:** prompts, system text, knowledge, chunks, questions, answers, replies, summaries, remembered values and pending confirmations are kept out of logs.
- **T107 Audit coverage:** all 17 AI actions are now recorded; none are pending.
- **T108 RBAC:** the role test reads the AI contract too, and every path parameter gets the dummy id. The 38 AI operations match the code.
- **T109 Performance:** `npm run perf:ai`, the SC-001 check against the fake model (50 customers, 3 rounds, replies matched to their chats). The perf client's stream now passes the event data.
- **T110 Journey:** "AI agent "X" started answering" (from a flow, test) and "stopped: <reason>". Changes by the agent say "by AI agent "X"". This has a unit test, and the US4 e2e uses the new wording.
- **T111 Docs:**
  - README has an AI agents section and the checks, retention and AI service notes.
  - Inventory items 9.1–9.6 and the roadmap are marked as built.
  - Quickstart now covers how to run the eval, the alert name, the template draft review and the test list.
- **T112 Eval:** `npm run eval:ai` runs the full SC sets through the preview chat with the real model.
  - Sets: 100 answerable, 50 unanswerable, 200 rule-breaking, 100 person requests (English and Arabic) and 50 hand-overs.
  - It scores the sets automatically and writes review sheets, including SC-010.
  - It runs only with EVAL_CONFIRM=yes; otherwise it only says what it would run.
- **T113 Release checklist:** gates, CI for each story, quickstart rows mapped to tests, the gaps fixed, and the pre-release items (Anthropic account and key, data protection review, zero data retention, model and prices, eval, perf, migrations, egress, Prometheus, sign-off).

## Outcome

- ✅ Impact: 004 complete in code, 113 of 113 tasks. Release items need people: the company's Anthropic account, the reviews, the eval run with approval and staging perf.
- 🧪 Tests: unit, lint and typecheck pass locally; the CI run with the Polish commits is green, and the newest push is in CI.
- 📁 Files: listed above.
- 🔁 Next prompts: confirm the last CI run; then the user decides on the release items, marking PR #5 ready and merging it (the user merges, as for 001–003).
- 🧠 Reflection:
  - Counting tokens and replies where usage is recorded covers turns, previews and the assistant in one place.
  - The turn alert divides only by turns that called the model, so skipped turns do not hide failures.

## Evaluation notes (flywheel)

- Failure modes observed: the journey wording change would have broken the US4 e2e; it was found by searching the e2e specs before pushing.
- Graders run and results (PASS/FAIL): unit PASS; lint/tsc PASS; CI PASS (5ad94ad); latest push pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): a CI job that runs the eval's scoring on recorded replies (no model calls), to catch scorer regressions.
