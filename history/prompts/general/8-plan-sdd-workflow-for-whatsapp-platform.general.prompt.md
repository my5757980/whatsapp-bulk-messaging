---
id: 8
title: Plan SDD Workflow For WhatsApp Platform
stage: general
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: none
branch: main
user: Muhammad Yaseen
command: none (free-form prompt)
labels: ["sdd", "workflow", "whatsapp", "bulk-messaging", "constitution"]
links:
  spec: null
  ticket: null
  adr: null
  pr: null
files:
 - history/prompts/general/8-plan-sdd-workflow-for-whatsapp-platform.general.prompt.md
tests:
 - none (no artifacts created; waiting for the user to run SDD commands)
---

## Prompt

ab bat sunooo mujayy apnii companeyy kayy liaa 1oo% exactlyy asaa poora flowww ya poora custom project bnanaa haiii ya whatsapp api walaa bulk message walaaa 1oo% asaa yahii flowww okkk or mayy spec driven development command maruu gaaaa aik aik kar kayy constitution specify plan tasks implemented tum khud constion add kar kiaa hogaa specify kia hoga plan kia hogaa tasks kiaa hoga orr poora implemented

(interrupted, then follow-up message verbatim: "nhaiii rukuu mujayy phalayy confirm karoo mayy aik aik kar kayy command khud chaloo ga phir karnaaa")

Answers to clarifying questions:
- Platform: only for own company (single company, not SaaS)
- Tech stack: Next.js + Node.js
- Market: Global (USD)

## Response snapshot

Confirmed that nothing will be generated until the user runs each SDD command personally. Read the sp.constitution and sp.specify command files and the constitution template (still unfilled) so the inputs match their format. Gave the paste-ready `/sp.constitution` input:
- single-company WhatsApp bulk messaging platform
- official Cloud API only, original UI
- security, reliable queued sending, test-first, observability, simplicity
- stack: Next.js + NestJS, PostgreSQL, Redis/BullMQ; costs tracked in USD

The `/sp.specify` text follows only after the constitution step.

## Outcome

- ✅ Impact: Workflow agreed; the user controls when each SDD step runs.
- 🧪 Tests: none.
- 📁 Files: this PHR only.
- 🔁 Next prompts: /sp.constitution with the provided text, then /sp.specify (text supplied on request).
- 🧠 Reflection: The user wants to trigger each step personally. Prepare inputs, but never run SDD steps ahead of them.

## Evaluation notes (flywheel)

- Failure modes observed: started preparing ahead (reading templates, asking questions) before the user confirmed the workflow; the user interrupted.
- Graders run and results (PASS/FAIL): N/A
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Give only the next command's input text each time, then wait.
