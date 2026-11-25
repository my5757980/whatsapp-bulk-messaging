---
id: 115
title: Plan Click To WhatsApp Ads
stage: plan
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 007-ads-manager
branch: 007-ads-manager
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "ads", "meta-marketing-api", "leads", "audiences", "referral"]
links:
  spec: specs/007-ads-manager/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/007-ads-manager/plan.md
 - specs/007-ads-manager/research.md
 - specs/007-ads-manager/data-model.md
 - specs/007-ads-manager/contracts/ads-api.openapi.yaml
 - specs/007-ads-manager/contracts/meta-ads-graph.md
 - specs/007-ads-manager/quickstart.md
 - CLAUDE.md
tests:
 - none (plan)
---

## Prompt

continue

(After /model and /effort; /sp.plan for 007 with: Same stack as 001-006 (NestJS api and worker, Prisma/Postgres, BullMQ, Next.js web, shared package, mock-meta for tests). Meta Marketing API through our own thin client on the pinned Graph version, a system user token stored encrypted, sync jobs on a BullMQ queue, referral data from inbound webhooks, leads through the page leadgen webhook plus a catch-up poll, hashed customer lists for audiences, the 004 AI service for ad texts. Keep it as small as the spec allows; reuse the 006 wizard check pattern and the 006 chat link flow-start rules.)

## Response snapshot

- **Research (R1–R14):** checked against Meta's developer documentation (sources listed). The
  decisions:
  - One Graph client and version, with a system user token.
  - The 006-style connection checks.
  - One campaign, one ad set and up to five ads, using ODAX objectives.
  - The CTWA ad set uses `destination_type: WHATSAPP`, with `page_id` and `whatsapp_phone_number` in
    the promoted object.
  - The pre-filled message comes from a WhatsApp welcome message sequence referenced by the
    creative.
  - Status every 5 minutes, hourly insights and the spending cap.
  - Hashed `PHONE_SHA256` audiences with daily diffs.
  - Lead webhooks on the existing Meta route, plus a catch-up job.
  - Website ads use counted links at `/l/a/:code`.
  - The referral is matched before the chat link matcher and the flow router.
  - The free entry point window is shown, not enforced.
  - WhatsApp Status is offered as a placement (Meta documents it).
  - Field names that sources disagree on are marked *(verify)*.
- **Data model:** 10 new tables, a messages column, enum additions, state machines, validation,
  retention and audit actions.
- **Contracts:** `ads-api.openapi.yaml` (about 35 operations, with existing permissions) and
  `meta-ads-graph.md` (Graph calls and mock-meta behaviour).
- **Quickstart:** a row for each of the 8 stories, plus release items.
- **Constitution check:** passes; no new dependency.
- **CLAUDE.md:** Active Technologies and Recent Changes updated for 007.

## Outcome

- ✅ Impact: 007 is planned and ready for /sp.tasks.
- 🧪 Tests: none (plan); the test levels are set in the plan.
- 📁 Files: see the list above.
- 🔁 Next prompts: /sp.tasks, then /sp.implement in batches (US1–US3, US4–US6, US7–US8 with polish).
- 🧠 Reflection: marking the Graph fields that sources disagree on, and pinning them in one contract
  file that mock-meta follows, keeps the plan honest without slowing it down.
