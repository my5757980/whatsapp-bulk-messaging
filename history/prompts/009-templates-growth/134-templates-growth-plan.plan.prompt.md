---
id: 134
title: Templates Growth Plan
stage: plan
date: 2026-11-27
surface: agent
model: claude-opus-5-5
feature: 009-templates-growth
branch: 009-templates-growth
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "templates", "otp", "carousel", "ttl", "reports", "website-widget"]
links:
  spec: specs/009-templates-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/009-templates-growth/plan.md
 - specs/009-templates-growth/research.md
 - specs/009-templates-growth/data-model.md
 - specs/009-templates-growth/quickstart.md
 - specs/009-templates-growth/contracts/templates-growth-api.openapi.yaml
 - specs/009-templates-growth/contracts/public-otp-v1.openapi.yaml
 - specs/009-templates-growth/contracts/meta-templates.md
 - specs/009-templates-growth/contracts/website-button.md
 - specs/009-templates-growth/spec.md (corrections from Meta's docs)
 - CLAUDE.md (agent context)
tests:
 - redocly lint of the two new contracts (valid)
---

## Prompt

continue

(After the session restart: commit the 009 spec, then /sp.plan with: "Plan 009 (templates and campaign growth) on the 001–008 stack with no new dependency if possible: authentication, carousel and limited-time offer templates and template time-to-live per Meta's current Cloud API docs (verify each limit with context7 or Meta's pages), a public API route for one-time codes with its own key scope, a priority send path ahead of campaigns, code masking everywhere, media by URL with a launch check, the "send to every row" upload option, replied counts from the 005 definition, overview, team member and consent reports with short-lived CSV files, a sample template library as versioned JSON in the repo, help content (guidelines and error meanings) as data, and a website chat button served by the api as a small script plus a public config endpoint, going through 006 chat links for counts. Test-first, mock-meta routes for each new template type.")

## Response snapshot

- Ran the NUL scan (0 problems) and committed the spec (bb70c4a).
- Read Meta's pages (2026-11-27). Findings changed the spec:
  - carousels are marketing only, and their card media goes by Meta media id
  - Meta's time-to-live covers codes (30–900 s) and utility templates (30–43200 s), while marketing TTL exists only in the Marketing Messages API
  - there is no error code for dropped messages
  - offers have no footer and take a 16-character heading and a 15-character code
- Wrote research R1–R18, the data model (3 new tables, extended templates, campaigns, messages and chat links, a final EXPIRED status), 4 contracts (dashboard, public OTP, Meta calls, website button), the quickstart and the plan. No new dependency, one new permission (reports.view) and one key scope (otp.send).
- Updated CLAUDE.md.

## Outcome

- ✅ Impact: 009 is planned and ready for /sp.tasks.
- 🧪 Tests: contracts lint clean.
- 📁 Files: see above.
- 🔁 Next prompts: /sp.tasks; an ADR for one-time code delivery if the user wants one.
- 🧠 Reflection: Meta's current docs differed from what the spec assumed (carousel category, marketing TTL); checking them before planning saved rework.

## Evaluation notes (flywheel)

- Failure modes observed: redocly struct errors from unquoted descriptions with commas (fixed, as in 008).
- Graders run and results (PASS/FAIL): redocly PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
