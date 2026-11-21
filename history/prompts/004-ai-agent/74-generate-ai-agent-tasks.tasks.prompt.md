---
id: 74
title: Generate AI Agent Tasks
stage: tasks
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "ai-agent", "test-first", "user-stories"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/004-ai-agent/tasks.md
 - specs/004-ai-agent/data-model.md
 - specs/004-ai-agent/plan.md
 - specs/004-ai-agent/research.md
 - specs/004-ai-agent/contracts/agent-config.md
 - specs/004-ai-agent/contracts/ai-api.openapi.yaml
 - history/prompts/004-ai-agent/74-generate-ai-agent-tasks.tasks.prompt.md
tests:
 - task format check (113 tasks, sequential ids, story labels only in story phases, a path in every task)
 - redocly lint of contracts/ai-api.openapi.yaml after adding the agent secret and skill-test endpoints (valid)
---

## Prompt

haaaaa

## Response snapshot

The user said yes to generating the tasks.

- **A gap fixed first:** 003 API secrets belong to one flow, so AI agents could not use them. The design gained `ai_agent_secrets` (encrypted with the 001 cipher, names only, `SECRET_IN_USE`) and the endpoints for agent secrets and the skill test request, across the data model (now 14 tables), research, agent-config and the contract (redocly valid).
- **specs/004-ai-agent/tasks.md, 113 tasks, test-first per story:**
  - Setup (6): SDK and parsing libraries pinned, permissions, queues, env, contract lint, the fake model in mock-meta.
  - Foundational (15): migration, shared config, reply, masking and usage schemas, the Claude client, the AI module, the conversation service, the inbound hook, the live chat label.
  - US1 (25): knowledge, prompt, turn pipeline, editor. US2 (10): hand-over, live chat rules, failures, banner. US3 (7): preview, test numbers, versions.
  - US4 (6): buttons, lists, media, memory. US5 (7): API skills, secrets, confirmation. US6 (8): flow step and Start a flow.
  - US7 (6): limit, alerts, usage page. US8 (5): starters. US9 (8): assistant.
  - Polish (10): metrics and alert, retention and erasure, redaction, audit, RBAC, perf, journey display, docs, the manual eval tool, the release checklist.
- **Parallel and MVP:** 68 tasks are marked parallel. The MVP is Setup, Foundational and US1; US1 and US2 are released together before customers see the agent.

## Outcome

- ✅ Impact: 004 is ready for `/sp.implement`.
- 🧪 Tests: every story starts with failing unit, integration, contract and e2e tests. Claude is mocked with nock and the fake model; real-model quality is checked only by the manual eval (T112).
- 📁 Files: listed above.
- 🔁 Next prompts: `/sp.implement` for 004 (Setup and Foundational first), then a draft PR so CI runs the Docker-based tests.
- 🧠 Reflection: mapping each story's tasks to real file paths exposed a design gap (per-flow secrets) before any code was written.

## Evaluation notes (flywheel)

- Failure modes observed: two tasks named files without directories; the format check caught them and they now have full paths.
- Graders run and results (PASS/FAIL): task format check PASS; redocly lint PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): run the task format check as part of generating any task list.
