---
id: 100
title: Shorter Status Reply
stage: explainer
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: none
labels: ["communication", "short-replies", "roman-urdu"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/6
files:
 - C:/Users/ASFAR/.claude/projects/E--New-folder-whatsapp-project/memory/short-answers-roman-urdu.md
tests:
 - none
---

## Prompt

short mayyy batooo

## Response snapshot

The status was repeated in one short Roman Urdu line, without the reason: the GitHub check stopped, should it be checked again? The memory note on short replies now says to use one line when possible and to leave out reasons unless asked.

## Outcome

- ✅ Impact: the reply style was tightened again: one line, no reasons.
- 🧪 Tests: none.
- 📁 Files: the memory note on short Roman Urdu replies.
- 🔁 Next prompts: wait for the user's yes before checking the GitHub results again.
- 🧠 Reflection: even two lines with a reason were too long. A status should be just the fact plus the question.

## Evaluation notes (flywheel)

- Failure modes observed: the reply was too long, because it explained the cause.
- Graders run and results (PASS/FAIL): null
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): give status replies as one line: the fact and a yes/no question.
