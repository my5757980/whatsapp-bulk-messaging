---
id: 82
title: Implement AI Agent US4 Rich Replies
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "buttons", "lists", "media", "attributes", "us4"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/turns/reply-message.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/inbox/journey/attribute-writer.ts
 - apps/api/src/modules/flows/engine/session.service.ts
 - apps/web/src/components/ai/skills-tab.tsx
 - apps/web/src/components/ai/agent-editor.tsx
 - apps/web/src/components/inbox/journey-list.tsx
 - apps/api/test/unit/ai/reply-message.spec.ts
 - apps/api/test/integration/ai-replies-memory.int-spec.ts
 - apps/web/e2e/ai-us4-rich-replies.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - apps/api/test/unit/ai/reply-message.spec.ts (6 new, pass); API unit 391/391; eslint and tsc clean for api and web
 - ai-replies-memory integration and the ai-us4-rich-replies e2e test run in CI
---

## Prompt

continue

## Response snapshot

US4 (rich replies and memory), T064–T069:

- **Reply builder (pure, unit-tested):**
  - A shared library file goes out with the message as its caption (1,024-character limit). Audio cannot carry a caption, so its text goes first as a separate message.
  - Otherwise up to 3 reply buttons (`BUTTONS`), otherwise a list of up to 10 options (`LIST`), otherwise text. Switched-off skills and unsendable files fall back to text.
  - Option ids are `ai:<aiConversationId>:<n>`. A tap comes back as an ordinary customer message, and the agent reads the title.
- **Applier:**
  - Writes every item of a reply in order. The reply record points at the main item, and sends are spaced 1.5 s apart.
  - `remember` values go through the new shared attribute writer: only defined attributes, type checks, nothing that looks like a card, bank or ID number, and an `ATTRIBUTE_CHANGED` journey entry with actor `AI_AGENT` and the agent's name. The contact update is published.
- **Attribute writer:** moved out of the 003 flow engine into `inbox/journey/attribute-writer.ts`. Flows keep using it with actor `FLOW`.
- **Skills tab:**
  - Switches for buttons and lists.
  - Files from the media library, each with "when to send it".
  - Attributes it may fill, each with "what it holds".
  - Problems in skills now open this tab.
- **Journey list:** the actor type includes `AI_AGENT`.
- **Tests:**
  - Integration test: file with caption, buttons and list payloads, a tap reaching the agent, only allowed attributes with valid types saved with a journey entry, and a card number masked in the request and never saved.
  - e2e: the Skills tab set-up, the file arriving as a document with its caption, and the city on the profile with a journey entry by the agent.

## Outcome

- ✅ Impact: US4 complete (69 of 113 tasks).
- 🧪 Tests: unit/lint/typecheck pass locally; integration and e2e wait for CI.
- 📁 Files: listed above.
- 🔁 Next prompts: CI for US3 web and US4; then US5 (API skills that look up live data).
- 🧠 Reflection: moving the attribute writer kept one rule set for every automation that edits contacts, as the plan asked.

## Evaluation notes (flywheel)

- Failure modes observed: a readonly tuple type from `as const` (caught by tsc).
- Graders run and results (PASS/FAIL): unit PASS 391; lint/tsc PASS; CI pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): none.
