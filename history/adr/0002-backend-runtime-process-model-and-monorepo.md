# ADR-0002: Backend Runtime, Process Model and Monorepo

> **Scope**: Document decision clusters, not individual technology choices. Group related decisions that work together (e.g., "Frontend Stack" not separate ADRs for framework, styling, deployment).

- **Status:** Accepted (2026-11-19, reviewed against the implementation in T201)
- **Date:** 2026-11-16
- **Feature:** 001-whatsapp-bulk-messaging
- **Context:** The platform needs:
  - an HTTP API serving two clients: the dashboard and the public v1 API for company systems
  - long-running background work: campaign dispatch, rate-limited sending, webhook processing,
    CSV imports, scheduled jobs

  The team is small and works in TypeScript. The constitution mandates Node.js with NestJS and
  simplicity (Principle VII). On 2026-11-16 the toolchain imposed a constraint:
  `typescript@latest` is 7.0, but `@nestjs/cli` depends on `typescript ~6.0.2` and
  typescript-eslint supports `<6.1`. NestJS 12 itself is published as ESM-only.

## Decision

- **Runtime**: Node.js 26 LTS.
- **Language**: TypeScript 6.0, strict mode, ESM (`"type": "module"`, `module: nodenext`), because
  NestJS 12 packages are ESM-only. Version 7.0 is deferred until the Nest CLI and typescript-eslint
  support it.
- **Tests**: Vitest 5 with `unplugin-swc` for decorator metadata. This is the default the NestJS 12
  migration guide documents for ESM projects.
- **Framework**: NestJS 12.5, one module per domain:
  - auth, users, audit, settings
  - numbers, contacts, imports, templates, media
  - campaigns, sending, webhooks, reports, rate-card
  - api-keys, public-api, notifications, health
- **Process model**: one codebase with two entrypoints. `main.ts` runs the HTTP API and
  `worker.ts` runs the BullMQ processors. Both ship as the same Docker image with different start
  commands.
- **Repository**: an npm-workspaces monorepo:

  | Workspace | Contents |
  |---|---|
  | `apps/web` | Next.js dashboard |
  | `apps/api` | NestJS API + worker |
  | `packages/shared` | zod DTOs, enums, permission matrix |
  | `tools/mock-meta` | fake Graph API for local and e2e use |

- **Meta integration**: our own thin, typed `MetaGraphClient` built on `fetch`. The Graph API
  version is pinned through `META_GRAPH_API_VERSION` (initial `v27.0`).
- **Cross-cutting**:
  - zod-validated configuration
  - nestjs-pino structured logs with correlation IDs
  - prom-client metrics

## Consequences

### Positive

- One language across web, API and workers; shared types remove client/server drift.
- NestJS DI, guards and interceptors map directly onto RBAC, phone masking and audit
  requirements.
- Worker isolation keeps HTTP latency stable during 100k-recipient campaigns, and API and workers
  scale independently.
- One image and one codebase keep deployment simple: no second service or repository.
- The thin Graph client is easy to mock with nock and to adapt when Meta changes fields.

### Negative

- NestJS has a learning curve and relies on decorators.
- Two processes must be deployed, monitored and kept in version lockstep.
- No build caching without Turborepo or Nx (acceptable at this size).
- Pinning TypeScript 6 delays the TS 7 compiler speedups.
- Owning the Graph client means tracking Meta API changes ourselves.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| **A. Express or Fastify with hand-rolled DI and guards** | Fewer abstractions, but RBAC, validation pipes and interceptors would be custom plumbing to maintain. |
| **B. Separate services** (API, sender service, webhook service) | More infrastructure, inter-service contracts and deploys for no current scaling need (Principle VII). |
| **C. Python FastAPI backend** (offered to the owner) | Not chosen; the owner picked TypeScript end to end. |
| **D. Turborepo or Nx** | Task graph and caching are unnecessary at four packages. Can be added later without restructuring. |
| **E. A third-party WhatsApp Cloud API SDK** | Extra abstraction we don't control, which lags behind Graph changes. |
| **F. TypeScript 7.0** | Incompatible with the Nest CLI and typescript-eslint today. |
| **G. Jest 30 + ts-jest in CommonJS** | Loads the ESM-only NestJS 12 packages only through Node's `require(esm)` (Node ≥24.9). NestJS 12 documents Vitest as the ESM default. |

## Implementation Notes (2026-11-19)

- Two modules were added beyond the list: `meta` (the Graph client) and `maintenance` (the retention job).
- One image (`apps/api/Dockerfile`) runs `node dist/main.js` or `node dist/worker.js`. Its `migrate` stage runs `prisma migrate deploy` as the release step.
- Performance scripts live in `tools/perf` as plain scripts, not as a workspace.

## References

- Feature Spec: [specs/001-whatsapp-bulk-messaging/spec.md](../../specs/001-whatsapp-bulk-messaging/spec.md)
- Implementation Plan: [specs/001-whatsapp-bulk-messaging/plan.md](../../specs/001-whatsapp-bulk-messaging/plan.md) (Technical Context, Project Structure, Complexity Tracking)
- Research: [research.md](../../specs/001-whatsapp-bulk-messaging/research.md) R1, R2, R4, R8, R19
- Related ADRs: ADR-0001 (frontend), ADR-0003 (data & queues), ADR-0004 (delivery model)
- Evaluator Evidence: [PHR 12](../prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md)
