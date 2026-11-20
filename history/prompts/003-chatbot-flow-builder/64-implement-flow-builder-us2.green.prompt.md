---
id: 64
title: Implement Flow Builder US2
stage: green
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 003-chatbot-flow-builder
branch: 003-chatbot-flow-builder
user: Muhammad Yaseen
command: /sp.implement (continue)
labels: ["implement", "chatbot", "flow-builder", "questions", "us2"]
links:
  spec: specs/003-chatbot-flow-builder/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/4
files:
 - packages/shared/src/flows/answers.ts
 - packages/shared/src/flows/answers.test.ts
 - packages/shared/src/flows/validate.ts
 - packages/shared/src/flows/validate.test.ts
 - apps/api/src/modules/flows/engine/run.ts
 - apps/api/src/modules/flows/engine/session.service.ts
 - apps/api/src/modules/flows/definitions/publish.service.ts
 - apps/api/src/modules/flows/steps/flow-jobs.ts
 - apps/api/src/modules/flows/steps/timer.processor.ts
 - apps/api/src/modules/flows/steps/expiry.processor.ts
 - apps/api/src/worker-features.module.ts
 - apps/api/test/unit/flows/run-questions.spec.ts
 - apps/api/test/integration/flows-questions.int-spec.ts
 - apps/web/src/components/flows/steps/question-form.tsx
 - apps/web/src/components/flows/steps/list-form.tsx
 - apps/web/src/components/flows/steps/attribute-select.tsx
 - apps/web/src/components/flows/steps/fallbacks-editor.tsx
 - apps/web/src/lib/flows.ts
 - apps/web/e2e/flows-us1-keyword-buttons.spec.ts
 - apps/web/e2e/flows-us2-questions.spec.ts
 - specs/003-chatbot-flow-builder/tasks.md
tests:
 - packages/shared flow tests (38 passing, 16 new answer tests and the duplicate answer name check)
 - apps/api unit tests (32 files, 291 passing, 13 new question and list engine tests)
 - eslint and tsc clean for api and web
 - apps/api/test/integration/flows-questions.int-spec.ts (runs in CI)
 - apps/web/e2e/flows-us2-questions.spec.ts (runs in CI)
 - US1 CI fully green after the e2e locator fix (c78db58)
---

## Prompt

continue

## Response snapshot

The US1 e2e failed in CI because the locator "Add button" also matched the "Add Buttons step" palette button. The fix made the button names exact, and CI then went fully green, so T015–T027 were marked done. Then US2 was built test-first:
- Shared answer checks: text, number, email, phone through the 001 normaliser passed in, dates in day-first and written forms with today and tomorrow bounds.
- Engine: question and list steps (retries with a prompt and a fresh timeout, then the invalid branch; photos count as wrong answers; list rows with their own or a shared next step; timeouts).
- Session service: answers saved to contact attributes with the 001 type rules, journey entries by the flow, flow-timer jobs and a 24-hour expiry sweep.
- Publish checks: duplicate answer names, unknown attributes and attribute type mismatches.
- Editor: question and list forms, an attribute picker and a fallbacks editor.
Pushed 1ea2e7c to PR #4.

## Outcome

- ✅ Impact: US2 (collect answers and save them to contacts) is implemented; CI is running.
- 🧪 Tests: shared and API unit tests pass locally; the integration and e2e tests run in CI.
- 📁 Files: listed above.
- 🔁 Next prompts: confirm CI for US2, mark T028–T036, then US3 (hand-over and live chat coexistence).
- 🧠 Reflection: the phone normaliser is passed into the shared answer checks instead of adding libphonenumber to the shared package, so the web bundle and shared stay dependency-free.

## Evaluation notes (flywheel)

- Failure modes observed: a non-exact Playwright role locator matched two buttons; a long heredoc patch broke in bash, so the patch scripts were written with the Write tool instead.
- Graders run and results (PASS/FAIL): CI for c78db58 PASS (all 4 jobs); local eslint, tsc and unit tests PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): use exact names for every role locator in new e2e specs.
