# WhatsApp Bulk Messaging Platform

The company's own platform for sending WhatsApp template messages at scale through the Meta
WhatsApp Cloud API. One company, a small team, prices in USD.

## What it does

| Area | Highlights |
|---|---|
| Broadcasts (US1, US4) | Pick an approved template, upload a CSV or filter contacts, map variables, then send now or schedule. Sending is throttled per number and can be paused, resumed or cancelled. Temporary failures retry automatically, and blocking problems pause the campaign. |
| Contacts and consent (US2) | CSV import with an error report, tags, custom attributes and opt-in source and date. Replying STOP opts a contact out automatically, and an opt-out always wins. |
| Templates (US3) | Create text, media and button templates, submit them to Meta, and see the approval status sync by itself. |
| Reports (US5) | Delivery and read rates, failure reasons, estimated cost from the USD rate card, CSV export and one-click retargeting. |
| Team (US6) | Admin, manager and agent roles. Agents see masked phone numbers, and an audit log records every sensitive action. |
| Public API (US7) | Other company systems send templates with an API key, with idempotency keys and per-key rate limits. |
| Live chat (feature 002) | A shared team inbox for customer replies: live updates, take, transfer and close chats, the 24-hour reply window, templates from a chat, saved replies, a media library, customer profiles and blocking, welcome and off-hours messages, browser alerts, internal notes and a team view. See [Live chat](#live-chat). |

## Architecture

```
Browser ──> web (Next.js 16, :3000) ──/api/* proxy──> api (NestJS 12, :4000) ──> PostgreSQL 16
                                                        │    ▲                       Redis 7 (BullMQ)
Company systems ──> /api/v1 (API key) ──────────────────┘    │                       S3 / MinIO
                                                             │ webhooks (signed)
worker (NestJS, BullMQ: dispatch, send, webhooks, imports, inbox, maintenance) ──> Meta Graph API v27.0
                                                             │
Browser <── GET /api/inbox/events (SSE via the web proxy) <── api <── Redis Stream wbm:inbox:events
```

- **web** (`apps/web`) is UI only. It proxies `/api/*` to the API, so the session and CSRF cookies
  stay first-party.
- **api** and **worker** (`apps/api`) are one codebase with two entry points (`dist/main.js`,
  `dist/worker.js`) and ship as one Docker image.
- **Delivery:**
  - Each campaign is snapshotted into message rows at launch.
  - A dispatcher feeds one rate-limited queue per number.
  - Senders claim each message before calling Meta (at most once).
  - Status webhooks are deduplicated and applied in precedence order.
- **Live chat:** the worker stores customer messages and publishes events to the Redis Stream
  `wbm:inbox:events`; each api instance fans them out to its browsers over Server-Sent Events,
  filtered by who may see each chat. Replies use the number's send queue ahead of campaigns.
- **Shared code:** `packages/shared` (permissions, template rules, enums).
- **Test double:** `tools/mock-meta` is a fake Graph API for local runs and e2e tests.
- **Performance checks:** `tools/perf`.

Design decisions are recorded in the ADRs below. The constitution is in
`.specify/memory/constitution.md`.

## Live chat

Feature 002 ([spec](specs/002-team-inbox/spec.md), [quickstart](specs/002-team-inbox/quickstart.md)).

- **Lists:** *Open* (waiting for anyone), *Waiting for agent* (the customer asked for a person),
  *Taken* (a member is handling it) and *Past chats* (the 24-hour reply window has closed). The spec
  calls these Active, Requesting, Intervened and History.
- **In a chat:** **Take chat** (one member wins), **Transfer**, **Close chat**, replies with text,
  emoji, files and saved replies (type `/`), **Send template** (also in Past chats), and **Note**
  for internal notes that are never sent; type `@` to mention a teammate.
- **Profile panel:** counts, lead source, tags and attributes, recent campaigns, the customer
  journey, and **Block contact**.
- **Settings:**
  - *Settings → Live chat*: "talk to a person" keywords, closing quiet chats after 24 hours,
    working hours and time zone, and the welcome and off-hours messages (text, an approved
    template or a media library file).
  - *Settings → Saved replies* and *Settings → Media library* (admins and managers).
  - *Settings → Team → Rules*: agent rules (tag or attribute) that decide which chats an agent sees.
- **Team view:** *Live chat → Team view* (admins and managers) shows live counts and, for today,
  7 or 30 days, chats taken and closed with median first response and resolution times.
- **Alerts:** each member turns the chime and browser alerts on in **Alerts** (header). Push
  alerts are sent only while the member has no dashboard tab open.

**Browser push setup:** generate VAPID keys once and set all three variables, or none (push is
then off and the Alerts page says so):

```powershell
npx --no-install web-push generate-vapid-keys
# .env: WEB_PUSH_PUBLIC_KEY=..., WEB_PUSH_PRIVATE_KEY=... (secret), WEB_PUSH_SUBJECT=mailto:it@company.example
```

Browsers allow push only on HTTPS (or `http://localhost`). How alerts look depends on the browser
and the device.

## Getting started

Prerequisites: Node.js 26, npm 11 and Docker Desktop. The full walkthrough, including how to
validate every user story with mock-meta, is in the [quickstart](specs/001-whatsapp-bulk-messaging/quickstart.md).

```powershell
npm install
Copy-Item .env.example .env        # fill in the secrets; see the quickstart's variable table
docker compose up -d postgres redis minio
npm run db:migrate
npm run db:seed -- --admin-email admin@company.test --admin-password "ChangeMe-12345"
npm run dev                        # web :3000, api :4000, worker, mock-meta :4010
```

Then open http://localhost:3000 and sign in with the seeded admin.

## Checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit tests (api and web)
npm run test:integration    # api against Docker Postgres, Redis and MinIO
npm run test:contract       # responses vs the OpenAPI contracts
npm run test:e2e            # Playwright with mock-meta
npm run perf:import         # SC-007: 50k-row import within 5 min (api + worker running)
npm run perf:campaign       # SC-002: 10k campaign within 20 min (api + worker + mock-meta running)
npm run perf:inbox-seed     # live chat: 10,000 chats and one chat of 5,000 messages (api + worker running)
npm run perf:inbox          # live chat SC-006 list/open times and SC-001 event latency (after the seed)
```

CI (`.github/workflows/ci.yml`) also runs `npm audit`, checks the alert rules with `promtool`,
scans the history for secrets with gitleaks and builds the Docker images. The Docker job then runs
the api and the standalone web image and checks that the live chat event stream passes through
the web proxy.

## Production notes

- **Images:**
  - API and worker: `docker build -f apps/api/Dockerfile -t wbm-api .` The default command runs
    the API; run `node dist/worker.js` for the worker.
  - Migrations: `--target migrate` builds an image that runs `prisma migrate deploy`.
  - Web: `docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t wbm-web .`
- **Required settings:** with `NODE_ENV=production` the API refuses to start unless
  `COOKIE_SECURE=true` and `APP_URL` uses https.
- **Health checks:** `/api/health` (API) and `/health` on the worker port. Both need the
  `X-Ops-Token` header, and the image's HEALTHCHECK uses them.
- **Monitoring:** Prometheus scrapes `/metrics` on both processes with `X-Ops-Token`. The alert
  rules are in [`ops/alerts.yml`](ops/alerts.yml).
- **Retention:** a daily job purges campaigns and messages 12 months after they end, live chat
  messages, journey entries and openings after 12 months (with unused customer media), and webhook
  events and uploaded files after 30 days. Audit logs are kept. Deleting a contact erases its chat
  content but keeps anonymous counts.
- **Live chat behind a proxy:** keep `/api/inbox/events` unbuffered and allow long-lived
  connections (the api sends `: ping` every 15 s).
- **Real numbers:** to connect a real WhatsApp number, follow quickstart §5. Check each step
  against Meta's current documentation.

## Documentation

- [Specification](specs/001-whatsapp-bulk-messaging/spec.md)
- [Implementation plan](specs/001-whatsapp-bulk-messaging/plan.md),
  [research](specs/001-whatsapp-bulk-messaging/research.md) and
  [data model](specs/001-whatsapp-bulk-messaging/data-model.md)
- API contracts:
  - [dashboard](specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml)
  - [public v1](specs/001-whatsapp-bulk-messaging/contracts/public-api.openapi.yaml)
- [Quickstart](specs/001-whatsapp-bulk-messaging/quickstart.md) and
  [tasks](specs/001-whatsapp-bulk-messaging/tasks.md)
- [Release checklist](specs/001-whatsapp-bulk-messaging/checklists/release.md)
- Live chat (feature 002): [spec](specs/002-team-inbox/spec.md), [plan](specs/002-team-inbox/plan.md),
  [research](specs/002-team-inbox/research.md), [data model](specs/002-team-inbox/data-model.md),
  [inbox API](specs/002-team-inbox/contracts/inbox-api.openapi.yaml),
  [live events](specs/002-team-inbox/contracts/realtime-events.md),
  [quickstart](specs/002-team-inbox/quickstart.md), [tasks](specs/002-team-inbox/tasks.md) and
  [release checklist](specs/002-team-inbox/checklists/release.md)
- Architecture decisions:
  - [ADR-0001 Frontend stack](history/adr/0001-frontend-stack.md)
  - [ADR-0002 Backend runtime, process model and monorepo](history/adr/0002-backend-runtime-process-model-and-monorepo.md)
  - [ADR-0003 Data, queue and storage](history/adr/0003-data-queue-and-storage-architecture.md)
  - [ADR-0004 Campaign delivery and webhooks](history/adr/0004-campaign-delivery-and-webhook-processing.md)
  - [ADR-0005 Security, access and API keys](history/adr/0005-security-access-and-api-key-architecture.md)
