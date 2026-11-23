---
id: 95
title: Tasks Campaign Growth
stage: tasks
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: /sp.tasks
labels: ["tasks", "campaign-growth", "click-tracking", "retries", "drip-campaigns", "test-first"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/005-campaign-growth/tasks.md
 - specs/005-campaign-growth/contracts/growth-api.openapi.yaml
tests:
 - redocly lint of contracts/growth-api.openapi.yaml: valid, 0 errors (warnings of the same kinds as 004)
 - task format check: T001..T067 in order; story labels only in story phases
---

## Prompt

haaaaaa

(The user said yes to "Kya ab ise banana shuru karun?" (shall I start building it now?). /sp.tasks was run with this input:)

005-campaign-growth: test-first task list per user story (US1 clicks, US2 retarget, US3 retries, US4 drips, US5 starting events, US6 drip results), following the plan's delivery order, with setup and foundation first and a polish phase; same task style as 004 (T-numbers, [P] markers, [USn] labels, exact file paths, integration/contract/e2e tests before implementation).

## Response snapshot

- **tasks.md:** 67 tasks, 44 of them marked [P].

  | Group | Tasks | IDs |
  |---|---|---|
  | Setup | 4 | T001–T004 (T004, the contract in `lint:contracts`, was already done) |
  | Foundational | 10 | T005–T014 |
  | US1 clicks | 12 | |
  | US2 retarget | 6 | |
  | US3 retries | 8 | |
  | US4 drips | 9 | |
  | US5 starting events | 5 | |
  | US6 drip results | 5 | |
  | Polish | 8 | T060–T067 |

- **Foundational work:**
  - the migration `20261128000000_campaign_growth`
  - shared pure logic in `packages/shared/src/growth` (links, bots, retries, quiet hours, drips), tests first
  - the 005 audit actions
  - `GrowthDomainModule`, `GrowthApiModule` and the worker processors
- **Test-first in every story:**
  - unit tests for the redirect controller and for retryable errors
  - integration tests `growth-clicks`, `growth-retarget`, `growth-retries`, `growth-drips`, `growth-drip-events` and `growth-drip-results`
  - contract cases in `growth.contract-spec.ts`
  - e2e tests `growth-us1` to `growth-us6`
- **Contract change:** added `GET /tracked-links/config` (`templates.view`), so the template editor can make a Tracked link button with the configured address.
- **Checks against the code:**
  - every existing file the tasks name exists. The global `api` prefix is set in app.setup.ts (not main.ts), so `/l/:code` goes on its exclude list and is marked `@Public()` (corrected during implementation)
  - README must tell the reverse proxy to send `/{code}` to `/l/{code}` when the base address has no `/l` path
- **MVP:** Setup, Foundational and US1 (tracked links and click results).

## Outcome

- ✅ Impact: 005 has an executable task list, so implementation can start with Setup and Foundational.
- 🧪 Tests: planned per story (unit, integration, contract, e2e); the contract lint passes.
- 📁 Files: specs/005-campaign-growth/tasks.md, contracts/growth-api.openapi.yaml.
- 🔁 Next prompts: /sp.implement for 005, starting with Phase 1 and 2, then US1.
- 🧠 Reflection: checking every named file against the repository is worth it; the prefix check itself first looked in the wrong file (main.ts instead of app.setup.ts) and was corrected when implementation began.

## Evaluation notes (flywheel)

- Failure modes observed:
  - the task named main.ts for the api prefix; it lives in app.setup.ts
  - the template editor had no way to learn the tracked-link address (a missing endpoint)
- Graders run and results (PASS/FAIL): path existence check PASS; format and numbering check PASS; redocly PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): run the path existence check during /sp.plan too, so file names in plan.md are checked before tasks.
