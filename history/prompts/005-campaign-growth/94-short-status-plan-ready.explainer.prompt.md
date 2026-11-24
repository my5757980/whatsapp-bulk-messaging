---
id: 94
title: Short Status Plan Ready
stage: explainer
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: none
labels: ["explainer", "status", "short-answer"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - history/prompts/005-campaign-growth/94-short-status-plan-ready.explainer.prompt.md
tests:
 - none
---

## Prompt

shrt mayy batoooo

## Response snapshot

Two lines in Roman Urdu: the plan for the next feature is ready; shall I start building it?

## Outcome

- ✅ Impact: the user has the status in two lines.
- 🧪 Tests: none.
- 📁 Files: this PHR only.
- 🔁 Next prompts: the user's go-ahead → /sp.tasks for 005, then implementation.
- 🧠 Reflection: three lines with a technical aside (ADR, Meta rule) were still too long; give one fact and one question.

## Evaluation notes (flywheel)

- Failure modes observed: the reply was too long and too technical for this user, again.
- Graders run and results (PASS/FAIL): n/a
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): at milestones, reply with at most 2 lines: the result and one yes/no question.
