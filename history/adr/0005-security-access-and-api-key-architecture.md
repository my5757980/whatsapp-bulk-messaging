# ADR-0005: Security, Access and API Key Architecture

> **Scope**: Document decision clusters, not individual technology choices. Group related decisions that work together (e.g., "Frontend Stack" not separate ADRs for framework, styling, deployment).

- **Status:** Accepted (2026-11-19, reviewed against the implementation in T201)
- **Date:** 2026-11-16
- **Feature:** 001-whatsapp-bulk-messaging
- **Context:** The platform stores personal data (phone numbers, consent history) and powerful
  credentials (Meta access tokens). It serves three roles:
  - admin: everything
  - manager: contacts, templates, campaigns
  - agent: read-only, with masked phone numbers

  Company systems call it with API keys. The constitution (Principle III) requires env-only
  secrets, encrypted tokens, least privilege, webhook verification, audit logs and masking. The
  spec requires that deactivated users lose access immediately (US6) and that API retries never
  double-send (FR-036).

## Decision

- **Authentication**:
  - Email + password hashed with argon2id (minimum 12 characters).
  - Login throttled per email + IP.
- **Sessions**:
  - An opaque random token in an httpOnly, Secure, SameSite=Lax cookie.
  - Only its SHA-256 hash is stored in `sessions` (12 h idle, 7 d absolute).
  - Deactivation deletes the user's sessions.
- **CSRF**: double-submit token (`csrf` cookie + `X-CSRF-Token` header) required on every
  mutating request.
- **Authorization**:
  - A role → permission matrix lives in `packages/shared`.
  - The API enforces it with a NestJS guard (`@Require(permission)`); the web app uses the same
    matrix to hide actions.
  - The last active admin cannot be demoted.
- **Data protection**:
  - A response interceptor masks every `@PhoneField` to the last 4 digits for AGENT.
  - Exports require `data.export`.
  - Contact deletion anonymises related messages.
- **Secrets**:
  - Environment variables only; `.env.example` is committed, `.env` never.
  - Meta tokens are encrypted with AES-256-GCM using a versioned key format (`v1:iv:tag:ct`).
  - The webhook app secret and verify token stay in env only.
- **Audit**: `audit_logs` records:
  - sign-in events and user/role changes
  - number and credential changes
  - campaign launch, schedule, pause and cancel
  - exports and contact deletions
  - API key creation and revocation
  - settings and rate-card changes
- **Public API**:
  - **Keys:** format `wbk_…`, sent as `Authorization: Bearer`. Only the SHA-256 hash, a prefix and
    the last 4 characters are stored; the full key is shown once.
  - **Idempotency:** an optional `Idempotency-Key` is stored for 24 h. A reused key with a
    different body returns 409.
  - **Rate limit:** a per-key Redis fixed window (default 60/min) returns 429 with `Retry-After`.

## Consequences

### Positive

- Revocation is instant: removing session rows signs a user out everywhere.
- One permission source of truth for web and API, so the UI and the enforcement cannot disagree.
- Masking is centralised, so no single endpoint can forget it.
- A leaked database dump exposes no usable session tokens, API keys or Meta tokens.
- Idempotency makes integration retries safe; rate limits protect sending capacity.
- The audit trail answers "who launched or exported what, and when".

### Negative

- Every authenticated request costs a session lookup; a short Redis cache can be added later.
- The frontend client must manage the CSRF token on every mutation.
- Rotating the encryption key needs a re-encryption job.
- No SSO or 2FA in v1 (a documented gap).
- A fixed-window rate limit allows short bursts at window edges.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| **A. JWT access + refresh tokens** | Stateless, but immediate revocation needs a blocklist, which works against the deactivation requirement. |
| **B. Auth.js / NextAuth inside the Next.js app** | Splits identity away from the NestJS API, which the public API and workers also depend on. |
| **C. Managed identity** (Auth0, Clerk) | Quicker SSO/2FA later, but adds a vendor, cost and an external dependency for an internal tool. Revisit when SSO is required. |
| **D. Per-endpoint authorization and masking code** | Error-prone; one missed endpoint leaks full numbers. |
| **E. Cloud KMS for token encryption** | Stronger key management, but adds a cloud dependency in v1. The versioned format allows moving to KMS later. |
| **F. `@nestjs/throttler` with a third-party Redis store** | Adds a dependency for logic that is about 30 lines with `INCR` + `EXPIRE`. |

## Implementation Notes (2026-11-19)

- The API key guard looks keys up by their unique SHA-256 hash, so no separate prefix lookup is needed.
- The API trusts `X-Forwarded-For` only from loopback and private peers. Behind the web proxy, the login throttle (per email + IP) and the audit log therefore see the real client address. This gap was found and fixed in T201.
- In production the API refuses to start with `COOKIE_SECURE=false` or a non-https `APP_URL`, and helmet sends `default-src 'none'` on API responses (T198).
- A malformed public API body returns 400, as the contract specifies, and an API call can never undo an opt-out.

## References

- Feature Spec: [specs/001-whatsapp-bulk-messaging/spec.md](../../specs/001-whatsapp-bulk-messaging/spec.md) (US6, US7, FR-005 to FR-008, FR-032 to FR-037)
- Implementation Plan: [specs/001-whatsapp-bulk-messaging/plan.md](../../specs/001-whatsapp-bulk-messaging/plan.md) (Constitution Check III)
- Research: [research.md](../../specs/001-whatsapp-bulk-messaging/research.md) R14, R15, R16, R18
- Contracts: [dashboard-api.openapi.yaml](../../specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml), [public-api.openapi.yaml](../../specs/001-whatsapp-bulk-messaging/contracts/public-api.openapi.yaml)
- Related ADRs: ADR-0001 (client CSRF handling), ADR-0002 (guards/interceptors), ADR-0003 (Redis counters)
- Evaluator Evidence: [PHR 12](../prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md)
