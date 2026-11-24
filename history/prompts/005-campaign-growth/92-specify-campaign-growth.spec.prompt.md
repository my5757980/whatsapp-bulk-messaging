---
id: 92
title: Specify Campaign Growth
stage: spec
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "campaign-growth", "click-tracking", "retargeting", "retries", "drip-campaigns"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/005-campaign-growth/spec.md
 - specs/005-campaign-growth/checklists/requirements.md
tests:
 - none (specification stage); spec quality checklist passes in iteration 1
---

## Prompt

haaaaaa

continue

(The user answered "haaaaaa" (yes) to "should I start the next work: link click tracking, drip messages, integrations?", then wrote "continue" after session restarts. Claude chose the scope, as the user asked it to decide. Integrations become their own later feature. The feature description passed to /sp.specify was:)

Campaign growth: click tracking, retargeting, failed-message retries and drip campaigns (AiSensy inventory items 5.5, 5.7, 5.8 and 5.12; behaviour only, our own design and text, constitution Principle II). (1) Click tracking: links in template URL buttons and in message text can be tracked through our own short redirect links; each campaign shows who clicked, how many times and when, and a "Clicked" view. (2) Retargeting: from a campaign's results, start a new campaign to the contacts who clicked, replied, read, were delivered, failed or did not read, in one step. (3) Failed-message retries: a manager can set a campaign to retry its failed messages automatically, up to 3 times within 24 hours with set delays, only for errors that may pass, and see the scheduled retries. (4) Drip campaigns: a sequence of approved template messages sent to each enrolled contact with waits between steps; contacts enrol on a starting event (a tag added, opt-in, added by import or the public API, a click on a tracked link, or enrolled by hand); a contact leaves when they reply, opt out, are blocked, get a stop tag, or finish; quiet hours and the company time zone are respected; per-step reports (sent, delivered, read, clicked, replied, left). All sending follows the existing consent, number throughput and Meta frequency-cap rules, templates only outside the 24-hour window, with audit and 12-month retention like 001.

## Response snapshot

- Main was green after the 004 merge (ece90d0). Branch `005-campaign-growth` was created from it, numbered 005 to follow 001–004.
- The spec has six user stories:
  - US1 (P1): see who clicked: per-recipient tracked links on the company's own address, previews and robots not counted, a Clicked view.
  - US2 (P1): retarget Clicked, Not clicked, Replied, Not replied, Read, Not read, Delivered or Failed in one step, extending 001's FR-031.
  - US3 (P2): retry failures that may pass in up to 3 rounds within 24 hours, with a scheduled retries view.
  - US4 (P2): build and run drips: up to 10 steps, waits of 10 minutes to 30 days, quiet hours, leaving rules, editing, self-pausing, and entries in the timeline and journey.
  - US5 (P2): automatic enrolment on a tag, an opt-in, a new contact from import or API, or a click.
  - US6 (P3): drip results.
- The spec also has 41 functional requirements, 9 success criteria, edge cases, assumptions, out of scope and dependencies.
- No clarification markers were raised. The user asked Claude to decide, so the defaults are written in the Assumptions section, and Meta's link rules and the retryable failure list are left to planning research.
- The spec quality checklist passed in iteration 1.

## Outcome

- ✅ Impact: 005 is specified and ready for /sp.plan.
- 🧪 Tests: none at this stage.
- 📁 Files: spec.md and checklists/requirements.md.
- 🔁 Next prompts: /sp.plan for 005 (research Meta's link and error rules first), then /sp.tasks and implementation.
- 🧠 Reflection: 001 already retargets by failed, not read, read and delivered, so 005 only adds the click and reply groups; reading the 001 spec first avoided duplicating them.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): spec quality checklist PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): n/a
