# ADR-0004: Campaign Delivery and Webhook Processing Model

> **Scope**: Document decision clusters, not individual technology choices. Group related decisions that work together (e.g., "Frontend Stack" not separate ADRs for framework, styling, deployment).

- **Status:** Accepted (2026-11-19, reviewed against the implementation in T201)
- **Date:** 2026-11-16
- **Feature:** 001-whatsapp-bulk-messaging
- **Context:** Bulk sending is the core product and its biggest risk. The spec requires:
  - zero duplicate sends (SC-004)
  - pause effective within 10 s, scheduled start within 1 min
  - status updates visible within 1 min (SC-005)
  - automatic retries only for temporary failures
  - auto-pause on blocking problems (FR-022 to FR-027)

  Facts from Meta's docs (checked 2026-11-16):
  - Default throughput is up to 80 messages per second per business phone number.
  - Messaging limits are set per business portfolio.
  - The send endpoint has no idempotency key.
  - Status webhooks (`sent`, `delivered`, `read`, `failed`) may arrive duplicated or out of order.
  - Some error codes block a whole campaign (expired token, restricted account, paused template).

## Decision

- **Snapshot at launch**:
  - Every audience member becomes a `messages` row: `PENDING` if eligible, `SKIPPED` with a
    reason otherwise.
  - Unique (`campaign_id`, `contact_id`) makes double-insertion impossible.
- **Dispatcher**:
  - A `campaign-dispatch` job runs about every 1 s while a campaign is `RUNNING`.
  - It moves the next `rate × 2` `PENDING` rows to `QUEUED` (`FOR UPDATE SKIP LOCKED`).
  - It enqueues jobs with ID `msg:{id}` into `send:{numberId}`, whose BullMQ limiter equals the
    number's `send_rate_per_second` (default 20, maximum 80 unless Meta has upgraded the number).
- **Send worker (claim-before-send, at-most-once)**:
  1. Re-check the campaign state and the contact's consent.
  2. Claim the message with a conditional update `QUEUED → SENDING`.
  3. Call Meta and classify the outcome:

  | Outcome | Action |
  |---|---|
  | Success | `SENT` + store `wa_message_id` |
  | Transient (130429, 131000, 131016, 133004, 4, 80007, 131056, HTTP 5xx, connection refused before sending) | Up to 3 retries, backoff 30 s / 2 min / 8 min |
  | Permanent (e.g. 131026, 131047, 131049, 132000, 132012) | `FAILED` with a readable reason |
  | Campaign-blocking (190, 10, 368, 133010, 132001, 132007, 132015, 132016) | Message back to `PENDING`; campaign auto-paused; admins notified |
  | Ambiguous (timeout after the request was written) | `FAILED` with reason `unknown_outcome_not_retried`; never resent |

- **Control**:
  - Pause, resume and cancel act on the campaign state.
  - A worker that sees `PAUSED` returns its message to `PENDING`.
  - Resume dispatches only `PENDING` rows.
  - Scheduling uses a delayed start job plus a reconciler that runs every 30 s.
- **Webhooks**:
  - Verify `X-Hub-Signature-256` on the raw body, store the raw event, enqueue it, return 200.
  - Processors are idempotent through unique `dedupe_key`s.
  - Status precedence is `QUEUED < SENDING < SENT < DELIVERED < READ`. `FAILED` applies only below
    `DELIVERED`.
  - Template-status and quality webhooks drive auto-pause and notifications.
  - Inbound messages are checked against the consent keywords.

## Consequences

### Positive

- Zero duplicates hold through crashes, retries, pause/resume and duplicated webhooks.
- Redis memory stays flat regardless of campaign size, since at most about 2 s of work is queued
  per number.
- Pause is near-instant and resume is exact.
- Per-number limiters respect Meta throughput, and one number's campaign cannot starve another.
- Fast webhook acknowledgements reduce Meta re-deliveries; raw events allow replay after bugs.
- The precedence rules are deterministic and easy to unit-test.

### Negative

- At-most-once means a message whose outcome was ambiguous may have been delivered yet be shown
  as failed. This slightly under-reports delivery, and that message is never retried.
- The dispatcher is an extra moving part with about 1 s scheduling granularity.
- Per-number queues must be created and removed dynamically as numbers change.
- The Meta error-code mapping must be maintained as Meta adds or changes codes.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| **A. Enqueue every recipient at launch** (one job each) | Simple, but pausing needs mass job removal, memory spikes on 100k campaigns, and resume becomes error-prone. |
| **B. At-least-once delivery** (retry on timeouts) | Higher apparent delivery, but risks sending the same customer the same promotion twice. Violates SC-004 and Principle IV. |
| **C. One global send queue with a global limiter** | Cannot respect per-number throughput; one busy number delays all others. |
| **D. Process webhooks inside the HTTP handler** | Slow acknowledgements trigger Meta retries, and a processing failure loses the event. |
| **E. Rely only on BullMQ job-ID dedupe** (no database claim) | Job removal, restarts or re-dispatch could re-add a job and cause a duplicate send. |

## Implementation Notes (2026-11-19)

- Job IDs are `msg-{id}` in `send-{numberId}`, because BullMQ forbids `:`.
- Public API messages (US7) skip the dispatcher and are queued straight into the number's send queue. A 30 s `send-workers` job starts workers for numbers connected after boot.
- The retry policy is as decided: at most 4 attempts (3 retries) with 30 s, 2 min and 8 min backoff. Ambiguous outcomes are never resent.

## References

- Feature Spec: [specs/001-whatsapp-bulk-messaging/spec.md](../../specs/001-whatsapp-bulk-messaging/spec.md) (US1, US4, FR-022 to FR-027, SC-004, SC-005)
- Implementation Plan: [specs/001-whatsapp-bulk-messaging/plan.md](../../specs/001-whatsapp-bulk-messaging/plan.md) (Constitution Check IV, Risks)
- Research: [research.md](../../specs/001-whatsapp-bulk-messaging/research.md) R6, R7, R8, R9, R10, R11
- Contracts: [contracts/meta-webhooks.md](../../specs/001-whatsapp-bulk-messaging/contracts/meta-webhooks.md)
- Related ADRs: ADR-0003 (constraints and queues it depends on), ADR-0002 (worker process)
- Evaluator Evidence: [PHR 12](../prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md)
