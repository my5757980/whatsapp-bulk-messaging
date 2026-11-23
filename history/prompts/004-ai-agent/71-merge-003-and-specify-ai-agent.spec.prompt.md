---
id: 71
title: Merge 003 and Specify AI Agent
stage: spec
date: 2026-11-20
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.specify
labels: ["merge", "spec", "ai-agent", "knowledge", "hand-over", "usage-limit", "assistant", "meta-policy"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/4
files:
 - specs/004-ai-agent/spec.md
 - specs/004-ai-agent/checklists/requirements.md
 - history/prompts/004-ai-agent/71-merge-003-and-specify-ai-agent.spec.prompt.md
tests:
 - CI on main after the merge (a74d6b1): build-test, e2e-smoke, secret-scan and docker-images green
 - Spec quality checklist: all items pass after run 2
---

## Prompt

haaaa continue karooo

## Response snapshot

The user said yes to merging PR #4 and starting the AI agent.

- **Merge:** 003 was merged into main with git (merge commit a74d6b1, "Merge pull request #4 from my5757980/003-chatbot-flow-builder"), as PR #2 was. GitHub marked PR #4 merged, and CI on main passed all four jobs.
- **Meta rules read first:** the Meta Terms for WhatsApp Business Platform (§4.1, §4.7) and the WhatsApp Business Messaging Policy (§1–§3), both last updated 2026-09-23. They allow an AI agent for the company's own support and sales, as long as AI is not the main product. WhatsApp data must not train AI models. Automation needs a prompt, clear and direct path to a person. Businesses must not ask for card, bank or ID numbers.
- **Spec 004-ai-agent:** branch 004-ai-agent, with nine stories:
  - P1: answer from knowledge with guardrails; hand over to people and keep the live chat and consent rules.
  - P2: preview chat, test numbers and versions; buttons, lists, files and memory in allowed attributes; API skills with the 003 safety rules; working with flows (triggers first, a Hand to AI agent step, a Start a flow skill); usage with a monthly limit, alerts and estimated USD cost.
  - P3: starter agents; an AI assistant for the team that only drafts and asks for confirmation on a preview.
  - The spec has 52 requirements, 10 success criteria, edge cases, assumptions and out-of-scope items.
- **One clarification:** where the AI runs. The user chose an external AI service under no-training terms, over a model on the company's own server. Phone numbers are never sent to it.

## Outcome

- ✅ Impact: 003 is on main with green CI; the 004 spec is ready for `/sp.plan`.
- 🧪 Tests: the spec quality checklist passes; CI on main is green.
- 📁 Files: listed above.
- 🔁 Next prompts: `/sp.plan` for 004 (choose the AI service and model, knowledge storage and search, and how the agent's replies plug into the 002/003 message handling).
- 🧠 Reflection: Meta's terms changed the scope: the agent must stay on the company's business, and conversation data must never train models. Both are now requirements, not afterthoughts.

## Evaluation notes (flywheel)

- Failure modes observed: a clarification marker wrapped across two lines was missed by a line-based search; markers are now kept on one line.
- Graders run and results (PASS/FAIL): spec quality checklist PASS (run 2); CI on main PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): read the platform's current policy pages before specifying any feature that automates customer messages.
