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
| Chatbot flows (feature 003) | Automatic conversations built on a canvas: buttons, lists, questions that save answers to contacts, conditions, delays, safe API calls, hand-over to live chat, test numbers, versions, analytics and starter flows. See [Chatbot flows](#chatbot-flows). |
| AI agents (feature 004) | AI agents that answer customers from your own knowledge with Claude, hand over to the team when needed, use safe API skills and flows, stay within a monthly limit, and a team assistant that drafts templates, flows and campaigns. See [AI agents](#ai-agents). |

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

## Chatbot flows

Feature 003 ([spec](specs/003-chatbot-flow-builder/spec.md), [quickstart](specs/003-chatbot-flow-builder/quickstart.md)).

- **Build:** *Flows → New flow*, empty or from one of six starter flows written by us. Add steps from
  the left, connect a step's ways out to other steps on the canvas (or with the "goes to" lists in the
  step panel), copy and paste, and undo up to 20 changes. The draft saves itself a second after each
  change; the problems panel lists what blocks publishing.
- **Steps:** message (text or a media library file), buttons (up to 3), list (up to 10 options),
  question (text, number, email, phone or date, with retries and a timeout), tags, attributes,
  condition (attributes, answers, contact fields, tags, consent, working hours), delay (5 seconds to
  23 hours), API call, go to another flow, hand over to a person, and end.
- **Triggers:** keywords (exact or contains), patterns, quick-reply buttons of templates and
  first-message rules (a contact's very first message; they can also set the first-message tag).
  Order: first-message rules, exact keyword, contains keyword, pattern, template button. Opt-out,
  opt-in and "talk to a person" keywords never start a flow.
- **With live chat:** flows answer Open chats only. Taking a chat, replying or sending a template
  stops the flow; "talk to a person" and hand-over steps move the chat to *Waiting for agent*; STOP
  ends the flow without a reply. Members start a published flow from a chat with **Start a flow**
  while the 24-hour window is open.
- **Testing and versions:** up to three test numbers run the draft (marked "test", left out of
  analytics). Each publish makes a numbered version, and sessions finish on the version they started
  on. *Versions* lists published versions and the last 20 autosaves; restoring copies one into the
  draft.
- **Analytics:** the editor's *Analytics* mode shows results for today, 7 or 30 days, and per step how
  many entered, moved on or dropped, with counts per option and a CSV of the contacts who dropped.
- **API-step safety:** HTTPS only. Private, loopback, link-local, multicast and reserved addresses
  are refused, and every address a name resolves to is checked at connect time, so a name cannot
  lead into the company network; no redirects; a 1-10 second timeout; replies over 100 KB or not in
  JSON fail. Header secrets are stored encrypted, shown
  as •••• and never returned or logged. *Send test request* follows the same rules.
- **Permissions:** admins and managers build and publish (`flows.manage`); agents start flows from
  chats (`inbox.reply`).

Performance check (SC-001, a reply queued within 3 seconds for 95% of messages with 20 customers
writing at once): `PERF_NUMBER_ID=<id> npm run perf:flows` with the api and the worker running.

## AI agents

Feature 004 ([spec](specs/004-ai-agent/spec.md), [quickstart](specs/004-ai-agent/quickstart.md)).

- **Setup:** agents use Claude Opus 5.5 (`AI_MODEL=claude-opus-5-5`) through the company's Anthropic
  account. Put the key in `.env` as `ANTHROPIC_API_KEY` (a secret, billed per use). For local runs
  and tests, `ANTHROPIC_BASE_URL=http://localhost:4010/anthropic` uses mock-meta's fake model
  instead. Without either, agents fail closed: customers get the fallback message and wait for a
  person.
- **Build:** *AI agents → New agent*, empty or from one of four starter agents written by us (Sales
  enquiries, Customer support, Booking requests, Lead qualification). The editor's tabs set the goal,
  business details, tone, guardrails, reply languages and introductions, the knowledge, the skills,
  test numbers and versions. The draft saves itself; the problems panel lists what blocks
  publishing (for example a starter's example answers still marked "Replace me"). Publish, then
  choose the agent's numbers.
- **Knowledge:** written answers, website pages (HTTPS, robots.txt respected, optional weekly
  refresh) and PDF or Word files. Small knowledge goes into the prompt whole; larger knowledge is
  searched. Questions the agent could not answer collect under *Unanswered*, where a member answers
  them into the knowledge.
- **In live chat:** the number's agent answers Open chats in the 24-hour window, after flows and
  never in a chat a member took. It hands over (*Waiting for agent*, with a summary note) when the
  customer asks for a person, when a hand-over topic comes up, after too many replies or when the
  AI service fails. STOP opts the customer out. A banner shows when an agent is answering a chat.
- **Skills:** buttons and lists, files from the media library, remembering answers in contact
  attributes, safe API calls (the flows' safety rules; calls that change data need the customer's
  confirmation first; header secrets are stored encrypted) and starting flows. A flow's *Hand to AI
  agent* step passes a chat to an agent.
- **Testing and versions:** the *Test* tab is a preview chat that shows what a reply would do without
  sending anything; up to three test numbers talk to the draft. Each publish makes a numbered version
  that can be restored into the draft.
- **Usage and limits:** *AI usage* (admins) shows AI replies against the monthly limit (default
  1,000), test replies, the estimated cost from the measured tokens and your prices, per agent, per
  day and how AI conversations ended. Admins are alerted at 80% and 100%; at the limit new messages
  go to the team with an optional message to the customer.
- **Team assistant:** the header's *Assistant* (admins and managers) drafts templates (not
  submitted to Meta), flows (not published) and campaigns (not scheduled), and answers questions
  about campaign results. Anything that sends, schedules or deletes waits on a preview the member
  confirms within 30 minutes. It acts with the member's own permissions and has its own monthly
  limit (default 300).
- **Data handling:** a chat is sent to the AI service only for the turn being answered, and no
  conversation is kept open there between calls (no message threads). The provider's own retention
  terms still apply; zero data retention is a decision in the release checklist. Contact phone
  numbers are never sent to the model.
  Logs leave out prompts, knowledge, replies, summaries and remembered values. AI records follow the
  12-month retention, and deleting a contact erases its AI conversation details while keeping
  anonymous counts.
- **Permissions:** admins and managers build agents (`ai.manage`) and use the assistant
  (`assistant.use`); only admins see usage and change limits and prices (`ai.usage`).

Checks: `PERF_NUMBER_ID=<id> npm run perf:ai` (SC-001, an AI reply queued within 10 seconds for 95%
of messages with 50 customers writing at once, against the fake model). `npm run eval:ai` measures
answer quality with the real model (SC-002, SC-003, SC-005, SC-010). It costs money, so it runs only
by hand with `EVAL_CONFIRM=yes`, never in CI.

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
npm run perf:flows          # chatbot flows SC-001 (PERF_NUMBER_ID set)
npm run perf:ai             # AI agents SC-001 against the fake model (PERF_NUMBER_ID set)
npm run eval:ai             # AI answer quality with the real model: by hand only, EVAL_CONFIRM=yes
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
  events and uploaded files after 30 days. AI conversations, AI reply records, unanswered-question
  occurrences and assistant requests also go after 12 months. Audit logs are kept. Deleting a
  contact erases its chat content and AI conversation details but keeps anonymous counts.
- **AI service:** set `ANTHROPIC_API_KEY` from the company's Anthropic account (leave
  `ANTHROPIC_BASE_URL` empty in production). The `WbmAiFailing` alert fires when more than 20% of AI
  turns fail in 15 minutes.
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
- Chatbot flows (feature 003): [spec](specs/003-chatbot-flow-builder/spec.md),
  [plan](specs/003-chatbot-flow-builder/plan.md), [research](specs/003-chatbot-flow-builder/research.md),
  [data model](specs/003-chatbot-flow-builder/data-model.md),
  [flows API](specs/003-chatbot-flow-builder/contracts/flows-api.openapi.yaml),
  [flow graph](specs/003-chatbot-flow-builder/contracts/flow-graph.md),
  [quickstart](specs/003-chatbot-flow-builder/quickstart.md), [tasks](specs/003-chatbot-flow-builder/tasks.md) and
  [release checklist](specs/003-chatbot-flow-builder/checklists/release.md)
- AI agents (feature 004): [spec](specs/004-ai-agent/spec.md), [plan](specs/004-ai-agent/plan.md),
  [research](specs/004-ai-agent/research.md), [data model](specs/004-ai-agent/data-model.md),
  [AI API](specs/004-ai-agent/contracts/ai-api.openapi.yaml),
  [agent configuration](specs/004-ai-agent/contracts/agent-config.md),
  [Claude messages](specs/004-ai-agent/contracts/claude-messages.md),
  [quickstart](specs/004-ai-agent/quickstart.md), [tasks](specs/004-ai-agent/tasks.md) and
  [release checklist](specs/004-ai-agent/checklists/release.md)
- Architecture decisions:
  - [ADR-0001 Frontend stack](history/adr/0001-frontend-stack.md)
  - [ADR-0002 Backend runtime, process model and monorepo](history/adr/0002-backend-runtime-process-model-and-monorepo.md)
  - [ADR-0003 Data, queue and storage](history/adr/0003-data-queue-and-storage-architecture.md)
  - [ADR-0004 Campaign delivery and webhooks](history/adr/0004-campaign-delivery-and-webhook-processing.md)
  - [ADR-0005 Security, access and API keys](history/adr/0005-security-access-and-api-key-architecture.md)
