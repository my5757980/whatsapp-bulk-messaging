---
id: 61
title: Plan Chatbot Flow Builder
stage: plan
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 003-chatbot-flow-builder
branch: 003-chatbot-flow-builder
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "chatbot", "flow-engine", "architecture"]
links:
  spec: specs/003-chatbot-flow-builder/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/003-chatbot-flow-builder/plan.md
 - specs/003-chatbot-flow-builder/research.md
 - specs/003-chatbot-flow-builder/data-model.md
 - specs/003-chatbot-flow-builder/quickstart.md
 - specs/003-chatbot-flow-builder/contracts/flows-api.openapi.yaml
 - specs/003-chatbot-flow-builder/contracts/flow-graph.md
 - specs/003-chatbot-flow-builder/contracts/meta-graph-flows.md
 - CLAUDE.md
tests:
 - none (planning stage)
---

## Prompt

continue

## Response snapshot

Ran /sp.plan for 003 (continuing the user's "continue"). Research R1–R17: draft graph on `flows` with versions and pruned revisions; triggers derived on publish and matched per message without a worker cache; patterns limited by `node:vm` timeouts; a pure session interpreter with effects applied under a per-conversation lock and a partial unique index; routing inside 002's inbound handler before welcome/off-hours; flow messages through 002's send path with new BUTTONS/LIST content types; a BullMQ `flows` queue for timers (wait tokens) and API calls with an SSRF-safe HTTPS client and encrypted secrets; analytics from step records; `@xyflow/react` 12.12.1 (the newest release at least 2 weeks old) for the canvas; `flows.manage` permission. WhatsApp interactive limits checked against a typed Cloud API client. Data model with 7 tables and the session state machine; OpenAPI contract, graph contract, Meta usage contract and quickstart. Constitution check PASS before and after design; complexity table justifies the canvas library, the new queue, vm patterns and the tables. ADR suggested: chatbot-flow-engine.

## Outcome

- ✅ Impact: 003 plan and design artifacts ready for /sp.tasks.
- 🧪 Tests: none at this stage; the plan lists unit, integration, contract and e2e suites per story.
- 📁 Files: see the list above.
- 🔁 Next prompts: /sp.tasks for 003, then /sp.implement; optionally /sp.adr chatbot-flow-engine.
- 🧠 Reflection: React Flow 13 was released 4 days ago, so the plan pins 12.12.1 per the 2-week rule.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): constitution check PASS (both gates).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): confirm interactive limits on Meta's reference before release.
