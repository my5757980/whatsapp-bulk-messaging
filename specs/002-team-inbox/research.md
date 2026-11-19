# Research: Live Chat (Shared Team Inbox)

**Feature**: `002-team-inbox` | **Date**: 2026-11-19 | **Plan**: [plan.md](./plan.md)

This feature builds on the decisions of feature 001: NestJS 12 api and worker, Next.js 16 web,
PostgreSQL with Prisma 7.10, Redis 7 with BullMQ 6.7, S3/MinIO, and Graph API v27.0 (see
`specs/001-whatsapp-bulk-messaging/research.md` and ADR-0001 to ADR-0005). Only the new questions
are answered here. "Verify" marks facts to re-check against Meta's current docs during
implementation.

## R1. Real-time updates to the browser

- **Decision:** **Server-Sent Events**.
  - **Endpoint:** `GET /api/inbox/events` (`text/event-stream`), served by the api through the
    existing Next.js `/api/*` proxy. It is same-origin, authenticated by the session cookie, and
    needs no CSRF because it is a GET.
  - **Fan-out:** every inbox change is appended to a Redis Stream `wbm:inbox:events` (`XADD`,
    `MAXLEN ~ 20000`, about a day at expected volume). Each api instance tails the stream once
    (`XREAD BLOCK`) and fans out to its open connections.
  - **Resume:** the stream entry ID is the SSE `id:`. On reconnect, `Last-Event-ID` replays the
    missed entries, so there are no gaps (FR-009). If the ID has been trimmed, the server sends
    `event: resync`, and the client refetches its lists.
  - **Server-side filtering:** each event carries denormalised visibility data (state,
    intervened-by, number, contact ID). The connection checks it against the user's role, agent
    rules and blocked status before writing (FR-026–FR-029). Contact tags and attributes for
    agent rules come from a 30-second per-instance cache, invalidated by `contact.updated` events.
  - **Previews:** phone numbers are masked server-side for agents.
  - **Proxy safety:** headers `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, a
    `: ping` comment every 15 s, and no compression on this route.
- **Rationale:**
  - It is one-way server → client, which is all the inbox needs; actions stay ordinary REST calls.
  - It works through the existing first-party proxy (ADR-0005) without exposing the api origin.
  - A Redis Stream gives ordering and replay. Plain Pub/Sub would lose events during reconnects.
- **Alternatives considered:**
  - **Socket.IO / WebSockets:** Next.js rewrites cannot proxy WebSocket upgrades, so the api origin
    would have to be exposed, with cross-origin cookies and a second auth path. Bidirectional is
    not needed.
  - **Polling every 2 s:** 20 users × several tabs means constant load, and it barely meets SC-001.
  - **Hosted pub/sub (Pusher, Ably):** a new vendor plus personal data leaving our infrastructure.
- **Risk:** some proxies buffer SSE. The headers above and an e2e check in dev, standalone and
  Docker mitigate it.

## R2. Where chat messages live

- **Decision:**
  - **New tables** `conversations`, `chat_messages`, `conversation_events` and
    `conversation_openings`.
  - **`chat_messages`** holds inbound messages, free-form session replies, internal notes and
    **reference rows** (`kind = MESSAGE_REF`). A reference points to a `messages` row: a campaign,
    API or inbox-template send. One table therefore orders and pages the whole timeline. Ticks for
    reference rows are read from `messages` through the join.
  - **Template sends from the inbox** reuse `messages` with the new origin `INBOX`, so cost, consent
    checks, retries and reports keep working.
- **Rationale:** feature 001's campaign pipeline stays untouched: dispatcher, the
  `(campaign_id, contact_id)` uniqueness, reports and retention. Timeline queries stay
  single-table with keyset pagination on `(conversation_id, occurred_at, id)`.
- **Alternatives considered:**
  - **Generalising `messages`** (direction, free-form types, nullable template): touches every 001
    code path and the campaign uniqueness rule. High regression risk.
  - **A SQL UNION view** of messages and chat items: keyset pagination over a union is fragile and
    slow at 5,000+ messages.

## R3. Sending free-form replies

- **Decision:**
  - **Queue:** the job named `session` goes on the number's existing send queue
    (`send-{numberId}`) with **BullMQ priority 1**. Campaign jobs get priority 10 explicitly. Replies
    jump ahead of a running broadcast but stay under the per-number rate limit (Principle IV).
  - **The session processor** mirrors the campaign send rules:
    - claim-before-send (`QUEUED → SENDING` conditional update)
    - re-check the 24-hour window and the number's status at send time
    - retry transient errors only, with the same backoff
    - treat an ambiguous network outcome as FAILED, never resent
  - **Graph payloads:**
    - text: `{type:"text", text:{body, preview_url:true}}`
    - media: `{type:"image"|"video"|"audio"|"document", <type>:{id | link, caption?, filename?}}`
    - Media IDs come from `MediaService.ensureMetaMediaId` (uploaded once per number, reused).
- **Rationale:** a single limiter per number avoids Meta 130429 throttling, and priority keeps
  live chat responsive during large campaigns.
- **Alternatives considered:**
  - **A separate inbox queue per number:** two limiters would together exceed the number's rate.
  - **Sending inline from the HTTP request:** violates Principle IV (queue-only sending).

## R4. Inbound media

- **Decision:**
  - **On arrival:** the inbound handler stores the `chat_messages` row with `media_state =
    PENDING` and enqueues `inbound-media` on the `webhooks` queue.
  - **The job:**
    1. `GET /{media-id}` with the number's token returns `{url, mime_type, file_size, sha256}`.
    2. It downloads the URL with the same `Authorization` header (URLs are short-lived; verify the
       TTL, currently about 5 minutes).
    3. It streams the file to S3 under `media/inbound/{uuid}`, creates a `media_assets` row (purpose
       `INBOUND`) and sets `media_state = READY`.
  - **Failures:** 3 attempts with backoff, then `media_state = FAILED`, shown as "media unavailable".
  - **Size cap:** 100 MB (Meta's document maximum).
  - **Delivery:** media is served to the browser through an authenticated api route, never by
    exposing S3 URLs (same model as 001).
- **Rationale:** WhatsApp media links expire, so the platform must keep its own copy (FR-003).
  Asynchronous download keeps webhook processing fast.
- **Alternatives considered:** proxying Meta's URL at view time breaks after expiry and needs
  Meta access for every view.

## R5. The 24-hour window, History and auto-resolve

- **Decision:**
  - **Window:** `conversations.last_customer_message_at` defines the window. "Live" means it is
    within 24 h; **History is derived**, with no state change, so it is exact by construction
    (FR-006). The live state (`ACTIVE | REQUESTING | INTERVENED`) is kept separately.
  - **Window-close events:** a `maintenance` job, `inbox-window`, runs every 60 s. It publishes
    `conversation.window_closed` for chats whose 24-hour mark fell in the last minute, so open
    UIs move them (SC-005 ≤ 1 min).
  - **Auto-resolve:** a job, `inbox-autoresolve`, runs every 5 min. When the setting is on, it
    resolves `INTERVENED` chats whose `last_activity_at` is older than 24 h.
  - **A customer message after the window closed:**
    - an `INTERVENED` chat that was not auto-resolved stays with the same member (US3-AS4)
    - otherwise the state becomes `ACTIVE`
    - in both cases a new **opening** starts (R14)
- **Rationale:** a derived window cannot drift. The jobs exist only for notifications and the
  optional auto-resolve.

## R6. Concurrent "take chat" (Intervene)

- **Decision:** a single conditional update:
  `UPDATE conversations SET state='INTERVENED', intervened_by_id=$me, intervened_at=now() WHERE id=$id AND state IN ('ACTIVE','REQUESTING') RETURNING *`.
  - With 0 rows, the api returns 409 `ALREADY_TAKEN` with the current owner (SC-007).
  - Transfer and resolve use the same pattern, guarded on `state='INTERVENED'` and the expected
    owner.
  - Replying in an unowned chat runs the same update first (FR-020).
- **Rationale:** database-enforced exclusivity, with no locks held across requests.

## R7. Visibility and agent rules in queries

- **Decision:**
  - **Admins and managers:** no filter.
  - **Agents:** `(state IN ('ACTIVE','REQUESTING') AND <rule match>) OR intervened_by_id = me`, plus
    History rows they may see under the same rule match.
  - **Rule match:** true when the agent has no rules. Otherwise `EXISTS` a tag rule matched through
    `contact_tags`, `OR` an attribute rule `contacts.attributes ->> key = value` (the GIN index from
    001 covers `@>` containment; rules compile to `attributes @> '{"key":"value"}'`).
  - **Blocked contacts** are excluded from live lists for everyone, and shown with a badge in
    History search.
  - **Indexes:** `conversations (state, last_activity_at DESC)`, `(intervened_by_id)`,
    `(number_id, last_activity_at DESC)`, `(last_customer_message_at)`.
  - The same predicate builder serves REST lists, single-chat access checks (404 when not
    visible) and SSE filtering (R1).
- **Rationale:** one implementation of the rules guarantees SC-008 everywhere.

## R8. Unread counts

- **Decision:**
  - `chat_read_markers (user_id, conversation_id, last_read_at)`, upserted when a chat is opened
    or scrolled to the bottom.
  - `conversations.last_inbound_at` is denormalised.
  - **Per-chat unread:** count of inbound `chat_messages` after the marker, capped at 99 in lists.
  - **Navigation badge:** the number of visible chats with `last_inbound_at > marker`, cached per
    user for 10 s and bumped by SSE events.
- **Rationale:** cheap, indexed counts (`chat_messages (conversation_id, occurred_at)`) without
  per-message, per-user rows.

## R9. Push notifications and sound

- **Decision:**
  - **Web Push** (RFC 8030/8291) with VAPID through the `web-push` npm library on the worker.
  - **Keys:** `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` come from env.
  - **Browser side:** a service worker at `apps/web/public/sw.js` shows notifications and focuses
    or opens the chat on click.
  - **Subscriptions:** `push_devices`, at most 5 per user (FR-037), with a label, `paused` flag and
    last success. A 404 or 410 from the push service deletes the device.
  - **When to push:** only when the user has no live SSE connection. Presence is a Redis key
    `wbm:presence:{userId}`, refreshed by the SSE heartbeat with a 45 s TTL.
  - **Payload:** the contact name, or the masked phone for agents, plus a preview of at most 80
    characters. Web Push payloads are end-to-end encrypted.
  - **Sound:** stored in `notification_preferences.sound_enabled` and played client-side on SSE
    message events for visible chats.
- **Rationale:** a standard browser feature with no vendor needed. Behaviour on Mac and iOS
  depends on the browser, as AiSensy also notes.
- **Alternatives considered:**
  - **Firebase Cloud Messaging:** an extra vendor account, and data goes to Google beyond the push
    transport.
  - **Email alerts:** too slow for live chat.

## R10. Welcome and off-hours messages

- **Decision:** evaluated by the inbound pipeline after consent and keyword handling.
  - **Welcome:** within working hours, on a message that starts a new **opening** (R14), sent
    once per opening. Idempotency comes from `conversation_openings.welcome_sent_at` and a
    conditional update.
  - **Off-hours:** outside working hours. `SET wbm:offhours:{contactId} NX EX 43200` allows one per
    contact every 12 h.
  - **Skipped for:** blocked or opted-out contacts, and opt-out, opt-in or "talk to a person"
    keyword messages (FR-036).
  - **Working hours:** evaluated in the configured IANA time zone with `Intl.DateTimeFormat`. The
    weekday schedule is JSON: `{"mon":[["09:00","18:00"]], …}`; an empty day means closed.
  - **Content:**
    - **Template:** sent through `messages` with origin `INBOX`, flagged automatic, with fallbacks
      for variables.
    - **Text or media:** sent through the session send path, flagged automatic.
- **Rationale:** reuses both send paths; the idempotency keys guarantee "exactly once" (SC-004).

## R11. Read receipts and routing status webhooks

- **Decision:**
  - **Read receipts:** opening a chat with unread inbound messages enqueues a `mark-read` job, at
    most once per chat per 10 s. It calls `POST /{phone-number-id}/messages`
    `{"messaging_product":"whatsapp","status":"read","message_id":"<latest inbound wamid>"}`.
    Marking the latest message marks the earlier ones too (verify). It is best effort and never
    blocks the UI.
  - **Status webhooks:** the 001 `StatusHandler` looks up `messages.wa_message_id`. When it is
    absent, it looks up `chat_messages.wa_message_id`. The shared precedence rules
    (`computeStatusUpdate`) apply to both. Unknown wamids keep the 24 h buffer.
  - **After a status update:** a `message.status` inbox event is published for the affected chat.

## R12. Template sends from a chat

- **Decision:** `POST /inbox/conversations/{id}/template` creates a `messages` row:
  - origin `INBOX`, no campaign, `sent_by_user_id`
  - resolved params and header media handled with 001's builders
  - consent checks shared with the public API: opted-out is refused; marketing needs opt-in
    (FR-017)

  It enqueues the existing campaign-style `send` job with priority 1 and adds a `MESSAGE_REF` row to
  the chat.
- **Rationale:** cost estimation, retries, status precedence and reporting work unchanged.

## R13. "Talk to a person" keywords

- **Decision:**
  - **Storage:** `live_chat_settings.human_keywords`, at most 5, normalised like 001's consent
    keywords (trim, collapse spaces, upper-case) with exact match.
  - **Order of evaluation:**
    1. opt-out and opt-in (001)
    2. human keywords: state → `REQUESTING` unless `INTERVENED`, `unresolved_requests + 1`, notify
    3. automatic messages, skipped when a keyword matched
- **Rationale:** mirrors the documented "Requesting" column before the chatbot exists. Feature 005
  adds bot-initiated requests through the same transition.

## R14. Openings and team metrics

- **Decision:**
  - **What is stored:** `conversation_openings (conversation_id, opened_at, first_human_reply_at,
    first_responder_id, intervened_at, intervened_by_id, resolved_at, resolved_by_id, welcome_sent_at)`.
  - **When an opening starts:** on a customer message when there was none in the previous 24 h, or
    when it is the contact's first message ever.
  - **First human reply:** set by the first session or template message sent by a person.
    Automatic messages don't count (FR-036).
  - **Metrics (FR-039):** `percentile_cont(0.5)` over openings in the period, grouped by member;
    live counts come from `conversations`.
- **Rationale:** explicit openings make the metric definitions testable (SC-007 analogue)
  without replaying event logs.

## R15. Canned messages and the media library

- **Decision:**
  - **`canned_messages`:**
    - name, type `TEXT | MEDIA`, text up to 4096
    - `variables_fallbacks` JSON
    - `media_asset_id` or `media_url`, plus an optional file name
    - creator; at most 200 rows (FR-030)
  - **Favourites:** `canned_message_favorites (user_id, canned_message_id)`.
  - **Variable syntax** (our own): `{first_name}`, `{name}`, `{last_name}`, `{phone}`,
    `{attr:<key>}`, and numbered parameters `{{1}}`… filled at send time.
  - **Media library:** `media_assets` with purpose `LIBRARY`, plus `display_name` and
    `uploaded_by_id`, validated with the chat limits (FR-015).
- **Rationale:** reuses 001's media storage and validation. The placeholder syntax is our own
  wording (Principle II).

## R16. Retention, erasure and blocking

- **Decision:**
  - **Retention:** the 001 retention job (daily) also deletes `chat_messages`,
    `conversation_events` and `conversation_openings` older than 12 months, plus `INBOUND` media
    assets and their S3 objects once no message references them.
  - **Contact deletion:** erases `chat_messages.text`, payload and media for the contact, and
    detaches `contact_id`; counts remain.
  - **Blocking:** `contacts.blocked_at` and `blocked_by_id`. Inbound messages from blocked
    contacts are stored but skip SSE, push and automatic messages (FR-034).

## R17. Webhook message types (Graph v27; verify against Meta's current reference)

| Inbound `type` | Stored as | Notes |
|---|---|---|
| `text` | TEXT | `text.body` |
| `image`, `video`, `document`, `sticker` | the matching media kind | `<type>.id`, `mime_type`, `caption`, `filename` (document); download per R4 |
| `audio` | AUDIO | `audio.voice = true` marks a voice note |
| `location` | LOCATION | latitude, longitude, name, address |
| `contacts` | CONTACTS | array of shared contacts (names, phones) |
| `interactive` | BUTTON_REPLY / LIST_REPLY | `button_reply` or `list_reply` id and title; `nfm_reply` (form reply) stored as FORM_REPLY for feature 006 |
| `button` | BUTTON_REPLY | quick-reply tap on a template; `button.text` and payload |
| `reaction` | REACTION | `reaction.message_id` and emoji (an empty emoji removes the reaction) |
| `order`, `system` | UNSUPPORTED for now | kept raw; `order` arrives with feature 006 |
| `unsupported` / `unknown` | UNSUPPORTED | `errors[]` gives the reason (for example 131051) |

Message edits and deletions: no handling is designed until Meta's current webhook reference is
checked. Unknown shapes fall back to UNSUPPORTED, so nothing is silently lost (edge case).

## R18. mock-meta for local runs and e2e

- **Decision:** extend `tools/mock-meta`:
  - **Accept free-form sends:** `type` text, image, video, audio or document, and emit
    sent/delivered/read statuses as today.
  - **Accept read calls:** `{status:"read"}`.
  - **Serve media:** `GET /{media-id}` and a download URL.
  - **Extend the inbound CLI** (`npm run mock:inbound`) for every inbound type, including media,
    location, contacts, reactions and button or list replies.
- **Rationale:** Principle V requires tests that never touch Meta.
