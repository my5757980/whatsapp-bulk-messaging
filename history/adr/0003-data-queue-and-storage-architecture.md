# ADR-0003: Data, Queue and Storage Architecture

> **Scope**: Document decision clusters, not individual technology choices. Group related decisions that work together (e.g., "Frontend Stack" not separate ADRs for framework, styling, deployment).

- **Status:** Accepted (2026-11-19, reviewed against the implementation in T201)
- **Date:** 2026-11-16
- **Feature:** 001-whatsapp-bulk-messaging
- **Context:** The domain is relational:
  - contacts, tags, templates, campaigns, messages, events
  - correctness depends on database-enforced uniqueness: one message per recipient per campaign,
    idempotent webhook events, idempotent API requests

  Scale targets: 200k contacts with ad-hoc attribute filters, 100k-recipient campaigns, and cost
  estimates within 5% (SC-009). Rate-limited queues and delayed jobs are needed, as is shared file
  storage for CSV imports, error reports and media. The constitution names PostgreSQL (Neon) and
  Redis + BullMQ.

  On 2026-11-16 the `prisma` CLI `latest` dist-tag pointed to an 8.0 release candidate, while
  `@prisma/client@latest` was 7.10.1.

## Decision

- **System of record**: PostgreSQL 16+ — Neon in production, Docker locally.
- **Schema & migrations**: Prisma 7.10.x for schema, client and versioned migrations. Both
  packages are pinned explicitly; the 8.0 RC is not used. Migrations run as a release step
  (`prisma migrate deploy`).
- **Modelling conventions**:
  - uuid v7 primary keys
  - custom contact attributes in `contacts.attributes jsonb` with a GIN index, typed and validated
    against `attribute_definitions`
  - money stored as integer USD micros
- **Idempotency in the database**: unique (`campaign_id`, `contact_id`) on messages, unique
  `message_events.dedupe_key`, unique (`api_key_id`, `key`) on idempotency records. Raw
  `webhook_events` are kept for 30 days for replay.
- **Queues & ephemeral state**: Redis 7+ with `maxmemory-policy noeviction` and AOF persistence.
  - BullMQ 6.7 queues: `campaign-dispatch`, `send:{numberId}`, `webhooks`, `imports`,
    `maintenance`
  - Redis also holds the per-API-key rate-limit counters.
- **Files**: S3-compatible object storage (MinIO locally; AWS S3 or Cloudflare R2 in production)
  for import files, error reports, template sample media and campaign media.
- **Deployment shape**: `web`, `api` and `worker` containers alongside managed Postgres, Redis and
  object storage.

## Consequences

### Positive

- Duplicate prevention is guaranteed by database constraints, which is the strongest guarantee
  available.
- jsonb attributes keep segment filters to simple queries without EAV joins.
- Prisma gives a typed client and reviewable migration files.
- BullMQ provides limiters, retries with backoff, delayed jobs and retained failed jobs (the
  dead-letter view) out of the box.
- Object storage lets the api and worker containers share files and survive restarts.
- Integer micros avoid floating-point drift in cost reports.

### Negative

- Three stateful services to provision and monitor: Postgres, Redis and object storage.
- Misconfigured Redis eviction would silently drop jobs, so the setting must be checked at
  startup and in ops.
- jsonb values lack database-level type enforcement; the application must validate.
- Raw SQL is still needed for `FOR UPDATE SKIP LOCKED` and bulk upserts, outside Prisma's query
  builder.
- Neon connection limits and cold starts require its pooled connection string and sensible pool
  sizes.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| **A. Postgres-only queues** (pg-boss or graphile-worker) | One fewer service, but a weaker per-number rate limiter and more database load during 100k-message sends. Worth revisiting if Redis ops become a burden. |
| **B. EAV attribute tables** | Strict typing per value, but heavier joins and slower segment filters. |
| **C. MongoDB** | Flexible documents, but loses the relational constraints that the duplicate guarantees depend on. |
| **D. RabbitMQ or Kafka** | More infrastructure and operational skill than the volume needs. |
| **E. Local disk for files** | Not shared between api and worker containers; lost on redeploy. |
| **F. `numeric` money columns** | Valid, but integer micros are simpler and exact in TypeScript. |

## Implementation Notes (2026-11-19)

- BullMQ does not allow `:` in queue names or custom job IDs, so the per-number queue is `send-{numberId}` and job IDs use `-`.
- Retention runs daily at 03:15 UTC rather than monthly, which keeps the limits exact. Campaigns and their messages are purged 12 months after they end, webhook events and uploaded files after 30 days. Audit logs are never purged.
- `wbm_queue_depth` is read from Redis at scrape time by both the api and the worker. A stopped worker therefore still shows a growing queue.

## References

- Feature Spec: [specs/001-whatsapp-bulk-messaging/spec.md](../../specs/001-whatsapp-bulk-messaging/spec.md)
- Implementation Plan: [specs/001-whatsapp-bulk-messaging/plan.md](../../specs/001-whatsapp-bulk-messaging/plan.md)
- Research: [research.md](../../specs/001-whatsapp-bulk-messaging/research.md) R4, R5, R6, R13, R20, R22
- Data Model: [data-model.md](../../specs/001-whatsapp-bulk-messaging/data-model.md)
- Related ADRs: ADR-0002 (process model), ADR-0004 (delivery model relies on these constraints)
- Evaluator Evidence: [PHR 12](../prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md)
