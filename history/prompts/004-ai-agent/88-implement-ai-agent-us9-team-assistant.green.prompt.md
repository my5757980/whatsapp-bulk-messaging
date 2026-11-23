---
id: 88
title: Implement AI Agent US9 Team Assistant
stage: green
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "team-assistant", "drafts", "confirmation", "streaming", "us9"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/assistant/assistant-tools.ts
 - apps/api/src/modules/ai/assistant/assistant-prompt.ts
 - apps/api/src/modules/ai/assistant/assistant.runner.ts
 - apps/api/src/modules/ai/assistant/assistant.service.ts
 - apps/api/src/modules/ai/assistant/assistant-actions.service.ts
 - apps/api/src/modules/ai/assistant/assistant-views.ts
 - apps/api/src/modules/ai/assistant/assistant.controller.ts
 - apps/api/src/modules/ai/claude/claude.client.ts
 - apps/api/src/modules/ai/ai-jobs.ts
 - apps/api/src/modules/ai/ai.module.ts
 - apps/api/src/modules/ai/usage/usage.service.ts
 - apps/api/src/modules/templates/templates.service.ts
 - apps/api/src/modules/templates/template-components.builder.ts
 - apps/api/src/modules/flows/flows.module.ts
 - apps/api/src/worker-features.module.ts
 - apps/web/src/components/ai/assistant-panel.tsx
 - apps/web/src/lib/ai.ts
 - apps/web/src/app/(dashboard)/layout.tsx
 - apps/web/src/app/(dashboard)/templates/new/page.tsx
 - tools/mock-meta/src/ai.ts
 - tools/mock-meta/src/server.ts
 - apps/api/test/unit/ai/assistant-tools.spec.ts
 - apps/api/test/unit/ai/claude-client.spec.ts
 - apps/api/test/support/claude-stream.ts
 - apps/api/test/integration/ai-assistant.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - apps/web/e2e/ai-us9-assistant.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - assistant tools unit 9/9; Claude client unit 8/8 (with a streamed tool turn); API wiring 3/3 (HTTP app, worker, both)
 - the fake Claude's streamed replies checked with the real SDK tool runner
 - eslint and tsc clean for api, web and mock-meta
 - ai-assistant integration, the US9 contract cases and the ai-us9-assistant e2e test run in CI
---

## Prompt

continue

(Several session restarts; the user wrote "continue" each time, with /model and /effort set.)

## Response snapshot

US9 (AI assistant for the team), T096–T103:

- **Tools (act as the member, permission first):**
  - `draft_template` saves a local template draft (status DRAFT, no Meta id) and never submits it.
  - `draft_flow` checks the graph with FlowGraphSchema and the 003 publish rules before saving an unpublished draft. Problems go back to the model to fix.
  - `draft_campaign` builds a tag and attribute audience and the variable mapping, and leaves the campaign unscheduled.
  - `report_summary` returns the campaign report figures for the campaigns launched in a period.
  - `propose_campaign_send` and `propose_delete` only store a PENDING preview (recipients, estimated cost, items) that expires after 30 minutes.
- **Runner (worker):**
  - Claude Opus 5.5 at effort medium, streamed (`stream: true` with `finalMessage()`), max_tokens 32,000, 8 iterations.
  - A cached system prompt (our own text); the member's role, permissions and the workspace ids follow in the first message. No contact phones are sent.
  - The answer, the drafts, the tokens and the cost are stored. A request is counted as ASSISTANT once answered; a failure is marked AI_UNAVAILABLE and not counted.
- **Request status:** a permission refusal with nothing made is marked REFUSED.
- **Actions:**
  - Confirm is for the asking member only. It checks the 30-minute expiry (ACTION_EXPIRED) and the permission again (403), and claims the action once (ACTION_DECIDED).
  - It runs through LaunchService, ScheduleService, ContactDeletionService or the tag delete, with the member as actor, and is audited `ai.assistant_action_confirmed`. Cancel is also available.
- **Endpoints:** `GET/POST /assistant/requests` (POST answers 202, or 429 LIMIT_REACHED at the monthly limit), `GET /assistant/requests/{id}`, and confirm and cancel.
- **Supporting changes:**
  - TemplatesService.saveDraft. Submitting a template whose name matches a local draft now replaces that draft, and a draft opens in the editor under its own name ("Review template draft").
  - FlowsService moved to the flows domain module so the worker can draft flows.
  - ClaudeClient has a `stream` option. The fake Claude streams when asked and leaves the `<workspace>` block out of rule matching.
- **Web:** an Assistant button in the header (`assistant.use`). Its dialog has a prompt box, request history that polls while a request is answered, draft links, and action previews with Confirm and Cancel. It closes when a draft is opened.

## Outcome

- ✅ Impact: US9 complete (103 of 113 tasks); Polish (T104–T113) remains.
- 🧪 Tests: unit, lint and typecheck pass; streaming verified locally against the fake Claude with the real SDK; integration, contract and e2e wait for CI.
- 📁 Files: listed above. The runner and its job processor are in assistant.runner.ts, not a separate assistant.processor.ts.
- 🔁 Next prompts: CI for US9; then the Polish phase (metrics, retention, redaction, audit coverage, RBAC contract, perf check, journey entries, docs, eval, quickstart run).
- 🧠 Reflection:
  - Running the publish checks inside the tool found that question steps need retry text, so the flow guide given to the model now says so.
  - Reading the duplicate prefill found the `_copy` rename, which would have stopped a reviewed draft from replacing itself.

## Evaluation notes (flywheel)

- Failure modes observed: a test fixture lacked retry text (caught by the real publish rules); a draft-review gap in the template editor (caught by reading the prefill code).
- Graders run and results (PASS/FAIL): unit PASS; lint/tsc PASS; local SDK stream check PASS; CI pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): a per-member rate limit on assistant requests, like the preview's 20 a minute.
