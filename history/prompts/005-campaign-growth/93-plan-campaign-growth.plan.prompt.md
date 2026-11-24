---
id: 93
title: Plan Campaign Growth
stage: plan
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "campaign-growth", "click-tracking", "retries", "drip-campaigns", "meta-rules"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/005-campaign-growth/plan.md
 - specs/005-campaign-growth/research.md
 - specs/005-campaign-growth/data-model.md
 - specs/005-campaign-growth/contracts/growth-api.openapi.yaml
 - specs/005-campaign-growth/quickstart.md
 - specs/005-campaign-growth/spec.md
 - package.json
 - CLAUDE.md
tests:
 - redocly lint of contracts/growth-api.openapi.yaml: valid (warnings only, as for 004)
---

## Prompt

continue

(The user's go-ahead ("haaaaaa", then "continue") for the next feature carried on from the spec into planning. /sp.plan was run with this input:)

005-campaign-growth: plan for click tracking with per-recipient redirect links on the company's own HTTPS address, retargeting by clicked/replied groups (extending 001 FR-031), user-configured retry rounds of retryable failures within 24 hours, and drip campaigns (steps with waits, quiet hours, starting events, leaving rules, per-step results), on the existing stack (NestJS, Prisma/Postgres, BullMQ/Redis, Next.js). Research Meta's current rules for URL buttons with a variable part, links and shorteners in templates, the error codes that may pass for retries (including the per-person marketing limit), and link-preview user agents.

## Response snapshot

- **Research (R1–R13), checked on Meta's pages on 2026-11-23:**
  - A URL button takes one variable, at the end of the address, with an example, and a template has at most 2 URL buttons.
  - Retryable failures are the 001 TRANSIENT class. 131049 (per-person marketing limit) must wait at least 24 hours, so it is "held back" for a retarget instead of a retry. 131026 and 131048 are never retried.
  - WhatsApp's preview user agent is `WhatsApp/2.x A|i|W`.
  - Vendor summaries of Meta's guidance say to avoid third-party shorteners and use the business's own domain.
- **Design:**
  - `GET /l/:code` on `PUBLIC_LINK_BASE_URL`, with 10-character random codes, preview and robot detection, and no IP stored.
  - New retarget groups in 001's snapshot at launch.
  - Retry rounds on campaign-dispatch, with a reconciler sweep.
  - Drips run from `next_due_at` in Postgres by a 30-second tick on a new `drips` queue (claimed with SKIP LOCKED). Starting events come through a `drip_events` outbox written in the triggering transaction; leaving events update enrolments in their own transaction.
- **Data model:** 10 new tables, columns on campaigns and messages, extended enums and audit actions.
- **Contract:** `growth-api.openapi.yaml` (dashboard endpoints plus the public `/l/{code}`), added to `lint:contracts`.
- **Quickstart:** a row per story, with the mock-meta failure rules for numbers ending in 1016 and 1049.
- **Spec corrections found in research:**
  - FR-014 holds 131049 back instead of retrying it (Meta's 24-hour rule).
  - FR-011 matches 001's retarget snapshot at launch.
- **Constitution check:** PASS before and after design. No new dependency; one new queue, justified.
- The agent context (CLAUDE.md) is updated, with an ADR suggestion for the links and drip engine.

## Outcome

- ✅ Impact: 005 is planned and ready for /sp.tasks.
- 🧪 Tests: the contract lint passes. Implementation tests are planned per story (unit, integration, contract and e2e).
- 📁 Files: listed above.
- 🔁 Next prompts: /sp.tasks for 005; optionally /sp.adr campaign-growth-links-and-drips.
- 🧠 Reflection: checking Meta's per-user limit page changed the spec. Retrying 131049 inside 24 hours would have broken Meta's rule and harmed delivery.

## Evaluation notes (flywheel)

- Failure modes observed:
  - the spec first listed the per-person limit as retryable (fixed by research)
  - YAML flow maps broke on unquoted commas in descriptions (caught by redocly)
- Graders run and results (PASS/FAIL): redocly PASS; constitution check PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): quote every description that contains a comma in contracts.
