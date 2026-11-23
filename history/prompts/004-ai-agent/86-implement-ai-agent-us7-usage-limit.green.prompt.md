---
id: 86
title: Implement AI Agent US7 Usage Limit
stage: green
date: 2026-11-22
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "usage", "monthly-limit", "cost", "alerts", "us7"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/usage/usage.service.ts
 - apps/api/src/modules/ai/usage/usage-report.service.ts
 - apps/api/src/modules/ai/usage/usage.controller.ts
 - apps/api/src/modules/ai/ai-api.module.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/decisions.ts
 - apps/web/src/app/(dashboard)/ai-usage/page.tsx
 - apps/web/src/app/(dashboard)/layout.tsx
 - apps/web/src/lib/ai.ts
 - apps/api/test/integration/ai-usage.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - apps/web/e2e/ai-us7-usage.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - eslint and tsc clean for api and web; CI on 1222dac (US6 e2e fix plus US7 parts 1–3) passed build-test, e2e-smoke, docker-images and secret-scan
 - ai-usage integration, the US7 contract cases and the ai-us7-usage e2e test run in CI
---

## Prompt

continue

(The session restarted; the user wrote "continue" with /model and /effort set.)

## Response snapshot

US7 (usage, monthly limit and cost), T085–T090, committed in small checkpoints:

- **Limit:** a pre-check before the model call; at the limit the turn makes no model call and hands the chat over.
  - The reply is claimed inside the apply transaction with a guarded update (`replies < limit`), so two turns can never both take the last reply. The loser hands over too.
  - The hand-over sends the admin's limit message (with the introduction on a first reply), adds the limit note, ends the AI conversation `LIMIT_REACHED` and records a LIMIT reply that is not counted.
- **Alerts:** admins get AI_USAGE alerts at 80% and 100%, once each. The level is stored, and reset when an admin changes the limit.
- **Report and settings:**
  - `GET /ai-usage?month=`: replies against the limit, test replies, preview turns, cost from the measured tokens and the admin's prices, per agent, per day, and how AI conversations ended. Months follow the company time zone.
  - `GET/PUT /ai-settings`: limits, prices and the limit message, for admins only. Changes are audited as `ai.limits_changed`.
  - Both controllers live in usage.controller.ts rather than a separate ai-settings.controller.ts.
- **Web:** an AI usage page with a month picker, cards, outcomes, per-agent and per-day tables, and a limits and prices form.
- **Tests:**
  - Integration: count 1–5, then the sixth limited with no model call; raising the limit resumes; two concurrent turns for the last reply give one SENT and one LIMITED; test replies are counted and shown apart; a failed turn is not counted; the report matches the records; admins only.
  - Contract cases for both endpoints.
  - An e2e test sets the limit to the month's count plus two on the page, sends three questions and sees two answers, then the limit message, the count on the page, the note in live chat and a new alert. It restores the settings afterwards.

## Outcome

- ✅ Impact: US7 complete (90 of 113 tasks).
- 🧪 Tests: lint and typecheck pass; integration, contract and e2e wait for CI.
- 📁 Files: listed above.
- 🔁 Next prompts: CI for US7; then US8 (starter agents), US9 (team assistant) and Polish.
- 🧠 Reflection: the e2e compares alerts by id, because the notification list returns only the latest 50 and a count could stay the same as old ones drop out.

## Evaluation notes (flywheel)

- Failure modes observed: none new; the earlier CI run confirmed the US6 e2e fix.
- Graders run and results (PASS/FAIL): lint/tsc PASS; CI pending for US7 tests.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): a unit test for `alertLevelFor` edge values (limit 0, exactly 80%).
