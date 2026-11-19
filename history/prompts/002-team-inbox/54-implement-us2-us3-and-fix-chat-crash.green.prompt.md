---
id: 54
title: Implement US2 US3 And Fix Chat Crash
stage: green
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 002-team-inbox
branch: 002-team-inbox
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "live-chat", "us2", "us3", "e2e", "bugfix"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/2
files:
 - apps/api/src/modules/sending/template-send-rules.ts, send-jobs.ts, send.processor.ts
 - apps/api/src/modules/public-api/public-api.service.ts
 - apps/api/src/modules/inbox/messages/template-send.service.ts
 - apps/api/src/modules/inbox/routing/window-close.processor.ts, auto-resolve.processor.ts, chat-routing.service.ts, agent-rules.service.ts
 - apps/api/src/modules/inbox/settings/live-chat-settings.service.ts, live-chat-settings.controller.ts
 - apps/api/src/modules/inbox/conversations/conversations.service.ts, conversations.controller.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
 - apps/api/src/modules/numbers/numbers.service.ts, users/users.controller.ts, notifications/notifications.service.ts, templates/templates-sync.service.ts
 - apps/api/scripts/inbox-age.ts
 - apps/web/src/components/inbox/* (template sender, Message on WhatsApp, transfer, agent rules, filters, chat view fixes)
 - apps/web/src/app/(dashboard)/settings/live-chat/page.tsx, settings/team/page.tsx, contacts/[id]/page.tsx
 - apps/web/e2e/diagnostics.ts, inbox-us1/us2/us3 specs
 - specs/002-team-inbox/contracts/inbox-api.openapi.yaml, specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml, tasks.md
tests:
 - apps/api/test/integration/inbox-window-history.int-spec.ts (CI pass)
 - apps/api/test/integration/inbox-routing.int-spec.ts (CI pass)
 - apps/api/test/contract/inbox.contract-spec.ts US2/US3 (CI pass)
 - apps/web/e2e/inbox-us1/us2/us3 (CI pending after the crash fix)
 - unit: 221 pass locally
---

## Prompt

continue

## Response snapshot

**US2 backend** — verified in CI:
- Shared template send rules, now also used by the public API.
- Templates from a chat: `messages` origin INBOX plus a timeline reference, with consent and parameter checks, at priority 1.
- Open or create a chat.
- Window-close events.
- Send workers start right after a number connects or a chat message is queued.

**US2 UI:** template dialog, Message on WhatsApp, `GET /inbox/numbers`, and templates filtered by `numberId`.

**US3 backend** — verified in CI:
- Live chat settings.
- Keywords move a chat to Waiting for agent and alert the team.
- Transfer, with TARGET_CANNOT_SEE.
- Auto-resolve job.
- Agent rules.
- Deactivating a member releases their chats.

**US3 UI:** transfer dialog, list filters, Settings > Live chat, agent rules editor and `GET /inbox/members`. Also added the `inbox:age` dev helper.

**Bug found with new e2e diagnostics:** the scroll effect returned `scrollIntoView()`'s Promise, and the page crashed on the next message with "destroy is not a function". Fixed. Two related fixes:
- A failed detail refetch no longer hides the chat.
- The "Send template" button no longer submits the reply form.

## Outcome

- ✅ Impact: 48 of 104 tasks are done, with US1–US3 backends verified in CI. The UI e2e checks for US1–US3 are awaiting a run with the crash fix.
- 🧪 Tests: CI build-test green for the US2 and US3 commits. The e2e runs failed before the crash fix; the diagnostics pinpointed the cause.
- 📁 Files: listed above
- 🔁 Next prompts: "continue" → confirm e2e, then US4 (saved replies and media)
- 🧠 Reflection:
  - Adding browser error and network capture to e2e failures turned a vague "element not found" into the exact root cause.
  - Effects should always use a block body.

## Evaluation notes (flywheel)

- Failure modes observed:
  - A shell heredoc with nested quotes failed again; using patch script files works.
  - CI e2e once failed before running tests (no report).
- Graders run and results (PASS/FAIL): CI build-test PASS (9eac63f, 3c7439f, 8054908); e2e FAIL before the fix
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): N/A
