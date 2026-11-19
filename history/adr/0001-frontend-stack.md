# ADR-0001: Frontend Stack

> **Scope**: Document decision clusters, not individual technology choices. Group related decisions that work together (e.g., "Frontend Stack" not separate ADRs for framework, styling, deployment).

- **Status:** Accepted (2026-11-19, reviewed against the implementation in T201)
- **Date:** 2026-11-16
- **Feature:** 001-whatsapp-bulk-messaging
- **Context:** The company needs an internal dashboard for 10–20 team members and about 25 screens:
  - a campaign wizard
  - paginated contact tables (up to 200k contacts)
  - a template editor with a phone preview
  - live campaign progress
  - settings
  
  Constitution v1.0.0 requires Next.js with TypeScript strict mode and original UI (Principle II).
  The spec requires status updates to be visible within 1 minute (SC-005) and first-time users to
  succeed without help (SC-008). The backend is a separate NestJS API that also serves the public
  API and background workers, so the frontend must not own business logic.

## Decision

- **Framework**: Next.js 16.4 (App Router) with React 19.3, TypeScript 6.0 strict.
- **Role of Next.js**: UI layer only. The browser calls the NestJS API with the session cookie and
  the CSRF header. No business logic or database access lives in Route Handlers or Server
  Actions.
- **Server state**: TanStack Query 5 for caching, mutations and polling. No global client-state
  store.
- **UI components**: Tailwind CSS 4 + shadcn/ui components generated into the repo (owned code,
  original design).
- **Forms & validation**: react-hook-form + zod 4 schemas imported from `packages/shared`, the
  same schemas the API validates with.
- **Live updates**: polling every 5 s for running campaigns. No WebSocket/SSE in v1.
- **Testing**: Vitest + Testing Library (unit), Playwright (e2e per user story).

## Consequences

### Positive

- One language end to end. Validation rules are identical in the browser and the API because
  they share the zod schemas.
- The generated components are our own code: no UI-kit lock-in, an original look, easy to adapt.
- Polling is trivial to build, operate and test, and it meets SC-005 with a wide margin.
- Next.js gives routing, code splitting and a path to public SEO pages later without a framework
  change.
- Keeping logic in the API means RBAC, masking and audit rules are enforced in one place.

### Negative

- App Router concepts (server vs client components) add complexity to a mostly client-side
  dashboard.
- Polling adds about 1 request per 5 s per open campaign view, and up to 5 s of display latency.
- Next.js majors move fast, so upgrades must be planned.
- The rule "no business logic in Next.js" depends on review discipline.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| **A. Vite + React SPA + React Router + TanStack Query** | Simpler build with no Node server. Rejected because the constitution names Next.js and SEO/marketing pages may come later; the gain is small. |
| **B. Full-stack Next.js** (Server Actions / Route Handlers with direct database access) | Duplicates domain logic outside the NestJS API that the public API and workers also use. RBAC and audit would be split across two runtimes. |
| **C. Realtime with Socket.IO or SSE** | Deferred to the shared-inbox feature, where true realtime matters. Polling meets the current target. |
| **D. MUI or Ant Design component kit** | Faster start, but a heavier bundle, a generic look and harder deep customisation than owned shadcn components. |

## Implementation Notes (2026-11-19)

- The browser reaches the API through the Next.js `/api/*` rewrite, so the session and CSRF cookies stay first-party. With standalone output the rewrite target (`API_INTERNAL_URL`) is fixed when the image is built.
- `packages/shared` holds the permission matrix, template rules and enums. Most request schemas live next to their API module, and the web app mirrors the response types in `apps/web/src/lib/types.ts`. Moving more schemas into the shared package is an optional follow-up.
- Pages send a Content-Security-Policy and related headers from `next.config.ts` (T198). Scripts still need `'unsafe-inline'` until a nonce-based CSP is adopted.

## References

- Feature Spec: [specs/001-whatsapp-bulk-messaging/spec.md](../../specs/001-whatsapp-bulk-messaging/spec.md)
- Implementation Plan: [specs/001-whatsapp-bulk-messaging/plan.md](../../specs/001-whatsapp-bulk-messaging/plan.md) (Technical Context, Project Structure)
- Research: [research.md](../../specs/001-whatsapp-bulk-messaging/research.md) R2, R3, R21
- Related ADRs: ADR-0002 (backend & monorepo), ADR-0005 (session/CSRF model the client must follow)
- Evaluator Evidence: [PHR 12](../prompts/001-whatsapp-bulk-messaging/12-adr-review-platform-decisions.misc.prompt.md)
