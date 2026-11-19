---
id: 10
title: Specify WhatsApp Bulk Messaging Core
stage: spec
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "whatsapp", "bulk-messaging", "campaigns", "contacts", "templates", "api"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/001-whatsapp-bulk-messaging/spec.md
 - specs/001-whatsapp-bulk-messaging/checklists/requirements.md
 - history/prompts/001-whatsapp-bulk-messaging/10-specify-whatsapp-bulk-messaging-core.spec.prompt.md
tests:
 - Spec quality checklist - 16/16 items pass (iteration 1 fixed "idempotency key" wording)
 - Scan - 0 NEEDS CLARIFICATION markers, 0 template leftovers, 0 trailing-whitespace lines
---

## Prompt

/sp.specify

(no arguments given; per the command's rule "Assume you always have it available in this conversation", used the feature description provided in the previous turn (PHR 9):)

WhatsApp bulk messaging core for our company. Team members log in with roles (admin, manager, agent). Admin connects our WhatsApp Business number(s) using Meta Cloud API credentials and sees each number's quality rating and messaging limit. Users manage contacts: import from CSV, add manually, tags, custom attributes, opt-in source and date, and automatic opt-out when a contact replies STOP. Users create WhatsApp template messages (text, media, buttons, variables), submit them to Meta and see the approval status synced. Users create bulk broadcast campaigns: choose an approved template, pick the audience by tags/attributes or upload a CSV, map template variables to contact fields with fallback values, then send now or schedule for later. Sending is throttled, can be paused and resumed, and failed messages retry automatically. Each recipient shows a status: queued, sent, delivered, read, or failed with reason. The campaign report shows counts, delivery and read rates, and estimated cost in USD; users can retarget the failed or unread recipients of a campaign with one click. Our other systems can send a template message through a REST API using an API key. Out of scope for now: shared inbox/live chat, chatbot flow builder, AI agent, ads, payments.

## Response snapshot

Created branch `001-whatsapp-bulk-messaging` (no remote; no prior specs, so number 001) via create-new-feature.ps1. Wrote spec.md with 7 prioritized, independently testable user stories:
- P1: send a broadcast to an uploaded list
- P2: contacts, tags, attributes and consent with STOP/START keywords
- P2: create and submit templates
- P3: schedule, pause, resume, cancel and retries
- P3: reports, USD cost estimate and one-click retargeting
- P3: team roles, masking and audit, with a role-permission table
- P4: template-send API with keys, idempotency and rate limit

The spec also contains 13 edge cases, 38 functional requirements (FR-001–FR-038), 10 measurable success criteria, key entities, assumptions, out-of-scope items and dependencies. It has no clarification markers; defaults are documented instead. The quality checklist passed after one wording fix.

## Outcome

- ✅ Impact: The feature spec is ready for /sp.plan.
- 🧪 Tests: checklist 16/16 pass; placeholder and whitespace scan clean.
- 📁 Files: spec.md, checklists/requirements.md.
- 🔁 Next prompts: /sp.plan with the stack from constitution v1.0.0 (text provided to the user); optionally /sp.clarify first.
- 🧠 Reflection: Made consent rules explicit (marketing only to opted-in contacts; confirmation required for uploaded lists) to satisfy constitution Principle I.

## Evaluation notes (flywheel)

- Failure modes observed: the user ran the command without arguments again; the description was taken from the conversation as the command allows.
- Graders run and results (PASS/FAIL): spec quality checklist PASS (16/16).
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): In /sp.plan, verify the Constitution Check gates map to FR-012–FR-025.
