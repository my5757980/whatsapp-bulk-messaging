---
id: 73
title: Plan AI Agent Architecture
stage: plan
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "ai-agent", "claude-api", "knowledge-search", "structured-outputs", "usage-limit", "assistant"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/004-ai-agent/plan.md
 - specs/004-ai-agent/research.md
 - specs/004-ai-agent/data-model.md
 - specs/004-ai-agent/quickstart.md
 - specs/004-ai-agent/contracts/ai-api.openapi.yaml
 - specs/004-ai-agent/contracts/agent-config.md
 - specs/004-ai-agent/contracts/claude-messages.md
 - CLAUDE.md
 - history/prompts/004-ai-agent/73-plan-ai-agent-architecture.plan.prompt.md
tests:
 - redocly lint of contracts/ai-api.openapi.yaml (valid after quoting four descriptions)
 - NUL scan of specs and history (clean)
---

## Prompt

karoo continue

(After a session restart, the user wrote:)

continue

## Response snapshot

The 004 plan was written after checking the facts it depends on:
- **Sources checked:** the Claude API skill reference (models, prices, tool use, structured outputs, caching, fallbacks), npm versions, BullMQ's debounce mode (context7), and Anthropic's privacy articles. Anthropic does not train on commercial API data and deletes it within 30 days; zero data retention is available by agreement.
- **Model and SDK:** `claude-opus-5-5` through `@anthropic-ai/sdk` 1.6.0, effort `low` for customer replies and `medium` for the assistant, with server-side refusal fallback and prompt caching. The model is a setting (`AI_MODEL`).
- **Loop:** a bounded tool loop in our worker (tool runner, 4 iterations, 30 s deadline). Managed Agents was rejected because turns must check live chat state, data must stay under our retention and erasure duties, and latency and cost matter.
- **Replies:** structured JSON, validated and applied by our service in one transaction: message, buttons, list, media, sources used, hand-over, memory, start flow, opt-out, unanswered.
- **Knowledge:** chunks in Postgres full-text search. All knowledge goes into the cached prompt up to 120,000 characters; above that, pre-retrieval plus a search tool. No embeddings provider, because FR-047 allows no other third party.
- **Pipeline:** the AI router runs after the flow router and before automatic replies. Turns are debounced BullMQ jobs on an `ai` queue; replies go through the 002 send path. Website and file reading uses a separate `ai-knowledge` queue, one job at a time.
- **Guards in code:** masking of card, Emirates ID and IBAN numbers; the introduction text; output limits; a confirmation protocol for skills that change data; the repeat and reply-cap hand-overs; an atomic monthly limit.
- **Artifacts:** research (R1–R18), a data model of 13 tables with the AI conversation state machine, the OpenAPI contract (valid in redocly), the agent configuration and Claude call contracts (including mock-meta's fake model), a quickstart, the Constitution Check (PASS before and after design), the delivery order and complexity tracking.

## Outcome

- ✅ Impact: 004 is ready for `/sp.tasks`.
- 🧪 Tests: the new contract lints clean; tests are planned per story with Claude mocked (nock and the fake model), and quality is measured by a manual eval with the real model.
- 📁 Files: listed above.
- 🔁 Next prompts: `/sp.tasks` for 004; optionally `/sp.adr ai-agent-architecture`.
- 🧠 Reflection: putting side effects in a validated JSON reply instead of tools keeps preview, atomicity and policy checks in our code. The model is trusted only for wording and judgement, and those are measured by evals.

## Evaluation notes (flywheel)

- Failure modes observed: unquoted YAML flow-mapping descriptions containing commas broke the contract structure (redocly "struct" errors); they are now quoted.
- Graders run and results (PASS/FAIL): redocly lint PASS (after the fix).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): lint every new OpenAPI file right after writing it, before referencing it elsewhere.
