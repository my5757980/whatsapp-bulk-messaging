---
id: 133
title: Templates Growth Spec
stage: spec
date: 2026-11-27
surface: agent
model: claude-opus-5-5
feature: 009-templates-growth
branch: 009-templates-growth
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "templates", "otp", "carousel", "reports", "website-widget"]
links:
  spec: specs/009-templates-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/009-templates-growth/spec.md
 - specs/009-templates-growth/checklists/requirements.md
tests:
 - none (specification stage)
---

## Prompt

haaaaaa

(The user's yes to "start the next feature, templates and campaign growth?"; /sp.specify ran with:
"Templates and campaign growth (feature 009), following the AiSensy inventory row "Templates and campaign growth" (items 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9 and 4.11; 5.3, 5.6, 5.13 and 5.14; 12.1 and 12.2). Scope: (1) More template types: authentication (OTP) templates with a copy-code or one-tap button and a way for company systems to send codes through the API; carousel templates (up to 10 cards, each with an image or video, a card text and up to 2 buttons) with the card media chosen when sending; limited-time offer templates with an expiry countdown and an offer code; a time-to-live per template so delivery attempts stop after a window; media from a URL for campaigns and the API. (2) A library of our own original sample templates by industry and purpose that can be copied into a draft. (3) Help where it is needed: template guidelines, the meaning of each broadcast error, and Meta's limit on marketing messages per person (frequency capping) explained where it applies. (4) Campaigns: an option to message duplicate numbers in an uploaded CSV; replied counts and a reply rate in campaign results; downloadable reports for a campaign, for each team member, an overview across campaigns, and opt-ins and opt-outs. (5) A website chat button: number, colour, button text, position, margins, corner radius, pre-filled message, brand name, image and greeting, settings per page address, and a generated snippet to paste on the company website; plus a simple WhatsApp link and QR generator, reusing the 006 chat links where they fit. Reuse 001-008 patterns: test-first, mock-meta routes, audit entries, roles and retention. Public information only; our own design and wording.")

## Response snapshot

- Created branch 009-templates-growth with the SpecKit script and wrote the spec: 8 user stories (P1 one-time codes, P1 carousel, P2 limited-time offers, P2 time-to-live and media by address, P2 replies, duplicates and reports, P3 samples, P3 help, P3 website chat button and link/QR generator), 52 requirements, 11 success criteria, assumptions, out of scope and dependencies.
- The quality checklist passes; no clarification markers (defaults documented).

## Outcome

- ✅ Impact: 009 is specified and ready for /sp.clarify or /sp.plan.
- 🧪 Tests: none at this stage.
- 📁 Files: spec.md, checklists/requirements.md.
- 🔁 Next prompts: /sp.plan (or /sp.clarify first).
- 🧠 Reflection: the usage limit was reached right after writing the spec; nothing is committed yet.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): spec checklist PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
