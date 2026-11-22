---
id: 85
title: Implement AI Agent US6 Flows
stage: green
date: 2026-11-22
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "chatbot-flows", "hand-to-ai", "start-flow", "us6"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - packages/shared/src/flows/graph.ts
 - packages/shared/src/flows/validate.ts
 - apps/api/src/modules/flows/engine/effects.ts
 - apps/api/src/modules/flows/engine/run.ts
 - apps/api/src/modules/flows/engine/session.service.ts
 - apps/api/src/modules/flows/definitions/publish.service.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/web/src/lib/flows.ts
 - apps/web/src/components/flows/steps/ai-agent-form.tsx
 - apps/web/src/components/flows/steps/step-form.tsx
 - apps/web/src/components/ai/skills-tab.tsx
 - packages/shared/src/flows/graph.test.ts
 - packages/shared/src/flows/validate.test.ts
 - apps/api/test/unit/flows/run-ai-step.spec.ts
 - apps/api/test/integration/ai-flows.int-spec.ts
 - apps/web/e2e/ai-us6-flows.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - shared flow tests 68/68; API unit 401/401 (incl. run-ai-step and the wiring tests); eslint and tsc clean for shared, api and web
 - ai-flows integration and the ai-us6-flows e2e test run in CI
---

## Prompt

continue

(Several session restarts; the user wrote "continue" each time.)

## Response snapshot

US6 (work together with chatbot flows), T077–T084, committed in small checkpoints because sessions kept stopping:

- **Shared graph:** a Hand to AI agent step (`aiAgent`) with an agent, required to publish, and an optional opening message of up to 1,024 characters. It has no next step, so it counts as an end. Validation adds `MISSING_CONTENT` and the `AGENT_NOT_PUBLISHED` code.
- **Engine:** the step sends its opening message, emits `handToAi` and ends `HANDED_TO_AI`.
  - The session service starts the agent's AI conversation (started by FLOW; test runs use the draft) under the AI conversation lock. From the customer's next message that agent answers, even on a number with another agent.
  - Flow publishing refuses `AGENT_NOT_PUBLISHED`.
- **Agent starts a flow:** `startFlow` starts the published flow with `startedBy: AI_AGENT` after the reply commits. The AI conversation stays active: the flow answers while it runs, and the same agent continues afterwards without a second introduction.
  - A reply that only starts a flow sends nothing and is not counted.
- **Web:**
  - The flow editor has a palette entry, a form and a canvas summary for the step.
  - The Skills tab lists the flows the agent may start, each with when to start it.
  - Fixed: new step ids came from the type name, so this step would have been `aiAgent-1`. Step ids must be lower-case, so it is now `ai-agent-1`; the other types are unchanged.
- **Noticed, left alone:** the 003 flow editor's palette has no Hand over step, although the step exists. It is outside this feature.
- **Tests:** shared graph and validation, the engine step, an integration test covering keyword priority, a hand-off to a non-number agent, agent-started flows with continuation and both publish refusals, and an e2e test that builds the step in the editor and sees the agent continue.

## Outcome

- ✅ Impact: US6 complete (84 of 113 tasks).
- 🧪 Tests: unit/lint/typecheck pass; integration and e2e wait for CI.
- 📁 Files: listed above.
- 🔁 Next prompts: CI for US6; then US7 (usage, monthly limit and cost). Possibly add Hand over to the 003 flow editor palette (ask the user).
- 🧠 Reflection: frequent local checkpoint commits kept every finished part safe across repeated session stops.

## Evaluation notes (flywheel)

- Failure modes observed: a camelCase step type would have produced an invalid step id in the editor (caught by reading the id rules before the e2e).
- Graders run and results (PASS/FAIL): unit PASS; lint/tsc PASS; CI pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): a unit test that every palette step type yields a schema-valid new step.
