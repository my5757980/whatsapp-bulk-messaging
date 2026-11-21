---
id: 80
title: Implement AI Agent US2 Hand-over
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "hand-over", "live-chat", "consent", "failures", "us2"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/turns/decisions.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/failure-monitor.ts
 - apps/api/src/modules/ai/turns/expiry.processor.ts
 - apps/api/src/modules/ai/turns/ai-router.ts
 - apps/api/src/modules/ai/live-chat/ai-state.controller.ts
 - apps/api/src/modules/ai/claude/prompt.ts
 - apps/api/src/modules/ai/ai.module.ts
 - apps/api/src/worker-features.module.ts
 - apps/api/src/modules/contacts/consent.service.ts
 - apps/api/src/modules/inbox/conversations/conversations.service.ts
 - apps/api/src/modules/inbox/conversations/chat-contact.service.ts
 - apps/api/src/modules/inbox/messages/session-send.service.ts
 - apps/api/src/modules/inbox/messages/template-send.service.ts
 - apps/api/src/modules/inbox/routing/chat-routing.service.ts
 - apps/api/src/modules/flows/live-chat/flow-start.controller.ts
 - packages/shared/src/enums.ts
 - apps/web/src/components/inbox/ai-banner.tsx
 - apps/web/src/components/inbox/chat-view.tsx
 - apps/web/src/components/inbox/chat-item-view.tsx
 - apps/api/test/unit/ai/eligibility.spec.ts
 - apps/api/test/integration/ai-live-chat.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - apps/web/e2e/ai-us2-handover.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - apps/api/test/unit/ai/eligibility.spec.ts (11 new, pass)
 - API unit tests 380/380, shared 146/146, eslint and tsc clean for api, web and shared
 - ai-live-chat integration, the US2 contract case and the ai-us2-handover e2e test run in CI
---

## Prompt

achaaa theek haiii project ka kaam continue karooo

(After a session restart, the user wrote:)

continue

## Response snapshot

US2 (hand-over and the live chat rules) implemented test-first, T047–T056:

- **Decisions (pure, unit-tested):**
  - Eligibility: only Open chats; blocked contacts, opted-out contacts, a closed window and a running flow are refused.
  - Hand-over: the model's request first, then the reply cap, then a second unanswered question in one AI conversation, then "hand over when unsure".
  - The team's note text.
- **Applier:**
  - A hand-over sends one closing reply (`HANDOVER`, counted) and moves the chat to Waiting for agent the way flows do it: a `REQUESTED` event by `AI_AGENT`, the 002 alert after commit, and an `AUTOMATIC` note with the reason and summary. The AI conversation ends `HANDED_OVER`.
  - `optOut: "clear"` records consent with source `AI_AGENT`. It runs in the same transaction, which `ConsentService.setStatus` now accepts, sends nothing, and ends the AI conversation `OPTED_OUT`.
  - When the AI service fails, the fallback message goes out (`FALLBACK`, not counted), the chat is handed over with "AI agent unavailable", and the AI conversation ends `FAILED`.
  - The re-checks now include a running flow.
- **Turn service:**
  - Turns go through the eligibility check, and waiting flags are cleared when no agent answers.
  - The turn context tells the model when the reply cap is reached and when an earlier question went unanswered, so the closing reply is the model's own words.
  - A reply with no words is refused unless it is an opt-out or a flow start.
  - A failure-rate monitor sends `AI_FAILING` to admins when more than 20% of at least 10 attempts fail in 15 minutes, at most once an hour.
- **Hooks (T052):** these actions end the AI conversation:
  - taking the chat, replying, sending a template, or starting a flow (`MEMBER_TOOK`);
  - closing the chat (`CLOSED`);
  - any move to Waiting for agent (`HANDED_OVER`, in `alertRequesting`);
  - blocking (`BLOCKED`);
  - an opt-out keyword (`OPTED_OUT`, in the router).
- **Expiry:** an `ai-expiry` sweep every 15 minutes ends AI conversations idle for 24 hours (`EXPIRED`).
- **Live chat:**
  - `GET /inbox/conversations/:id/ai` with 002 visibility.
  - An "AI agent is answering" banner.
  - A "Used N sources" disclosure under AI replies.
- **Shared enums:** `AI_AGENT` (consent source), and `AI_USAGE` and `AI_FAILING` (notification types).

## Outcome

- ✅ Impact: US1 and US2 are complete in code (56 of 113 tasks), the checkpoint where the agent is safe to switch on for customers.
- 🧪 Tests: unit, lint and typecheck pass locally. The integration test (14 scenarios), the contract case and the e2e test wait for CI on PR #5.
- 📁 Files: listed above.
- 🔁 Next prompts: watch CI for this push; then US3 (preview, test numbers, versions).
- 🧠 Reflection: hand-over reuses the 003 flow path, the same state update, event, note and alert, so live chat treats AI and flow hand-overs alike.

## Evaluation notes (flywheel)

- Failure modes observed: shell escaping broke a multi-edit script again (caught before any write; redone with the Edit tool).
- Graders run and results (PASS/FAIL): unit PASS (api 380, shared 146); eslint/tsc PASS; integration/contract/e2e pending CI.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): for edits whose strings contain backslashes, always use the Edit tool from the start.
