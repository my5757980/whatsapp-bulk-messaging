---
id: 60
title: Specify Chatbot Flow Builder
stage: spec
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 003-chatbot-flow-builder
branch: 003-chatbot-flow-builder
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "chatbot", "flow-builder", "automation"]
links:
  spec: specs/003-chatbot-flow-builder/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/003-chatbot-flow-builder/spec.md
 - specs/003-chatbot-flow-builder/checklists/requirements.md
tests:
 - none (specification stage)
---

## Prompt

continue

## Response snapshot

Started feature 003 (the next item in the user's roadmap) with /sp.specify. Created branch 003-chatbot-flow-builder (number 3 follows the repo's global numbering) and wrote the spec from a description built from the roadmap and the public AiSensy feature inventory (items 7.1–7.3, 7.5–7.7): 9 prioritised user stories (keyword flow with buttons; questions with validation saved to attributes; hand-over and coexistence with live chat; conditions, tags, attributes, delays, jumps; API step; template-button, pattern and first-message triggers; test numbers and versions; analytics; starter flows), 40 functional requirements, 8 success criteria, edge cases, assumptions, out of scope and dependencies on 001 and 002. No clarification markers; defaults recorded under Assumptions. The quality checklist passed after fixing one conflict (manual flow start in a Taken chat).

## Outcome

- ✅ Impact: 003 spec ready for planning.
- 🧪 Tests: none at this stage.
- 📁 Files: spec.md and checklists/requirements.md.
- 🔁 Next prompts: /sp.plan for 003.
- 🧠 Reflection: the inventory numbered the flow builder 005; the user's later order puts it at 003, which the spec notes.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): spec quality checklist PASS (16/16).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): confirm WhatsApp interactive message limits during planning.
