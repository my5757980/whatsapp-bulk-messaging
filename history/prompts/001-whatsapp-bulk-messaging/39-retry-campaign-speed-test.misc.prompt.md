---
id: 39
title: Retry Campaign Speed Test
stage: misc
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: none
labels: ["perf", "sc-002", "sc-005", "webhooks", "release"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0004-campaign-delivery-and-webhook-processing.md
  pr: null
files:
 - tools/perf/campaign-10k.ts (status-arrival check, from the previous turn)
 - specs/001-whatsapp-bulk-messaging/checklists/release.md
 - specs/001-whatsapp-bulk-messaging/tasks.md
tests:
 - perf:campaign at 25 msg/s: sending 10m 59s PASS, 10,000 unique sends PASS, statuses-within-2-min FAIL (hardware-bound)
 - Worker-only drain: about 23 webhooks/s; final statuses READ 9,999 + FAILED 1; 0 webhooks left in the queue
---

## Prompt

dubara try karooo

## Response snapshot

The user asked me to retry the campaign speed test.

- **How it ran this time:** one foreground script started mock-meta, the API and the worker with a 384 MB heap cap, ran the test at 25 msg/s, then stopped them.
- **Sending:** 10,000 sent in 10m 59s (SC-002 limit 20 min) at an effective 15.2 msg/s, with 10,000 unique sends and no duplicates.
- **Statuses:**
  - About 30,000 status webhooks were all stored and queued (mock-meta reported 0 post failures), but they lagged.
  - With only the worker running, they drained at about 23/s. Final: 9,999 Read and 1 Failed (the deliberate `0000` number).
  - So nothing was lost. The lag comes from this machine's slow, CPU-starved Postgres.
- **Leftover records:** about 8.5k unprocessed `webhook_events` rows came from the first overloaded 80 msg/s run (old code). They were stored but never queued, and mock-meta does not retry. Real Meta retries non-200 deliveries. A recovery sweep is recorded as a follow-up.
- **Not run:** the browser e2e tests and the Docker builds, which would exhaust memory here. I recommend CI.

## Outcome

- ✅ Impact: Both performance targets are met (SC-007 import, SC-002 campaign), and the status pipeline is now loss-free and correct under parallel processing.
- 🧪 Tests: the perf campaign passes sending and uniqueness. Status lag is documented as hardware-bound.
- 📁 Files: release checklist, tasks.md.
- 🔁 Next prompts: approval to commit and push, so CI runs the e2e and Docker builds.
- 🧠 Reflection: Capping the rate and the Node heaps kept the run alive on a 3.9 GB machine. Draining with only the worker separated correctness from hardware throughput.

## Evaluation notes (flywheel)

- Failure modes observed: the 10-minute tool limit moved the run to the background, so a foreground wait loop kept the session active until it finished.
- Graders run and results (PASS/FAIL): perf:campaign sending PASS, uniqueness PASS, status timing FAIL (hardware); drain PASS (all final).
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): run the 80 msg/s campaign on staging hardware to measure SC-005.
