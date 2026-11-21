---
id: 76
title: Implement AI Agent US1 Web Pages
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "web", "editor", "knowledge", "unanswered", "e2e", "us1"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/web/src/lib/ai.ts
 - apps/web/src/app/(dashboard)/layout.tsx
 - apps/web/src/app/(dashboard)/ai-agents/page.tsx
 - apps/web/src/app/(dashboard)/ai-agents/[id]/page.tsx
 - apps/web/src/components/ai/agent-editor.tsx
 - apps/web/src/components/ai/agent-status-badge.tsx
 - apps/web/src/components/ai/instructions-tab.tsx
 - apps/web/src/components/ai/knowledge-tab.tsx
 - apps/web/src/components/ai/unanswered-tab.tsx
 - apps/web/src/components/ai/numbers-panel.tsx
 - apps/web/src/components/ai/use-agent-autosave.ts
 - apps/web/e2e/ai-us1-knowledge.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - apps/web/e2e/ai-us1-knowledge.spec.ts (written; runs in CI against mock-meta's fake model)
 - web eslint and tsc clean (e2e included); web unit tests 3/3 pass
---

## Prompt

continue

## Response snapshot

US1 web work finished (T044–T046) along with the e2e test (T031):

- **List page:** `/ai-agents` shows status, numbers and the last 7 days for each agent, with duplicate and delete (delete is refused while published) and a "New agent" dialog. The "AI agents" link appears in the navigation for `ai.manage`.
- **Editor:** `/ai-agents/[id]`
  - The draft autosaves 1 s after a change by `draftRevision`. A conflict reloads the editor, and a draft the server would refuse is not sent.
  - Rename, Publish and Unpublish. Publish shows the problems list, and each problem opens the tab where it can be fixed.
  - "Answers on" panel for numbers. A number that already belongs to another agent is moved only after a confirm (`replace: true`).
  - Three tabs: Instructions, Knowledge and Unanswered.
- **Instructions tab:** display name, goal, business details, tone with notes, longest reply, guardrails, reply languages and an introduction per language.
- **Knowledge tab:**
  - Written answers, websites (with weekly refresh) and PDF/DOCX upload.
  - Each source shows its status and can be switched on or off, edited (answers), refreshed (websites and files) or deleted.
  - Shows totals and the WHOLE or SEARCH mode. It polls while sources are being read. Knowledge is live, so changes need no publish.
- **Unanswered tab:** most-asked questions first; add an answer (it becomes a written answer) or dismiss; a list of done questions.
- **Query keys:** split into separate branches, so refreshing the list never reloads an open editor.
- **e2e test:** creates the agent in the editor, adds an answer, picks the number and publishes. A mock inbound question gets the fake model's knowledge answer with the introduction, shown as "Automatic · {agent}" in live chat. An unknown question shows under Unanswered.

## Outcome

- ✅ Impact: User Story 1 (the MVP slice) is complete in code: T001–T046, 46 of 113 tasks.
- 🧪 Tests: lint, typecheck and unit tests pass locally. Integration, contract and e2e tests run in CI once a draft PR exists.
- 📁 Files: listed above.
- 🔁 Next prompts: open the 004 draft PR so CI checks the migration and the US1 integration, contract and e2e tests (the GitHub connector timed out this session). Then US2: hand-over, the live chat and consent rules.
- 🧠 Reflection: TanStack query keys match by prefix. With a shared `['ai-agents']` root, every list refresh would have refetched the open editor's detail query.

## Evaluation notes (flywheel)

- Failure modes observed: none new; query-key prefix collision caught in review before it shipped.
- Graders run and results (PASS/FAIL): web eslint PASS, web tsc PASS, web unit PASS; integration/contract/e2e NOT RUN (no CI).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): add a tiny unit test for query-key prefixes when a feature adds nested keys.
