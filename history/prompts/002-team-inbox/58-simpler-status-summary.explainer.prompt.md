---
id: 58
title: Simpler Status Summary
stage: explainer
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 002-team-inbox
branch: 002-team-inbox
user: Muhammad Yaseen
command: none
labels: ["status", "summary", "roman-urdu", "plain-language"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/2
files:
 - none
tests:
 - none
---

## Prompt

short mayyy batoo kia bol rahayyyy hooooo

## Response snapshot

Plain two-line Roman Urdu answer without technical terms: the live chat work is finished and all tests pass; the user only needs to merge PR #2 on GitHub; the speed test runs later on the server.

## Outcome

- ✅ Impact: status restated in plain words.
- 🧪 Tests: none run for this reply.
- 📁 Files: this record only.
- 🔁 Next prompts: the user merges PR #2, then feature 003.
- 🧠 Reflection: avoid task IDs, CI and tool names in status replies to this user.

## Evaluation notes (flywheel)

- Failure modes observed: earlier replies used too many technical terms.
- Graders run and results (PASS/FAIL): none
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): two plain lines, no jargon.
