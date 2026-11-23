---
id: 87
title: Implement AI Agent US8 Starters
stage: green
date: 2026-11-22
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "starter-agents", "attributes", "replace-me", "us8"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - packages/shared/src/ai/starters/index.ts
 - packages/shared/src/ai/starters/starters.test.ts
 - packages/shared/src/index.ts
 - apps/api/src/modules/ai/agents/agents.service.ts
 - apps/api/src/modules/ai/agents/starters.controller.ts
 - apps/api/src/modules/ai/knowledge/answer-rows.ts
 - apps/api/src/modules/ai/knowledge/knowledge.service.ts
 - apps/api/src/modules/ai/ai.module.ts
 - apps/api/test/integration/ai-starters.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - apps/web/src/app/(dashboard)/ai-agents/page.tsx
 - apps/web/src/lib/ai.ts
 - apps/web/e2e/ai-us8-starters.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - shared starter tests 29/29 (with the flow starters); API wiring unit test 3/3; eslint and tsc clean for shared, api and web
 - ai-starters integration, the US8 contract case and the ai-us8-starters e2e test run in CI
---

## Prompt

continue

(Same session as PHR 86; after US7 was pushed, work went on to the next story.)

## Response snapshot

US8 (start from a ready-made agent), T091–T095:

- **Starters (shared, our own text):** Sales enquiries, Customer support, Booking requests and Lead qualification.
  - Each has a goal, tone, guardrails, hand-over topics, three example answers and the attributes it remembers.
  - The parts to change in each example answer are in square brackets.
  - Where a key is shared with the flow starters (`interest`), the type is the same.
  - `agentStarterConfig()` builds the draft with the new agent's name as the display name.
- **API:**
  - `GET /ai-agent-starters` (ai.manage) lists the starters, with an `exists` flag for each suggested attribute.
  - Creating from a starter saves its draft and its example answers (marked "replace me") in one transaction, in the starter's order. An unknown starter gives 422. The audit records the starter.
  - The answer insert is shared with adding a written answer (answer-rows.ts).
  - Publishing was already refused with `REPLACE_ME_LEFT`; editing an answer clears the mark, and switching it off does not.
- **Web:**
  - The new-agent dialog has "Start from", showing the chosen starter's description.
  - After creating, it offers to create the missing attributes ("Create attributes and open" or "Open without them"). An attribute someone else created meanwhile is fine.
- **Tests:**
  - Unit: the drafts parse with nothing blocking them, the examples have parts to replace, the attributes are valid and match what the agent remembers, and the wording is ours.
  - Integration: the flags match the attribute definitions; the draft and its examples; an unknown starter or a taken name leaves nothing behind; publishing is refused until all examples are replaced or removed.
  - Contract cases for the new endpoint.
  - An e2e test that creates from Lead qualification, creates the offered attributes, sees publishing refused, replaces one example, removes two and publishes.

## Outcome

- ✅ Impact: US8 complete (95 of 113 tasks).
- 🧪 Tests: unit, lint and typecheck pass; integration, contract and e2e wait for CI.
- 📁 Files: listed above.
- 🔁 Next prompts: CI for US7 and US8; then US9 (AI assistant for the team) and Polish.
- 🧠 Reflection: rows created in one transaction share `now()`, so the example answers get creation times a millisecond apart to keep the starter's order in the knowledge list.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): unit PASS; lint/tsc PASS; CI pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): show the starter's suggested hand-over topics in the dialog before creating.
