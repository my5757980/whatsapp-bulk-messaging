---
id: 103
title: Release Checklist While Waiting
stage: misc
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: /sp.implement
labels: ["release-checklist", "t067", "tasks", "memory"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/6
files:
 - specs/005-campaign-growth/checklists/release.md
 - specs/005-campaign-growth/tasks.md
 - history/prompts/005-campaign-growth/98-implement-growth-us4-drips-us5-starting-events.green.prompt.md
 - history/prompts/005-campaign-growth/99-implement-growth-us6-results-and-polish.green.prompt.md
 - history/prompts/005-campaign-growth/100-shorter-status-reply.explainer.prompt.md
tests:
 - local unit: api 444/444, shared 200/200, web 8/8
 - CI history read for every story push (df213aa, ac991f8, 12ec7d6, def6bf2, c4e1807, 7731922, 7b001fb, 2087234, 2c3356e)
---

## Prompt

to jab taak agayy continue karoo naaa kaam

## Response snapshot

While the browser tests ran, the remaining work went on:
- **Release checklist (T067):** written from real results.
  - Automated gates: unit counts, 69 integration files, the RBAC check over five contracts (31 growth operations), audit coverage, redaction, retention, metrics with 10 alert rules, the dependency audit, secret scan and Docker.
  - The CI history per story, read from GitHub.
  - Each quickstart row mapped to its tests.
  - Ten gaps found and fixed.
  - The before-release items: the public link address, Meta approval of a tracked template, the reply window and limits, the SC-005 run on staging, migrations, the drips tick, the Prometheus reload and sign-off.
  - The e2e row stays PENDING until a10eabe finishes.
- **Tasks:** T041–T056, T058 and T060–T066 are marked done (64 of 67). T057, T059 and T067 wait for the e2e result.
- **Memory:** the roadmap note now says 005 is built on PR #6 and its merge waits for the user's yes.
- **Commit:** everything is committed locally (8b22aa3), to be pushed with the final e2e update.

## Outcome

- ✅ Impact: 005 is complete apart from the last browser test run and the release items that need people.
- 🧪 Tests: listed above.
- 📁 Files: listed above.
- 🔁 Next prompts: when e2e passes, mark T057, T059 and T067, update the checklist, push, then ask before merging to main.
- 🧠 Reflection: reading each story's check results from GitHub keeps the checklist's CI table factual.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): CI for polish build-test PASS; e2e pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
