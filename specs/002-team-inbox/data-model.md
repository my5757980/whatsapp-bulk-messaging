# Data Model: Live Chat (Shared Team Inbox)

**Feature**: `002-team-inbox` | **Date**: 2026-11-19 | **Research**: [research.md](./research.md)

The conventions of feature 001 apply: uuid v7 keys, `timestamptz` columns, Prisma migrations, and
enums in the Prisma schema. Only new and changed tables are shown. Unless noted, every new table has
`created_at` (default now). Mutable tables also have `updated_at`.

## 1. New tables

### conversations — one chat per contact per company number

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| contact_id | uuid? | FK contacts, `ON DELETE SET NULL` (anonymised on contact deletion) |
| number_id | uuid | FK whatsapp_numbers |
| state | ConversationState | `ACTIVE` \| `REQUESTING` \| `INTERVENED`, default `ACTIVE` |
| intervened_by_id | uuid? | FK users, `SET NULL`; required when state = `INTERVENED` (check constraint) |
| intervened_at | timestamptz? | |
| last_customer_message_at | timestamptz? | the 24-hour window is `last_customer_message_at + 24 h`; null = the customer never wrote |
| last_inbound_at | timestamptz? | unread computation |
| last_activity_at | timestamptz | any message, note or event; list ordering |
| last_message_preview | varchar(120)? | for lists; null on erasure |
| unresolved_requests | int | default 0; +1 per "talk to a person" keyword |

- **Unique** `(contact_id, number_id)`. NULLs stay distinct after erasure.
- **Indexes:**
  - `(state, last_activity_at DESC)`
  - `(intervened_by_id) WHERE state = 'INTERVENED'`
  - `(number_id, last_activity_at DESC)`
  - `(last_customer_message_at)`
- **Derived, never stored:** `in_history = last_customer_message_at IS NULL OR last_customer_message_at <= now() - interval '24 hours'`.
- **Created when:** the first inbound message arrives, or a member starts a chat by sending a
  template. On creation, `MESSAGE_REF` rows are back-filled for the contact's existing `messages`
  on that number (campaigns, API), so the timeline is complete.

### chat_messages — every timeline item

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| conversation_id | uuid | FK conversations, `ON DELETE CASCADE` |
| kind | ChatItemKind | `INBOUND` \| `SESSION_OUT` \| `MESSAGE_REF` \| `NOTE` |
| origin | ChatOrigin | `CUSTOMER` \| `MEMBER` \| `AUTOMATIC` \| `CAMPAIGN` \| `API` |
| content_type | ChatContentType | `TEXT` \| `IMAGE` \| `VIDEO` \| `AUDIO` \| `DOCUMENT` \| `STICKER` \| `LOCATION` \| `CONTACTS` \| `BUTTON_REPLY` \| `LIST_REPLY` \| `FORM_REPLY` \| `REACTION` \| `TEMPLATE` \| `UNSUPPORTED` |
| text | text? | body, caption or note; at most 4096 for `SESSION_OUT` and `NOTE`; null on erasure |
| payload | jsonb | default `{}`; per type (§3) |
| media_asset_id | uuid? | FK media_assets, `SET NULL` |
| media_state | MediaState? | `PENDING` \| `READY` \| `FAILED` (inbound media) |
| message_id | uuid? | FK messages, `ON DELETE CASCADE`; required for `MESSAGE_REF` |
| wa_message_id | text? | **unique**; customer wamid (`INBOUND`) or ours (`SESSION_OUT`) |
| reply_to_wa_id | text? | customer replied to this wamid (`context.id`) |
| status | MessageStatus? | `SESSION_OUT` only, reusing 001's enum: QUEUED → SENDING → SENT → DELIVERED → READ, or FAILED |
| failure_code / failure_reason | int? / text? | plain-language reason, as in 001 |
| attempts | int | default 0 |
| sent_by_user_id | uuid? | FK users, `SET NULL`; author of `SESSION_OUT`, `NOTE` or an inbox template |
| occurred_at | timestamptz | customer timestamp (inbound) or creation time |
| sent_at, delivered_at, read_at, failed_at | timestamptz? | `SESSION_OUT` timeline |

- **Indexes:**
  - `(conversation_id, occurred_at, id)` for keyset pagination
  - unique `wa_message_id`
  - `(message_id)`
- **Check constraints:**
  - `kind = 'MESSAGE_REF'` ⇒ `message_id IS NOT NULL`
  - `kind = 'NOTE'` ⇒ `origin = 'MEMBER'`
- **Inbound dedupe:** inserts use `ON CONFLICT (wa_message_id) DO NOTHING`, so a repeated webhook
  never creates a second row (SC-003).

### conversation_openings — one row per conversation start (metrics, welcome idempotency)

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| conversation_id | uuid | FK, `CASCADE` |
| opened_at | timestamptz | the customer message that started it |
| first_human_reply_at | timestamptz? | first `SESSION_OUT` or inbox template sent by a member; automatic messages excluded |
| first_responder_id | uuid? | FK users, `SET NULL` |
| intervened_at / intervened_by_id | timestamptz? / uuid? | first intervention in this opening |
| resolved_at / resolved_by_id | timestamptz? / uuid? | `resolved_by_id` is null for auto-resolve |
| welcome_sent_at | timestamptz? | set with a conditional update (sent at most once) |

- **Index:** `(conversation_id, opened_at DESC)`, `(opened_at)` for period queries.
- **When an opening starts:** on a customer message when `last_customer_message_at` is null or
  older than 24 h.

### conversation_events — the customer journey

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| conversation_id | uuid | FK, `CASCADE` |
| type | JourneyEventType | `REQUESTED` \| `INTERVENED` \| `TRANSFERRED` \| `RESOLVED` \| `AUTO_RESOLVED` \| `TAG_ADDED` \| `TAG_REMOVED` \| `ATTRIBUTE_CHANGED` \| `CONSENT_CHANGED` \| `BLOCKED` \| `UNBLOCKED` \| `FIRST_MESSAGE_TAG_CHANGED` |
| actor_type | JourneyActor | `MEMBER` \| `CUSTOMER` \| `SYSTEM` |
| actor_user_id | uuid? | FK users, `SET NULL` |
| data | jsonb | for example `{fromUserId,toUserId}`, `{tag}`, `{key,from,to}`, `{status,source}` |
| occurred_at | timestamptz | |

- **Index:** `(conversation_id, occurred_at DESC)`.
- **Journey view:** these events merged with `MESSAGE_REF` items whose origin is `CAMPAIGN` or
  `API` (the campaigns sent), newest first.

### chat_read_markers

| Column | Type | Rules |
|---|---|---|
| user_id | uuid | FK users, `CASCADE` |
| conversation_id | uuid | FK, `CASCADE` |
| last_read_at | timestamptz | |

- **PK** `(user_id, conversation_id)`.

### live_chat_settings — singleton (`id = 1`)

| Column | Type | Rules |
|---|---|---|
| id | smallint | PK, check `id = 1` |
| timezone | text | IANA name, validated; default the company time zone from 001 settings |
| working_hours | jsonb | `{"mon":[["09:00","18:00"]],"tue":[…],…,"sun":[]}`; ranges `HH:MM`, start < end, no overlaps |
| welcome_enabled | boolean | default false |
| welcome_content | jsonb? | AutoContent (§3); required when enabled |
| off_hours_enabled | boolean | default false |
| off_hours_content | jsonb? | AutoContent; required when enabled |
| human_keywords | text[] | at most 5, normalised (trim, collapse spaces, upper-case), unique |
| auto_resolve | boolean | default false |
| updated_by_id | uuid? | FK users |

### agent_rules

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK users, `CASCADE`; the user must have role AGENT |
| kind | AgentRuleKind | `TAG` \| `ATTRIBUTE` |
| tag_id | uuid? | FK tags, `CASCADE`; required for `TAG` |
| attribute_key | text? | must exist in attribute_definitions; required for `ATTRIBUTE` |
| attribute_value | text? | compared as text against `contacts.attributes ->> key`; required for `ATTRIBUTE` |
| created_by_id | uuid? | FK users |

- **Unique** `(user_id, kind, tag_id, attribute_key, attribute_value)`.
- **Matching:** an agent matches a contact when **any** rule matches; with no rules, every contact
  matches (FR-028).

### canned_messages and canned_message_favorites

| Column | Type | Rules |
|---|---|---|
| id | uuid | PK |
| name | varchar(80) | unique (case-insensitive) |
| type | CannedType | `TEXT` \| `MEDIA` |
| text | varchar(4096)? | required for `TEXT`, optional for `MEDIA` |
| variable_fallbacks | jsonb | `{"first_name":"there","attr:city":"your city"}` |
| media_asset_id | uuid? | FK media_assets (`LIBRARY`), `SET NULL` |
| media_url | text? | public https URL; exactly one of `media_asset_id` / `media_url` for `MEDIA` |
| file_name | varchar(240)? | documents |
| created_by_id | uuid? | FK users |

- **Limit:** at most 200 rows, enforced in a transaction with an advisory lock (FR-030).
- **Variables:** `{first_name}`, `{name}`, `{last_name}`, `{phone}`, `{attr:<key>}`, and parameters
  `{{1}}`…`{{n}}`.
- **Favourites:** `canned_message_favorites (user_id, canned_message_id)`, PK on both, `CASCADE`
  both ways.

### notification_preferences and push_devices

| Table | Columns | Rules |
|---|---|---|
| notification_preferences | user_id (PK, FK `CASCADE`), sound_enabled boolean default true | one row per user, created lazily |
| push_devices | id, user_id (FK `CASCADE`), endpoint text **unique**, p256dh text, auth text, label varchar(80), paused boolean default false, last_success_at timestamptz? | at most 5 per user (FR-037); deleted on push-service 404 or 410 |

## 2. Changes to feature 001 tables

| Table | Change | Why |
|---|---|---|
| `contacts` | add `blocked_at timestamptz?` and `blocked_by_id uuid?` (FK users, `SET NULL`) | blocking (FR-034) |
| `contacts` | add `lead_source varchar(80)?`, back-filled: `API` for API-created contacts, `Campaign upload` for upload confirmations, `Import` for imports, otherwise null | profile source (FR-033) |
| `contacts` | add `first_message_tag_id uuid?` (FK tags, `SET NULL`) | profile field (FR-033); automatic phrase matching arrives in 003 |
| `messages` | enum `MessageOrigin` += `INBOX`; add `sent_by_user_id uuid?` and `automatic boolean default false` | template sends from a chat, and automatic template messages (R12, R10) |
| `media_assets` | enum `MediaPurpose` += `LIBRARY`, `INBOUND`; add `display_name varchar(240)?` and `uploaded_by_id uuid?` | media library (FR-032), inbound media (R4) |
| `notifications` | enum `NotificationType` += `INBOX_REQUESTING`, `INBOX_TRANSFERRED`, `INBOX_MENTION` | in-app alerts beside push |

## 3. JSON shapes

**`chat_messages.payload`, by content_type:**
- `LOCATION`: `{latitude, longitude, name?, address?}`
- `CONTACTS`: `{contacts:[{name, phones:[…], emails?:[…]}]}`
- `BUTTON_REPLY` / `LIST_REPLY`: `{id?, title, description?}`. A template quick-reply tap stores
  `{payload, title}`.
- `REACTION`: `{targetWaId, emoji}`. An empty emoji removes the reaction.
- `AUDIO`: `{voice: boolean}`
- `DOCUMENT`: `{fileName}`
- media types: `{mimeType, sizeBytes}`
- `UNSUPPORTED`: `{rawType, errorCode?, errorTitle?}`
- `NOTE`: `{mentions:[userId]}`
- `TEMPLATE` reference rows: no payload (the content lives in `messages`)

**AutoContent** (welcome and off-hours):

```json
{ "kind": "TEMPLATE", "templateId": "uuid", "variables": { "BODY.1": { "source": "field", "key": "name", "fallback": "there" } } }
{ "kind": "TEXT", "text": "Thanks for writing! We reply within working hours." }
{ "kind": "IMAGE" | "FILE", "mediaAssetId": "uuid", "text": "optional caption" }
```

## 4. State transitions (`conversations.state`)

```
            first inbound / member sends template
  (none) ──────────────────────────────────────────► ACTIVE
  ACTIVE ── "talk to a person" keyword ─────────────► REQUESTING   (unresolved_requests + 1)
  ACTIVE | REQUESTING ── Intervene / first reply ───► INTERVENED   (exactly one winner, R6)
  INTERVENED ── transfer to member B ───────────────► INTERVENED   (owner B)
  INTERVENED ── Resolve | auto-resolve | owner deactivated ──► ACTIVE
```

**The 24-hour window is separate from the state:**
- A chat is live while `now < last_customer_message_at + 24 h`. Otherwise it is shown under History,
  with no state change.
- A customer message while in History:
  - keeps an `INTERVENED` owner
  - otherwise leaves the state at `ACTIVE`
  - REQUESTING is not kept: it becomes `ACTIVE` unless the new message is itself a keyword
- **Opening a chat shows the reply box only when it is live.** Otherwise it shows "Send template".

## 5. Realtime event envelope (Redis Stream `wbm:inbox:events`)

```json
{
  "type": "conversation.upserted | message.created | message.status | note.created | conversation.window_closed | contact.updated",
  "conversationId": "uuid",
  "numberId": "uuid",
  "contactId": "uuid | null",
  "state": "ACTIVE | REQUESTING | INTERVENED",
  "intervenedById": "uuid | null",
  "blocked": false,
  "at": "2026-11-19T10:00:00.000Z",
  "data": {}
}
```

`data` is type-specific and never holds full phone numbers. Previews are masked per recipient at
fan-out. The SSE event ID is the stream entry ID. See [contracts/realtime-events.md](./contracts/realtime-events.md).

## 6. Retention and erasure

- **Daily retention job (001):** deletes `chat_messages`, `conversation_events` and
  `conversation_openings` older than 12 months. It also deletes `INBOUND` media assets, and their S3
  objects, once no chat message references them.
- **Contact deletion (001 flow):**
  - for the contact's chat messages: `text = NULL`, `payload = '{}'`, media assets deleted
  - `last_message_preview = NULL`, `contact_id = NULL`
  - openings and anonymous counts are kept for metrics

## 7. Implementation notes (T013)

- `conversations (intervened_by_id)` is a plain index; Prisma cannot declare the partial one.
- `chat_messages.message_id` is **unique**, so one message has at most one reference row and back-fills are idempotent.
- `agent_rules` has no unique constraint (its NULL columns would make one ineffective); the replace-all PUT removes duplicates.
- `canned_messages.name` is `citext`, unique ignoring case; length (80) is validated by the API.
- `live_chat_settings` is created on first use (as 001 does for `settings`); a check constraint keeps `id = 1`.
- Check constraints in the migration: an `INTERVENED` chat has an owner; `MESSAGE_REF` rows have a `message_id`; notes have origin `MEMBER`.
- Team view (T094): a period starts at local midnight in the company time zone (`settings.default_timezone`), `days - 1` days ago. Each figure counts openings whose own event falls in the period: intervened by `intervened_at`, resolved by `resolved_at` (auto-resolve has no `resolved_by_id`, so it counts for nobody), first response by `first_human_reply_at`, resolution (`resolved_at - intervened_at`) by `resolved_at`.
- Push alerts (T087): `push_devices.label` is never empty; without a label from the page it is derived from the User-Agent (for example "Chrome on Windows"). A browser registered again by another member moves to that member.
