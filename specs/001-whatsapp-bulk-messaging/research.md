# Research: WhatsApp Bulk Messaging Core

**Feature**: `001-whatsapp-bulk-messaging` | **Date**: 2026-11-16 | **Plan**: [plan.md](./plan.md)

## How facts were checked

| Source | Used for |
|---|---|
| `npm view` (2026-11-16) | package versions |
| Meta developer docs (Cloud API overview, error codes, phone-number management) | platform facts |
| Context7 (`/dogalyir/whatsapp-cloud-api-types`, `/gokapso/whatsapp-cloud-api-js`) | webhook and template payload shapes |

Items marked **verify at implementation** must be re-checked against Meta's docs when coded. Every Technical Context unknown is resolved below; none remain.

---

## R1. Runtime and language versions

- **Decision:**
  - Node.js 26 LTS (developer machine already has v26.13.0).
  - TypeScript **6.0.x**. Do **not** use 7.0.
  - **ESM everywhere** (`"type": "module"`, `module: nodenext`). `@nestjs/core@12` is published with `"type": "module"` (ESM-only), and the NestJS 12 migration guide generates ESM projects.
- **Rationale:**
  - `typescript@latest` is 7.0.2, the native-compiler rewrite. But `@nestjs/cli` depends on `typescript ~6.0.2`, and `typescript-eslint` supports `<6.1`.
  - 6.0 is the newest version the toolchain supports.
- **Alternatives considered:**
  - TS 7.0 — breaks ts-jest and Nest CLI today.
  - Node 24 LTS — fine too, but 26 matches the local machine and is LTS since Oct 2026.

## R2. Monorepo tooling

- **Decision:** npm workspaces with four packages:
  - `apps/web`
  - `apps/api`
  - `packages/shared`
  - `tools/mock-meta`
- **Rationale:** built into npm 11 (installed) with no extra tool (Principle VII). It shares zod DTOs and the role-permission matrix between web and api.
- **Alternatives considered:**
  - Turborepo / Nx — caching not needed at this size.
  - Separate repos — type drift between web and api.

## R3. Frontend stack

- **Decision:**
  - Next.js **16.4** (App Router) with React **19.3**.
  - TanStack Query **5** for server state.
  - Tailwind CSS **4** with locally generated shadcn/ui components.
  - react-hook-form + zod **4** for forms.
  - Polling every 5 s for live campaign progress.
- **Rationale:**
  - These are the current stable releases.
  - Polling meets SC-005 (updates visible ≤1 min) without WebSocket infrastructure (Principle VII).
- **Alternatives considered:**
  - Socket.IO / SSE — not needed until the shared inbox feature.
  - Redux — more boilerplate than TanStack Query for server state.

## R4. Backend framework and ORM

- **Decision:**
  - NestJS **12.5** with two entrypoints: `main.ts` (HTTP API) and `worker.ts` (BullMQ processors).
  - Prisma **7.10.x** for the ORM and migrations.
- **Rationale:**
  - NestJS gives modules, guards, interceptors and DI that suit RBAC, masking and audit.
  - One codebase avoids a second service (Principle VII).
  - `@prisma/client@latest` = 7.10.1. Note: the `prisma` CLI's `latest` tag points to an 8.0 release candidate, so pin both packages to **7.10.x** explicitly.
- **Alternatives considered:**
  - Express/Fastify alone — RBAC and DI would be hand-rolled.
  - TypeORM / Drizzle — Prisma was chosen by the owner and has the best migration DX.
  - Prisma 8 RC — not stable.

## R5. Database

- **Decision:**
  - PostgreSQL 16+: Neon in production, `postgres:16` in Docker Compose locally.
  - Custom contact attributes go in a `jsonb` column with a GIN index.
  - Money is stored as integer **USD micros**.
- **Rationale:**
  - jsonb covers ad-hoc attribute filters at 200k-contact scale with simple queries.
  - Integer micros avoid floating-point cost errors (SC-009).
- **Alternatives considered:**
  - EAV attribute table — more joins, slower filters.
  - `numeric` money — fine, but integer micros are simpler in TypeScript.

## R6. Queueing and scheduling

- **Decision:**
  - Redis 7+ (`maxmemory-policy noeviction`, AOF on) with BullMQ **6.7** and ioredis **6**.
  - Queues:
    - `campaign-dispatch`
    - `send:{numberId}` — one per number, with a BullMQ limiter `{ max: sendRatePerSecond, duration: 1000 }`
    - `webhooks`
    - `imports`
    - `maintenance` — repeatable jobs: schedule reconciler, quality refresh, idempotency cleanup
- **Rationale:**
  - A per-number queue with a limiter enforces per-number throughput (Principle IV).
  - BullMQ gives retries, backoff, delayed jobs and retained failed jobs (the dead-letter view).
- **Alternatives considered:**
  - Postgres-only job table (pg-boss) — fewer moving parts, but a weaker rate limiter.
  - BullMQ Pro groups — paid.
  - RabbitMQ — extra infrastructure.

## R7. Campaign dispatch, pause/resume and duplicate prevention

**Decision — dispatcher pattern with claim-before-send (at-most-once per recipient):**

1. **Launch:**
   - Snapshot the audience into `messages` rows. Eligible recipients get `PENDING`; ineligible ones get `SKIPPED` with a reason.
   - A unique constraint `(campaign_id, contact_id)` makes duplicates impossible.
2. **Dispatch:**
   - A `campaign-dispatch` job runs every ~1 s while the campaign is `RUNNING`.
   - Each run picks the next `rate × 2` `PENDING` rows (`FOR UPDATE SKIP LOCKED`), marks them `QUEUED`, and adds send jobs with `jobId = msg:{messageId}` (BullMQ ignores duplicate job IDs).
3. **Send worker:**
   - Re-reads the campaign state.
     - Paused → set the message back to `PENDING` and finish the job.
     - Cancelled → set `CANCELLED` and finish.
   - Otherwise claims the message with a conditional update `QUEUED → SENDING`, then calls Meta:
     - **Success** → `SENT` and store `wa_message_id`.
     - **Error response with a transient code** → back to `QUEUED`; the job retries.
     - **Error response with a permanent code** → `FAILED`.
     - **Ambiguous outcome** (timeout after the request was written) → `FAILED` with reason `unknown_outcome_not_retried`.
4. **Pause** takes effect within ~2 s, because the queue buffer holds at most 2 s of messages.
5. **Resume** re-dispatches only `PENDING` rows.

- **Rationale:**
  - SC-004 requires zero duplicates.
  - The Cloud API has no idempotency key for sends, so the only safe rule is never to resend after an uncertain outcome.
  - The small buffer makes pause fast (≤10 s) and keeps Redis memory flat for 100k campaigns.
- **Alternatives considered:**
  - Enqueue all 100k jobs at launch — pause would need mass job removal, and memory spikes.
  - At-least-once with retry on timeout — risks duplicate customer messages.

## R8. Meta Cloud API usage (Graph API pinned via `META_GRAPH_API_VERSION`, initial `v27.0`)

| Need | Call | Notes |
|---|---|---|
| Send template | `POST /{phone-number-id}/messages` with `{messaging_product:"whatsapp", to, type:"template", template:{name, language:{code}, components:[…]}}` | Response holds `messages[0].id` (= `wa_message_id`) |
| List templates | `GET /{waba-id}/message_templates` (filters: status, name, category, language; cursor paging) | Sync on connect, on demand, and on webhook |
| Create template | `POST /{waba-id}/message_templates` `{name, language, category, components, parameter_format?}` | Response `{id, status:"PENDING", category}` |
| Delete template | `DELETE /{waba-id}/message_templates?name=…` | |
| Number details | `GET /{phone-number-id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,status,throughput` | Field names verified in Meta docs |
| Messaging-limit tier | Not documented as a phone-number field | **Verify at implementation.** Fallback: admin enters the current tier on the number settings page |
| Media for sends | Upload once per number (`POST /{phone-number-id}/media`), reuse the media ID | **Verify** retention period |
| Template header samples | Resumable Upload API → `header_handle` | **Verify at implementation** |

- **Throughput:** Meta default is **up to 80 messages/second per business phone number**, with upgrades available. The per-number `sendRatePerSecond` defaults to **20** and admins can raise it to 80 (or higher after an upgrade).
- **Messaging limits** are set at the **business portfolio** level (distinct users per rolling 24 h). The pre-launch check warns when the eligible count exceeds the stored tier.
- **Alternatives considered:**
  - A third-party SDK (e.g. `whatsapp-api-js`, `@kapso/whatsapp-cloud-api`) — adds an abstraction we don't control. A thin typed `MetaGraphClient` (~300 LOC) using `fetch` is simpler to mock with nock.

## R9. Error classification (retry policy)

Based on Meta's error-code page; the retry class is our policy.

| Class | Codes | Action |
|---|---|---|
| Transient — retry with backoff (30 s → 2 min → 8 min; 3 retries max) | 130429 (throughput reached), 131000 (unknown), 131016 (service unavailable), 133004 (server unavailable), 4 (app rate limit), 80007 (WABA rate limit), 131056 (pair rate limit), HTTP 5xx, connection refused before send | Message back to `QUEUED`; job retries |
| Permanent per message — no retry | 131026 (undeliverable), 131047 (24-h window), 131049 (ecosystem limit; Meta says wait ≥24 h), 132000 / 132012 (parameter mismatch/format), 132005 (text too long), 131048 (spam-rate restriction) | `FAILED` with code and readable reason |
| Campaign-blocking — auto-pause + notify admins (FR-027) | 190 (token expired), 10 (permission), 368 (account restricted), 133010 (number not registered), 132001 / 132007 / 132015 / 132016 (template missing / policy / paused / disabled) | Message back to `PENDING`; campaign `PAUSED` with reason |

- **Rationale:** maps each Meta error to the spec's behaviour (FR-024, FR-027).
- **Alternatives considered:** retry everything — wastes quota and can worsen quality ratings.

## R10. Webhook ingestion and status precedence

- **Decision:**
  - `GET /webhooks/meta` answers the verification handshake (`hub.mode=subscribe`, `hub.verify_token`, return `hub.challenge`).
  - `POST /webhooks/meta`:
    1. Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `META_APP_SECRET`, timing-safe compare) — invalid → 401.
    2. Insert the raw payload into `webhook_events`.
    3. Enqueue `webhooks` jobs and return **200** immediately.
  - Processors:
    - **`statuses[]`** (`sent|delivered|read|failed|deleted`): insert `message_events` with unique `dedupe_key = {wa_message_id}:{status}`, so duplicates are no-ops. Apply the precedence below to `messages.status`. Store `pricing` (`billable`, `category`, `pricing_model`) and `errors[]`.
    - **`messages[]`** (inbound): run the consent keyword check (R12).
    - **`message_template_status_update`**: update template status and rejection reason.
    - **`phone_number_quality_update`**: update quality and notify admins on a drop.
    - **verify at implementation:** the exact subscribed field names.
- **Precedence:** `QUEUED < SENDING < SENT < DELIVERED < READ`.
  - A status never moves backwards.
  - `FAILED` applies only while the current status is below `DELIVERED`.
  - Timestamps (`sent_at`, `delivered_at`, `read_at`) are filled independently, so out-of-order events still produce a full timeline.
- **Rationale:** a fast acknowledgement avoids Meta retries; raw storage allows replay; unique keys give idempotency (Principle IV); the precedence rule meets FR-025.
- **Alternatives considered:** processing inline in the HTTP handler — slow acks cause Meta re-deliveries, and failures lose events.

## R11. Pre-send eligibility (consent enforcement in three places)

- **Decision — the same consent rules are checked at three points:**
  1. **Audience snapshot** — excludes opted-out contacts; for MARKETING templates, also excludes contacts not opted in.
  2. **Send worker** — re-checks consent right before the API call; marks `SKIPPED (opted_out)` if it changed meanwhile.
  3. **Public API** — rejects such requests with a reason.
- **Rationale:** the spec requires opt-out mid-campaign to be honoured (edge case, FR-014, SC-003).
- **Alternatives considered:** checking only at the snapshot — misses mid-campaign opt-outs.

## R12. Consent keywords

- **Decision:**
  - Normalise inbound text: trim, collapse spaces, uppercase.
  - An exact match against the settings lists (defaults: opt-out `STOP`, `UNSUBSCRIBE`; opt-in `START`) updates the contact and writes a `consent_events` row with source `KEYWORD`.
  - Unknown senders are created as contacts with status `OPTED_OUT` or `UNKNOWN` accordingly.
- **Rationale:** deterministic and testable; meets FR-013 and the ≤1 min target, since the webhook queue latency is seconds.
- **Alternatives considered:** substring / NLP matching — causes false opt-outs ("don't stop sending").

## R13. CSV import

- **Decision:**
  - The upload goes to object storage, then an `imports` job runs.
  - `csv-parse` **7** streaming (UTF-8; BOM stripped; delimiter auto-detected among `,` `;` and tab).
  - Phones are normalised to E.164 with `libphonenumber-js` using the default country.
  - Rows are upserted in batches of 1,000 with `INSERT … ON CONFLICT (phone_e164) DO UPDATE`.
  - An error CSV is written to storage.
  - Campaign-wizard uploads write to `campaign_upload_rows` (phone + raw columns as jsonb) so extra columns can feed template variables; matching contacts are upserted with the confirmed opt-in source.
- **Rationale:** 50k rows in ≤5 min is easily met with batched upserts, and streaming keeps memory flat.
- **Alternatives considered:** parsing in the browser — no server-side validation; Papa Parse in Node — csv-parse has better streaming support.

## R14. Authentication, sessions, CSRF

- **Decision:**
  - **Passwords:** argon2id hashes (`argon2` 0.45), minimum 12 characters, login throttled to 10 attempts per 15 min per email+IP.
  - **Sessions:** opaque random session token in an httpOnly, Secure, SameSite=Lax cookie. Only its SHA-256 hash is stored in `sessions` (sliding 12 h idle, 7 d absolute).
  - **CSRF:** double-submit token (`csrf` cookie + `X-CSRF-Token` header) on all mutating requests.
  - **Invitations:** a random token (hashed, 7-day expiry). The link is shown to the admin and emailed when `SMTP_URL` is set.
- **Rationale:** server-side sessions can be revoked instantly on deactivation (US6 scenario 5), which JWTs cannot.
- **Alternatives considered:**
  - JWT — hard revocation.
  - NextAuth/Auth.js — auth belongs in the API, which other clients also use.
  - bcrypt — argon2id is the current OWASP recommendation.

## R15. Secrets and token encryption

- **Decision:**
  - Meta access tokens are encrypted with AES-256-GCM: random 12-byte IV per value, stored as `v1:<iv>:<tag>:<ciphertext>` (base64).
  - The key comes from `TOKEN_ENCRYPTION_KEY` (32 bytes, base64). A `v1` prefix allows key rotation.
  - Webhook app secret and verify token live in env only.
- **Rationale:** Principle III requires secrets at rest to be encrypted, and authenticated encryption detects tampering.
- **Alternatives considered:** a KMS — fine later, but adds a cloud dependency now.

## R16. Public API: keys, idempotency, rate limits

- **Decision:**
  - **Keys:** format `wbk_<32 base62 chars>`, sent as `Authorization: Bearer`. Stored as a SHA-256 hash plus `prefix` (8 chars) and `last4`; shown once.
  - **Idempotency:** optional `Idempotency-Key` header. A row in `idempotency_records` (unique `api_key_id, key`; 24 h TTL) holds the request hash and message ID. Same key + same body returns the original reference; same key + different body returns 409.
  - **Rate limit:** Redis fixed window per key (`INCR` + `EXPIRE 60`), default 60/min, configurable. Over the limit → 429 with `Retry-After`.
- **Rationale:** meets FR-032–FR-037 with minimal dependencies.
- **Alternatives considered:**
  - `@nestjs/throttler` 6.8 — in-memory by default and needs a third-party Redis store.
  - Mandatory idempotency key — friction for simple integrations.

## R17. Cost estimation

- **Decision:**
  - `rate_card_entries` has category (`MARKETING`, `UTILITY`, `AUTHENTICATION`, `SERVICE`), country (ISO-2 or `*` default), `price_usd_micros` and `effective_from`.
  - **Pre-launch estimate** = eligible recipients × rate for the template category and each recipient's country.
  - **Actual estimate** = for each message whose status webhook shows `pricing.billable = true` (or that is delivered when pricing is absent), the rate effective on the delivery date for `pricing.category`, falling back to the template category.
- **Rationale:** Meta bills per delivered message by category and country; the webhook pricing object gives the category and billable flag (verified in the types docs).
- **Alternatives considered:** importing Meta invoices automatically — out of scope; manual comparison covers SC-009.

## R18. Role-based access and masking

- **Decision:**
  - The permission matrix lives in `packages/shared/permissions.ts` (from the spec's table), with a NestJS `@Require(permission)` guard.
  - A response interceptor masks every field tagged `@PhoneField()` to `•••• 1234` for the AGENT role. Export endpoints require `data.export`.
- **Rationale:** a single source of truth used by both web (hide UI) and api (enforce); masking is centralised so no endpoint leaks numbers.
- **Alternatives considered:** per-endpoint masking code — easy to forget.

## R19. Observability

- **Decision:**
  - **Logs:** `nestjs-pino` 5 / pino 10 JSON with `reqId`, `userId`, `campaignId`, `messageId`. A redaction list covers tokens, cookies, `authorization`, message bodies and phones (masked).
  - **Metrics:** `prom-client` 15 at `/metrics`, protected by the `X-Ops-Token` header and kept on the internal network:
    - `wbm_messages_total{status, number}`
    - `wbm_send_errors_total{code}`
    - `wbm_queue_depth{queue}`
    - `wbm_webhook_lag_seconds` (histogram)
    - `wbm_campaigns_running`
  - **Alerts** in `ops/alerts.yml`:
    - failure rate >5% over 10 min
    - queue depth not decreasing for 5 min
    - webhook lag p95 >60 s
    - no webhooks for 15 min while campaigns are running
- **Rationale:** Principle VI.
- **Alternatives considered:** OpenTelemetry tracing — useful later; logs + metrics suffice for v1.

## R20. Object storage

- **Decision:** S3-compatible storage via `@aws-sdk/client-s3` v3. MinIO in Docker locally; AWS S3 or Cloudflare R2 in production. It holds:
  - import files and error reports (deleted after 30 days)
  - template sample media and campaign header media
- **Rationale:** files must survive container restarts and be shared by api and worker.
- **Alternatives considered:** local disk — not shared across containers.

## R21. Testing strategy

- **Decision:**
  - **Unit:** Vitest **5** in every workspace. The API uses `unplugin-swc` so decorator metadata is emitted. The NestJS 12 migration guide names Vitest the default for ESM projects; Jest can load NestJS 12 only through Node's `require(esm)` on Node ≥24.9.
  - **Integration:** Supertest **7** against the Nest app, using real Postgres + Redis from Docker Compose (database reset per run with `prisma migrate reset --force`).
  - **Meta HTTP mocks:** nock **15**; webhooks are simulated by posting signed payloads.
  - **Contract tests:** responses validated against `contracts/*.openapi.yaml`.
  - **E2E:** Playwright **1.65** against the full local stack with `tools/mock-meta`, a small fake Graph API that accepts sends and emits signed status webhooks.
  - **CI** (GitHub Actions): lint → typecheck → unit → integration → contract → e2e smoke.
- **Rationale:** Principle V — tests first, never call real Meta.
- **Alternatives considered:** Testcontainers — good, but Docker Compose is already required for local dev; a mocked Prisma — misses SQL constraints that matter here (unique keys, SKIP LOCKED); Jest 30 + ts-jest in CommonJS — works only through `require(esm)`, against NestJS 12's documented ESM + Vitest default.

## R22. Deployment shape

- **Decision:**
  - Three containers from two Dockerfiles: `web`, `api` and `worker` (same image as api, different command).
  - Neon Postgres, Redis with `noeviction` and persistence, S3-compatible storage.
  - The webhook URL must be public HTTPS.
  - Prisma migrations run as a release step.
- **Rationale:** simple to run on any Docker host or VPS.
- **Alternatives considered:** serverless functions — long-running workers and Redis connections fit poorly.
