---
id: 113
title: Fix Retry Rounds Late Failures
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 005-campaign-growth
branch: fix-005-retry-late-failures
user: Muhammad Yaseen
command: fix the flaky retry rounds e2e
labels: ["bugfix", "retries", "campaigns", "race", "ci"]
links:
  spec: specs/005-campaign-growth/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/modules/growth/retries/retry-rounds.service.ts
 - apps/api/test/integration/growth-retries.int-spec.ts
 - specs/005-campaign-growth/research.md
tests:
 - growth-retries.int-spec.ts: a campaign waits for late failure statuses, then schedules round 1; a settled campaign with nothing to retry completes
 - api unit tests 488/488 (local)
---

## Prompt

haaaaaa

(The answer to "Kya main iska fix nayi branch par bana kar PR khol doon?" after the e2e run on main failed in growth-us3-retries.)

## Response snapshot

- **Cause:** the campaign progress check (every 5 seconds) treats a sent message as final. Mock-meta,
  like Meta, reports some failures by status webhook a moment after the send. When the check ran in
  that moment, it found nothing to retry and completed the campaign, so no retry round was ever
  made, and the e2e waited 60 seconds for round 1 in vain.
- **Fix:** when nothing may be retried yet, the campaign keeps waiting until a minute after its last
  send (`RETRY_SETTLE_MS`). A round is still scheduled at once when a failure that may pass is in,
  and campaigns without retries are unchanged. Research R5 says so.
- **Test:** a new integration case: a campaign whose message was just sent stays running; after the
  failure arrives, round 1 is scheduled; a campaign sent over a minute ago with nothing to retry
  completes.

## Outcome

- ✅ Impact: retry rounds no longer miss failures that arrive just after sending; the flaky e2e has its
  cause removed.
- 🧪 Tests: unit tests pass locally; integration and e2e run in CI on the fix PR.
- 📁 Files: see the list above.
- 🔁 Next prompts: merge the fix PR after CI is green and the user says yes.
- 🧠 Reflection: "final" states that are decided by asynchronous webhooks need a short settle time
  before a decision that cannot be taken back.
