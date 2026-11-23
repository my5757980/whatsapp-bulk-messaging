---
id: 97
title: Implement Growth US2 Retarget US3 Retries
stage: green
date: 2026-11-23
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: 005-campaign-growth
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "campaign-growth", "retarget", "retries", "us2", "us3", "secret-scan"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/6
files:
 - apps/api/src/modules/campaigns/retarget.service.ts
 - apps/api/src/modules/campaigns/audience-snapshot.service.ts
 - apps/api/src/modules/campaigns/campaigns.controller.ts
 - apps/api/src/modules/campaigns/campaign-progress.processor.ts
 - apps/api/src/modules/campaigns/campaign-control.service.ts
 - apps/api/src/modules/campaigns/schedule-reconciler.processor.ts
 - apps/api/src/modules/meta/meta-error-classifier.ts
 - apps/api/src/modules/sending/send-outcome.ts
 - apps/api/src/modules/growth/retries/retry-plan.service.ts
 - apps/api/src/modules/growth/retries/retry-rounds.service.ts
 - apps/api/src/modules/growth/retries/retry-round.processor.ts
 - apps/api/src/modules/growth/retries/retries.controller.ts
 - apps/api/src/modules/growth/growth.module.ts
 - apps/api/src/worker-features.module.ts
 - apps/web/src/components/campaigns/retarget-dialog.tsx
 - apps/web/src/components/campaigns/retry-plan-form.tsx
 - apps/web/src/components/campaigns/retry-rounds-panel.tsx
 - apps/web/src/app/(dashboard)/campaigns/retries/page.tsx
 - apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx
 - apps/web/src/app/(dashboard)/campaigns/[id]/page.tsx
 - apps/web/src/components/campaigns/wizard/review-step.tsx
 - apps/web/src/components/campaigns/wizard/audience-step.tsx
 - apps/web/e2e/growth-helpers.ts
 - apps/web/e2e/us5-reports.spec.ts
 - .gitleaks.toml
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml
tests:
 - apps/api/test/integration/growth-retarget.int-spec.ts (passed in CI)
 - apps/api/test/integration/growth-retries.int-spec.ts (CI pending)
 - apps/api/test/contract/growth.contract-spec.ts US2 and US3 cases
 - apps/api/test/unit/growth/retryable.spec.ts (4 tests, pass locally; api unit 428/428)
 - apps/web/e2e/growth-us1-clicks.spec.ts (passed in CI)
 - apps/web/e2e/growth-us2-retarget.spec.ts and growth-us3-retries.spec.ts (CI pending)
---

## Prompt

continue

(The user said "continue" twice during implementation, after model and effort changes. Work went on with /sp.implement for 005: US2 and US3, test-first.)

## Response snapshot

- **US1 is verified in CI:** build-test (integration and contract) and the e2e passed.
  - The first e2e run failed because the template editor defaults to Marketing; the test now picks the Marketing template it creates.
- **Secret scan:**
  - The finding was gitleaks' generic-api-key rule on the test helper line `'growth-api.openapi.yaml': '005-campaign-growth'`. "campaign" and "growth" are not stopwords, unlike "builder" and "agent" in the 003 and 004 lines.
  - The match was confirmed by reading gitleaks' published rules. Running the binary locally was not allowed.
  - The fix is a narrow `.gitleaks.toml` allowlist for that exact line, like the existing web-push fixture entry. The scan now passes.
- **US2 (retarget groups):**
  - Groups are SQL conditions shared by `GET /campaigns/{id}/retarget-groups` and the launch snapshot.
    - Clicked: has a click.
    - Not clicked: delivered with no click.
    - Replied: an INBOUND chat item on the campaign's number within 72 hours of delivery.
    - Not replied.
    - Held back: 131049.
  - Drafts copy the source's tracked links. A campaign whose messages were purged gives 409.
  - The report page gets a dialog with group sizes; empty groups are disabled. The 001 e2e now uses the dialog.
  - The 001 dashboard contract lists the new groups, which fixes the failing 001 contract test.
- **US3 (retry rounds):**
  - `retryClassOf` sorts failures:
    - Retried: the TRANSIENT codes, or no code except an unknown outcome.
    - Held back: 131049.
    - Never retried: everything else.
  - Plans: up to 3 rounds and 24 hours, audited, editable only before start.
  - Scheduling: `holdsCompletion` in the progress worker finishes running rounds, schedules the next one as a `campaign-retry-round` job on the `maintenance` queue, and keeps the campaign RUNNING.
  - Running a round: FAILED messages that may pass go back to PENDING with `retry_round`, plus REQUEUED events, and then to the 001 dispatcher. The send worker checks consent again.
  - Rounds:
    - pause holds a round
    - cancelling the campaign cancels its rounds
    - a round is skipped past 24 hours, or when the template or number cannot send
    - a sweep in the schedule reconciler starts rounds whose job was lost
    - members can cancel one round or all of them (audited)
    - counts are live: recipients for scheduled rounds, recovered for all rounds
  - Web:
    - the retry form in the review step, saved on change
    - the retries panel with cancel and the held-back count
    - the `/campaigns/retries` list
- **Docs:** the queue is now named `maintenance` in research, plan, tasks and CLAUDE.md.

## Outcome

- ✅ Impact: US1 is done and verified. US2 and US3 are built; their CI runs are pending.
- 🧪 Tests:
  - CI build-test passed for US1, and the US2 integration tests passed.
  - Locally: api unit 428/428, web journey 4/4, all type-checks and lint clean.
- 📁 Files: listed above.
- 🔁 Next prompts: confirm CI for US2 and US3, then US4 drips (the tick, enrolments, leaving rules and the editor).
- 🧠 Reflection: a feature that extends an older API also has to extend the older contract, because the old contract tests read the same database.

## Evaluation notes (flywheel)

- Failure modes observed:
  - the e2e chose the wrong template category
  - the secret scan matched a folder name
  - the 001 contract enum missed the new retarget groups
- Graders run and results (PASS/FAIL):
  - CI US1: PASS
  - CI US2 build-test: FAIL (001 contract enum), fixed in c4e1807
  - secret scan: PASS after the allowlist
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): when an enum grows, search every contract file for the old enum values.
