---
id: 21
title: Simple Explanation Of US2 Status
stage: explainer
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: none
labels: ["explainer", "status", "roman-urdu"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - none
tests:
 - none
---

## Prompt

short mayyy batoooo asan lafzooo mayyyy

## Response snapshot

Three short Roman Urdu lines without technical terms:
1. Contacts are done: keep a list of people, put them in groups, and add many at once from an Excel file.
2. When sending, choose which group gets the message; anyone who replies "STOP" stops receiving messages.
3. Tested and working; the next job is message templates, so type "continue".

## Outcome

- ✅ Impact: US2 status explained in plain words.
- 🧪 Tests: none
- 📁 Files: none
- 🔁 Next prompts: "continue" (Phase 5, US3 templates)
- 🧠 Reflection: Even "short" status messages need to avoid terms like CSV, opt-in, audience, or task IDs for this user.

## Evaluation notes (flywheel)

- Failure modes observed: The previous summary still used technical words.
- Graders run and results (PASS/FAIL): N/A
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Write the first status message after each phase in this plain style from the start.
