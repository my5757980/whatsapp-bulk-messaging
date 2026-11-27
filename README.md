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
| Campaign growth (feature 005) | Tracked links with a click count for each recipient, retargeting by clicked, replied and held back, retry rounds for failures that may pass, and drips: timed template steps that contacts join by hand or on events and leave when they reply. See [Campaign growth](#campaign-growth). |
| Integrations (feature 006) | Signed webhooks for other systems, API key permissions and a contacts API, API campaigns, Shopify and WooCommerce order notifications, COD confirmation and cart reminders, QR chat links, and a guided number connection wizard. See [Integrations](#integrations). |
| Ads (feature 007) | Click-to-WhatsApp, lead form and website ads from the company's own Meta ad account: a connection with checks, a guided builder with AI texts, Meta's review, chats from ads with the free window, flows and tags, hourly results with cost per chat, a monthly spending cap, audiences from contacts and lookalikes, and lead forms that become contacts. See [Ads](#ads). |
| Commerce and payments (feature 008) | Stripe payment links from live chat, flows, campaigns, the API and store orders, with live statuses, reminders, a payments page and retargeting of non-payers; the Meta catalog with product, list and catalog messages; carts in chat that become orders with a payment link; WhatsApp Forms; and product, catalog, form and payment steps in flows. See [Commerce and payments](#commerce-and-payments). |

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

## Campaign growth

Feature 005 ([spec](specs/005-campaign-growth/spec.md), [quickstart](specs/005-campaign-growth/quickstart.md)).

- **Tracked links:** set `PUBLIC_LINK_BASE_URL` to an https address on the company's own domain,
  for example `https://go.company.example/l`. Each recipient gets their own link
  `<address>/<code>`; the api answers it at `/l/<code>` and sends the visitor straight on to the
  destination. **When the address has no `/l` path** (for example `https://go.company.example`),
  the reverse proxy must send `/<code>` to the api's `/l/<code>`. Leave the setting empty to turn
  tracking off. A template's tracked button is made with *Tracked link button* (its address is
  `<address>/{{1}}`, approved by Meta once); a text variable can carry a full tracked link too.
- **Clicks:** previews, robots and HEAD requests are sent on but not counted. The visitor's address
  is never stored; only a salted hash of it counts towards the limit of 120 opens a minute.
  *Results → Clicked* lists who clicked, with first and last clicks and how often, and exports
  them. Clicks also show in the contact's journey and in live chat.
- **Retargeting:** a campaign's *Retarget* shows the size of each group: failed, not read, read,
  delivered, clicked, not clicked, replied (wrote to the campaign's number within 3 days of
  delivery), not replied and held back (Meta error 131049, its limit on marketing messages per
  person). The retarget is a draft that names its source and group; its audience is taken at
  launch, without opted-out contacts.
- **Retries:** a campaign can retry failures that may pass, in up to 3 rounds with delays of
  30 minutes to 12 hours, all within 24 hours of launch. Only temporary errors are retried, never
  held-back messages or numbers that cannot receive WhatsApp. The campaign stays running while
  rounds are pending. *Campaigns → Scheduled retries* lists the rounds, which can be cancelled; a
  round past 24 hours, with a paused template or a disconnected number is skipped with a note.
- **Drips:** *Drips → New drip* builds up to 10 template steps on one number, each after a wait
  (the first step may send at once; later waits are 10 minutes to 30 days), with optional quiet
  hours in the company time zone. Contacts join by hand (chosen or by filter) or on starting
  events: a tag added, an opt-in, an import or the public API adding them, or a click on a
  campaign's link. They leave when they reply (on by default), click a drip's link (optional), get
  a stop tag, opt out, are blocked or deleted, or their number cannot receive WhatsApp; they rejoin
  only when the drip allows it. Marketing steps skip contacts without an opt-in. A drip pauses
  itself and alerts admins and managers when a step's template is no longer approved or its number
  disconnects. Up to 20 active drips, each with up to 100,000 contacts in it.
- **Results:** a drip's *Results* shows the contacts in it, finished and left by reason, and per
  step sent, delivered, read, clicked, replied, failed and skipped. Each number opens the contacts
  behind it, with an export.
- **Permissions:** the campaign permissions apply. Managers and admins build drips, tracked links
  and retry plans (`campaigns.manage`) and run them (`campaigns.launch`); agents see results with
  masked phone numbers (`campaigns.view`); exports need `data.export`.
- **Data handling:** clicks are kept 12 months, and enrolments 12 months after they end. Tracked
  links go with their messages, so purged messages' links stop working. Deleting a contact ends
  their drips and keeps their clicks and enrolments only as anonymous counts. Logs leave out link
  codes and destinations.

Check: `PERF_NUMBER_ID=<id> npm run perf:drips` (SC-005: 95% of drip steps queued within 5 minutes
of falling due, with 10,000 contacts in a drip).

## Integrations

Feature 006 ([spec](specs/006-integrations-platform/spec.md), [quickstart](specs/006-integrations-platform/quickstart.md)).

- **Outbound webhooks:** *Settings → Webhooks* adds endpoints that receive chosen events (message
  statuses, customer messages, contact and tag changes, opt-ins and opt-outs, API campaign calls,
  store notifications, COD answers and recovered carts). Deliveries follow the Standard Webhooks
  format: headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature`, which
  is `v1,<base64 HMAC-SHA256>` of `{id}.{timestamp}.{raw body}` keyed with the endpoint's secret
  (`whsec_…`, shown once). Receivers should accept timestamps within 5 minutes and ignore ids they
  have seen. After a secret is renewed, both secrets sign for 24 hours. Failed deliveries are
  retried with growing waits; an endpoint that keeps failing is paused and admins are alerted. The
  delivery log shows each attempt and can send one again.
- **API key permissions:** each key has permissions: `messages.send` (keys made before 006 keep only
  this one), `contacts.read`, `contacts.write`, `campaigns.trigger` and `drips.enrol`. A call
  without the permission gets 403 `insufficient_scope`. The contacts API (`/api/v1/contacts`) finds,
  creates, updates and tags contacts and records consent; changes show in the journey as the key's.
- **API campaigns:** *Campaigns → API campaigns* saves a template, its variable mapping, tags,
  attributes and a daily limit under an API name. Other systems send it with one call to
  `POST /api/v1/api-campaigns/{apiName}/messages` (a phone number and a few values). A campaign
  pauses itself when its template is no longer approved or its number disconnects.
- **Shopify:** since 2026 a store owner's own app is made in Shopify's Dev Dashboard. Give it the
  scopes `read_orders`, `write_orders` and `read_customers`, and declare protected customer data
  (name, email, phone and address). In *Integrations → Stores* connect the store with the app's
  client id and secret: the platform gets 24-hour tokens with the client credentials grant and makes
  its own webhook subscriptions (orders, fulfillments and checkouts) to
  `${APP_URL}/api/integrations/shopify/{storeId}/webhooks`. Each delivery is checked with
  `X-Shopify-Hmac-Sha256` and counted once by its webhook id. `SHOPIFY_API_VERSION` pins the
  GraphQL Admin API version.
- **WooCommerce:** make Read/Write REST API keys in *WooCommerce → Settings → Advanced → REST API*;
  the store must use https. The platform makes its own `order.created` and `order.updated` webhooks
  with a secret per store and checks `X-WC-Webhook-Signature`.
- **Store automations:** order confirmed, shipped, delivered and cancelled notifications (utility
  templates), cash on delivery confirmation with quick-reply buttons (the first answer wins; the
  order is tagged in the store, and cancelled there when automatic cancel is on), and up to three
  cart reminders (marketing templates, only to contacts who opted in; Shopify checkouts, and
  WooCommerce orders left unpaid). The store's checkout consent counts as a WhatsApp opt-in only
  after an admin confirms that its text names WhatsApp. A 15-minute check repairs webhooks and
  fetches orders that were missed.
- **Chat links and QR codes:** *Campaigns → Chat links* makes a short link on
  `PUBLIC_LINK_BASE_URL` (`<address>/c/<code>`, answered by the api at `/l/c/<code>`), QR codes as
  PNG and SVG and a printable poster. Opening the link opens WhatsApp with the pre-filled message,
  which ends with a short reference such as `(ref K7QX2M)`. When the customer sends it, the chat
  counts as started for the link, the contact gets the link's tag and the link's flow starts (never
  over a running flow or a member's chat). A turned-off or deleted link shows a "no longer in use"
  page.
- **Number connection wizard:** *Settings → WhatsApp numbers → Connect with checks* takes a
  system user token, lists the WhatsApp accounts and numbers it reaches, and checks the token's
  permissions and expiry, the number's registration and two-step PIN, the display name, quality,
  messaging limit, the app subscription and the app's webhook address (with `META_APP_ID` set),
  each with a fix. It can register the number with its PIN and subscribe the app when the admin
  asks, then sends a test template to the admin's phone and waits for its delivered status. The
  pasted token is kept encrypted for 30 minutes only. *Run checks* runs the same checks on a
  connected number without changing it.
- **Permissions:** only admins manage webhook endpoints, key permissions, stores and the wizard
  (`integrations.manage`, `numbers.manage`); managers and admins run API campaigns, store
  automations and chat links (`campaigns.manage`); exports need `data.export`.
- **Data handling:** outbound events and their deliveries, and raw store events, are kept 30 days;
  API campaign calls, store orders and their messages, carts and reminders, chat link openings and
  starts, and wizard check results 12 months. Deleting a contact stops their cart reminders, closes
  their COD questions, keeps orders, calls and chat starts without their details, and cancels
  waiting webhook deliveries that name them. Tokens, keys and secrets are stored encrypted and never
  sent in events or logs.

Checks: `npm run perf:webhooks` (SC-001: 99% of events delivered within 10 seconds) and
`PERF_NUMBER_ID=<id> npm run perf:stores` (SC-004: 500 store events with 100 repeats, exactly one
notification per order, 95% within a minute).

## Ads

Feature 007 ([spec](specs/007-ads-manager/spec.md), [quickstart](specs/007-ads-manager/quickstart.md)).

- **Meta app and token:** the company's Meta app needs the permissions `ads_management`, `ads_read`,
  `business_management`, `pages_show_list` and `pages_read_engagement`; lead ads also need
  `pages_manage_ads`, `pages_manage_metadata` and `leads_retrieval` (which may need Meta's App
  Review), and the pre-filled chat message needs `whatsapp_business_management`. In Business Settings,
  give a system user the ad account and the Facebook page and generate a token that never expires.
- **Connection:** *Ads → Ad account* takes the token (kept encrypted for 30 minutes while you choose),
  lists the ad accounts and pages it reaches, and checks the token's permissions, the account's status,
  payment method and currency, the page's ads access and linked WhatsApp numbers, and the custom
  audience and lead terms, each with a fix. Only one ad account and page are connected; the token and
  page token are stored encrypted and never returned. A check that fails later sets the connection to
  *Needs attention*, holds changes at Meta and alerts admins.
- **Building and launching:** *Ads → New ad* builds a campaign for chats, leads or website visits:
  the WhatsApp number and pre-filled message (chats), the audience (Meta's places and interests, ages,
  gender, saved audiences, special ad categories), placements (automatic, or chosen, including
  WhatsApp Status for chat ads), the daily budget (at least Meta's minimum, in the account's
  currency), dates, and up to five versions with an image or video from the media library. *Write
  with AI* drafts the texts. Submitting makes the campaign, one ad set and one ad per version at
  Meta; a failure part way removes what was made. Meta's review is read right after a submit and
  every 5 minutes; a rejected version shows Meta's reason and can be edited and submitted again.
- **Chats from ads:** a customer message from a Click-to-WhatsApp ad carries the ad (Meta's
  `referral`): live chat shows the ad and Meta's free entry point window ("Free ad window until …",
  72 hours from the first reply when it comes within 24 hours, `ADS_FREE_WINDOW_HOURS`; information
  only), the journey records the chat, the contact gets the campaign's tag, and the campaign's flow
  answers first (never over a running flow or a member's chat). The flow builder's *Ads* card chooses
  the campaigns of a flow. Chats from ads made in Meta's tools are listed under *Other ads*.
- **Results and the cap:** Meta's numbers are read every hour (and the last 28 days once a day) per
  day and version, next to the platform's own: chats started, new contacts, contacts who replied,
  leads, website visits, and cost per chat and per lead; results export as CSV. A monthly spending cap
  refuses launches, resumes and budget increases that could pass it, and pauses every platform
  campaign once when the month's spend reaches it. Pause, resume, end, budget and end date changes
  and duplicates go to Meta at once; changes made in Meta's tools show at the next read.
- **Audiences:** *Ads → Audiences* sends contacts from a tag, a contact filter or a campaign group to
  Meta as SHA-256 hashes of their phone numbers only (opted-out and blocked contacts never), updated
  once a day with the difference; audiences under 100 people are not offered. Lookalikes take a
  country and a size (1–10%).
- **Lead forms:** *Ads → Lead forms* makes forms at Meta with the page token: name, phone, email and
  up to three own questions, a privacy link and an unticked checkbox that names WhatsApp. Leads arrive
  as page webhooks on the same signed `/api/webhooks/meta` route (subscribe the app to the page's
  `leadgen` field; the form does this) and are read again every 15 minutes in case one was missed.
  Each lead becomes a contact with the form's tag; only a ticked checkbox opts it in (source
  `LEAD_FORM`) and sends the form's welcome template, once.
- **Website ads:** the ad links to `<PUBLIC_LINK_BASE_URL>/a/<code>` (answered by the api at
  `/l/a/<code>`), which counts visits (not previews or robots, with the tracked links' rate limit)
  and sends the visitor on with `utm_source=meta&utm_medium=paid&utm_campaign=<name>`.
- **Permissions:** only admins connect the ad account and set the cap (`integrations.manage`);
  managers and admins build ads, audiences and lead forms (`campaigns.manage`) and submit, pause,
  resume, end and change budgets (`campaigns.launch`); agents see ads, results and leads with phones
  masked; exports need `data.export`.
- **Data handling:** Meta's daily numbers are kept 25 months; leads, chats from ads and website visits
  12 months. Deleting a contact clears their leads' answers and phone, keeps chats from ads without
  them, and removes their hash from saved audiences at the next update (queued at once). New events
  for outbound webhooks: `ad.chat_started` and `ad.lead_received` (lead answers are not sent).
- **Monitoring:** `wbm_ads_sync_total{job,result}`, `wbm_ad_chat_starts_total{matched}`,
  `wbm_ad_leads_total{result}` and `wbm_ads_spend_cap_pauses_total`; the alert `WbmAdsSyncFailing`
  fires when more than half of the reads from Meta fail for 30 minutes.

## Commerce and payments

Feature 008 ([spec](specs/008-commerce-payments/spec.md), [quickstart](specs/008-commerce-payments/quickstart.md)).
Meta's own WhatsApp Payments is not offered in the UAE, so customers pay through Stripe payment
links. Card details are typed on Stripe's page and never reach the platform.

- **Stripe connection:** in the company's Stripe account (UAE, AED, charges enabled), create a
  restricted key with *Checkout Sessions: Write*, *Events: Read*, account details read and, for
  automatic registration, *Webhook Endpoints: Write* ([contracts/stripe.md](specs/008-commerce-payments/contracts/stripe.md)).
  Paste it on *Payments → Stripe connection* (admins only). The key is stored encrypted and never
  shown again; keys never go in `.env`. The checks cover the key, its permissions, the account's
  charges and currency, and test or live mode. *Register the notification address for me* creates
  Stripe's endpoint for `${APP_URL}/api/payments/stripe/webhook` with the six events
  (`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `payment_intent.payment_failed` and `charge.refunded`); otherwise register it by hand and paste
  its signing secret. *Test notifications* proves that signed notifications arrive.
- **Payment requests:** an amount in AED, a description, an optional order reference and an expiry
  (24 hours by default, 30 minutes to 30 days), up to the maximum amount in *Payments → Settings*.
  The customer gets `<PUBLIC_LINK_BASE_URL>/p/<code>` (answered by the api at `/l/p/<code>`),
  which opens Stripe Checkout; a link opened after Stripe's 24-hour session limit gets a new
  session. Requests come from:
  - **live chat:** *Request payment* in an open chat (for the roles chosen in the settings), shown
    in the chat as a card with its status
  - **flows:** the *Request payment* step with a fixed amount, an answer, an attribute or the cart
    total, with paid and not paid branches; test numbers use *Mark paid (test)* in the test panel
  - **campaigns:** a payment template with a URL button `…/p/{{1}}`; each recipient gets their own
    link
  - **the API:** `POST /api/v1/payments` with an `Idempotency-Key` and a key with
    `payments.write` (`payments.read` lists and reads requests)
  - **store orders:** the store automation *Pay link* sends a link for unpaid Shopify or WooCommerce
    orders and marks the order paid in the store (Shopify needs `write_orders`)
- **Statuses:** Stripe's signed notifications set paid, failed attempt, expired and refunded (in full
  or in part), once each and in any order. A reconciler reads Stripe's event list every 15 minutes in
  case one was missed, and a 60-second tick expires links with their Stripe sessions. A payment that
  arrives after expiry or cancel shows as *Paid late* and admins and managers are told. The agent who
  asked is notified, and the contact's *Payments* tab and the journey list each request. Requests
  made in Stripe's test mode are marked and left out of totals.
- **Reminders and reports:** up to two reminders per request, hours before the link expires, with
  an approved template (sent only when the first message was delivered). *Payments* shows totals by
  status, day and source, with filters and a CSV export; a payment campaign can be retargeted to its
  *Paid* or *Not paid* group.
- **Catalog:** *Catalog* connects the WhatsApp account's Meta catalog (made in Commerce Manager and
  linked in WhatsApp Manager; the system user token needs `catalog_management`), copies its
  products every hour or on *Copy products now*, and sets each number's commerce settings (cart on,
  catalog visible). The catalog can also be filled every hour from a connected Shopify
  (`read_products`) or WooCommerce store through Meta's `items_batch`. Live chat sends one
  product, a list of up to 30 products in up to 10 sections, or the whole catalog, and templates can
  carry catalog and multi-product buttons.
- **Carts and chat orders:** a cart sent in chat becomes a chat order with its items, total and
  warnings (a product not in the catalog, a changed price, another currency). In automatic mode the
  payment link goes out within a minute; in review mode an agent edits the order and sends the link;
  a flow waiting for a cart takes it instead. Orders show in the chat, on the contact and in the
  order list, and follow their payment.
- **WhatsApp Forms:** *Forms* builds forms of up to 10 screens (short and long text, email, phone,
  number, single and multiple choice, dropdown, date and an opt-in), maps fields to contact attributes
  and adds tags. Publishing compiles Meta's Flow JSON and publishes a numbered version to every
  connected WhatsApp account (Meta may ask for business verification first). A published form is
  archived rather than deleted, and not while a flow uses it. Forms are sent from live chat, flows
  and templates (flow buttons) with a signed token, so only answers to the platform's own sends
  count. Answers are checked by field type, saved to attributes and tags, opt the contact in (source
  `FORM`) only when the opt-in is ticked, and show in the journey and on the form's answers page,
  with a CSV export.
- **Flow steps:** *Send products* and *Send catalog* wait for a cart (saved as `{answer:cart_total}`
  and charged by *Request payment* with the cart total); *Send form* waits for the answers (saved as
  `{answer:<prefix>_<field>}`). Each has a timeout branch. Publishing a flow needs the catalog
  connected and its forms published.
- **Permissions:** only admins connect Stripe and the catalog (`integrations.manage`) and change the
  payment settings (`payments.manage`); managers and admins see payments and build forms
  (`payments.view`, `forms.manage`); agents request payments, send products and forms and handle
  chat orders in their chats (`inbox.reply`); exports need `data.export`.
- **Data handling:** payment requests and chat orders are kept 5 years, Stripe notifications 30 days
  (stored without card or customer details), form answers 12 months, and removed catalog products 90
  days. Deleting a contact cancels their waiting links, keeps requests and orders without their name
  or phone, and deletes their form answers. New events for outbound webhooks: `payment.requested`,
  `payment.paid`, `payment.failed`, `payment.expired`, `payment.cancelled`,
  `payment.refunded`, `chat_order.received`, `chat_order.paid` and `form.submitted`.
- **Monitoring:** `wbm_payment_links_total{result}`, `wbm_payment_events_total{type,result,source}`,
  `wbm_payments_total{status}`, `wbm_chat_orders_total{mode}`, `wbm_form_answers_total{result}` and
  `wbm_catalog_sync_total{job,result}`. The alert `WbmPaymentLinksFailing` fires when more than half
  of the links fail in 15 minutes, and `WbmPaymentNotificationsMissing` when the reconciler finds
  missed payments or no notification arrives in 24 hours while links are being made.

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
npm run perf:drips          # drips SC-005 with 10,000 contacts (PERF_NUMBER_ID set)
npm run perf:webhooks       # webhooks SC-001: 99% of events delivered within 10 s
npm run perf:stores         # stores SC-004: 500 events, 100 repeats, one notification each (PERF_NUMBER_ID set)
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
  occurrences and assistant requests also go after 12 months, and so do link clicks and drip
  enrolments (12 months after they end). Integration records follow the rules in
  [Integrations](#integrations), and commerce records those in
  [Commerce and payments](#commerce-and-payments). Audit logs are kept. Deleting a contact erases its chat content and
  AI conversation details but keeps anonymous counts.
- **AI service:** set `ANTHROPIC_API_KEY` from the company's Anthropic account (leave
  `ANTHROPIC_BASE_URL` empty in production). The `WbmAiFailing` alert fires when more than 20% of AI
  turns fail in 15 minutes.
- **Live chat behind a proxy:** keep `/api/inbox/events` unbuffered and allow long-lived
  connections (the api sends `: ping` every 15 s).
- **Tracked links:** `PUBLIC_LINK_BASE_URL` must be public https on the company's domain. When it
  has no `/l` path, the reverse proxy sends `/<code>` to the api's `/l/<code>`. The
  `WbmDripLagging` alert fires when drip steps are queued more than 5 minutes after falling due
  (p95, for 15 minutes).
- **Integrations:** `APP_URL` must be the public https address that Shopify, WooCommerce and Meta
  reach. The `WbmWebhookBacklog` alert fires when deliveries to active endpoints stay due for more
  than 5 minutes (for 15 minutes), and `WbmStoreEventsFailing` when over 20% of store events fail
  in 15 minutes. Before go-live, work through
  [the 006 release checklist](specs/006-integrations-platform/checklists/release.md).
- **Payments:** Stripe posts to `${APP_URL}/api/payments/stripe/webhook`, and pay links use
  `PUBLIC_LINK_BASE_URL` (`/p/<code>` goes to the api's `/l/p/<code>`). Leave `STRIPE_API_BASE_URL`
  unset in production; `STRIPE_API_VERSION` is upgraded on purpose. Before go-live, work through
  [the 008 release checklist](specs/008-commerce-payments/checklists/release.md).
- **Real numbers:** to connect a real WhatsApp number, use *Connect with checks* or follow
  quickstart §5. Check each step against Meta's current documentation.

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
- Campaign growth (feature 005): [spec](specs/005-campaign-growth/spec.md),
  [plan](specs/005-campaign-growth/plan.md), [research](specs/005-campaign-growth/research.md),
  [data model](specs/005-campaign-growth/data-model.md),
  [growth API](specs/005-campaign-growth/contracts/growth-api.openapi.yaml),
  [quickstart](specs/005-campaign-growth/quickstart.md), [tasks](specs/005-campaign-growth/tasks.md) and
  [release checklist](specs/005-campaign-growth/checklists/release.md)
- Integrations (feature 006): [spec](specs/006-integrations-platform/spec.md),
  [plan](specs/006-integrations-platform/plan.md), [research](specs/006-integrations-platform/research.md),
  [data model](specs/006-integrations-platform/data-model.md),
  [integrations API](specs/006-integrations-platform/contracts/integrations-api.openapi.yaml),
  [public API v1](specs/006-integrations-platform/contracts/public-api-v1.openapi.yaml),
  [webhook events](specs/006-integrations-platform/contracts/webhook-events.md),
  [quickstart](specs/006-integrations-platform/quickstart.md), [tasks](specs/006-integrations-platform/tasks.md) and
  [release checklist](specs/006-integrations-platform/checklists/release.md)
- Ads (feature 007): [spec](specs/007-ads-manager/spec.md), [plan](specs/007-ads-manager/plan.md),
  [research](specs/007-ads-manager/research.md), [data model](specs/007-ads-manager/data-model.md),
  [ads API](specs/007-ads-manager/contracts/ads-api.openapi.yaml),
  [Meta ads Graph calls](specs/007-ads-manager/contracts/meta-ads-graph.md),
  [quickstart](specs/007-ads-manager/quickstart.md), [tasks](specs/007-ads-manager/tasks.md) and
  [release checklist](specs/007-ads-manager/checklists/release.md)
- Commerce and payments (feature 008): [spec](specs/008-commerce-payments/spec.md),
  [plan](specs/008-commerce-payments/plan.md), [research](specs/008-commerce-payments/research.md),
  [data model](specs/008-commerce-payments/data-model.md),
  [commerce API](specs/008-commerce-payments/contracts/commerce-api.openapi.yaml),
  [payments API v1](specs/008-commerce-payments/contracts/public-payments-v1.openapi.yaml),
  [Stripe calls](specs/008-commerce-payments/contracts/stripe.md),
  [Meta commerce Graph calls](specs/008-commerce-payments/contracts/meta-commerce-graph.md),
  [quickstart](specs/008-commerce-payments/quickstart.md), [tasks](specs/008-commerce-payments/tasks.md) and
  [release checklist](specs/008-commerce-payments/checklists/release.md)
- Architecture decisions:
  - [ADR-0001 Frontend stack](history/adr/0001-frontend-stack.md)
  - [ADR-0002 Backend runtime, process model and monorepo](history/adr/0002-backend-runtime-process-model-and-monorepo.md)
  - [ADR-0003 Data, queue and storage](history/adr/0003-data-queue-and-storage-architecture.md)
  - [ADR-0004 Campaign delivery and webhooks](history/adr/0004-campaign-delivery-and-webhook-processing.md)
  - [ADR-0005 Security, access and API keys](history/adr/0005-security-access-and-api-key-architecture.md)
