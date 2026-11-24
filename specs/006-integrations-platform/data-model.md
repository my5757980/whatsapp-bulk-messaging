# Data Model: Integrations and Developer Platform

**Feature**: `006-integrations-platform` | **Date**: 2026-11-24 | **Research**: [research.md](./research.md)

Conventions are the same as in 001–005:
- uuid v7 ids, snake_case tables and columns, `timestamptz`
- Prisma migrations only (`apps/api/prisma/migrations/20261201000000_integrations`)
- Secrets encrypted with the 001 token encryption (`*_encrypted` columns, AES-256-GCM with
  `TOKEN_ENCRYPTION_KEY`)

## 1. New tables

### webhook_endpoints

An admin's webhook endpoint (FR-001, FR-003, FR-006, FR-009).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among endpoints |
| url | varchar(2000) | `https://` only; checked against private and reserved addresses on save and on each send |
| event_types | text[] | values from the catalog (R3), at least one |
| include_content | boolean, default true | whether `message.received` carries the text |
| status | `WebhookEndpointStatus` | `ACTIVE`, `PAUSED` (by an admin), `FAILING` (paused after 24 h of failures) |
| secret_encrypted | text | `whsec_…`, shown once |
| previous_secret_encrypted | text? | still signs until `previous_secret_until` |
| previous_secret_until | timestamptz? | renewal time + 24 h |
| last_success_at / last_failure_at / failing_since | timestamptz? | |
| consecutive_failures | integer, default 0 | failed attempts since the last success, for the auto-pause rule |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

### outbound_events

One event, shared by all its deliveries (R2, R3).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | sent as `webhook-id` (`evt_` + id) |
| type | varchar(40) | catalog type |
| occurred_at | timestamptz | the time of the change |
| data | jsonb | the payload `data` (contracts/webhook-events.md) |
| created_at | timestamptz | |

Index: `(created_at)` for retention.

### webhook_deliveries

One event for one endpoint (FR-005, FR-007).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | BullMQ job id |
| endpoint_id | uuid FK webhook_endpoints `CASCADE` | |
| event_id | uuid FK outbound_events `CASCADE` | |
| status | `DeliveryStatus` | `PENDING`, `DELIVERED`, `FAILED`, `CANCELLED` |
| attempts | smallint, default 0 | |
| next_attempt_at | timestamptz? | null when finished |
| last_status_code | smallint? | |
| last_error | varchar(60)? | `TIMEOUT`, `BLOCKED_ADDRESS`, `NETWORK`, `REDIRECT`, `HTTP_4XX`, `HTTP_5XX` |
| last_duration_ms | integer? | |
| delivered_at | timestamptz? | |
| created_at / updated_at | timestamptz | |

Unique: `(endpoint_id, event_id)`. Indexes: `(status, next_attempt_at)` for the sweep, and
`(endpoint_id, created_at DESC)` for the log.

### api_campaigns

A named API campaign (FR-017, FR-018, FR-021).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among campaigns that are not stopped |
| api_name | varchar(60) unique | lower-case slug `[a-z0-9-]`, fixed after the first go-live |
| number_id | uuid FK whatsapp_numbers `RESTRICT` | |
| template_id | uuid FK templates `RESTRICT` | approved, same WABA as the number |
| variable_mapping | jsonb | per 001 variable key: `{ source: "value", key }`, `{ source: "field", key }` or `{ source: "static", value }` |
| header_media_asset_id | uuid? FK media_assets `SET NULL` | a fixed header; a call may pass `mediaUrl` instead |
| tags | text[] | added to the contact on each trigger |
| attributes | jsonb | fixed values or `{ fromValue: key }` |
| create_contacts | boolean, default true | |
| daily_limit | integer? | 1–100,000 |
| status | `ApiCampaignStatus` | `DRAFT`, `LIVE`, `PAUSED`, `STOPPED` |
| paused_reason | varchar(40)? | `TEMPLATE_UNAVAILABLE`, `NUMBER_DISCONNECTED`, `MEMBER` |
| went_live_at / paused_at / stopped_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

### api_campaign_triggers

Every call to an API campaign (FR-019, FR-022).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| api_campaign_id | uuid FK api_campaigns `CASCADE` | |
| api_key_id | uuid? FK api_keys `SET NULL` | |
| contact_id | uuid? FK contacts `SET NULL` | |
| phone_e164 | varchar(16)? | null after erasure |
| outcome | `TriggerOutcome` | `QUEUED`, `NOT_SENT` |
| reason | varchar(40)? | `opted_out`, `no_opt_in`, `missing_value`, `daily_limit`, `not_live`, `invalid_phone`, `blocked` |
| message_id | uuid? FK messages `SET NULL` | |
| created_at | timestamptz | |

Indexes: `(api_campaign_id, created_at)` and `(contact_id)`.

### store_connections

A connected store (FR-023 – FR-027).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| platform | `StorePlatform` | `SHOPIFY`, `WOOCOMMERCE` |
| name | varchar(120) | from the store |
| base_url | varchar(255) | `https://{shop}.myshopify.com` or the WooCommerce site |
| credentials_encrypted | text | Shopify: `{ clientId, clientSecret }` or `{ accessToken, clientSecret }`; WooCommerce: `{ consumerKey, consumerSecret }` |
| webhook_secret_encrypted | text? | WooCommerce only (Shopify signs with the client secret) |
| access_token_encrypted / token_expires_at | text? / timestamptz? | Shopify client-credentials token (24 h) |
| number_id | uuid FK whatsapp_numbers `RESTRICT` | |
| default_country | char(2) | for phones without a country code |
| customer_tag | varchar(50) | |
| consent_is_whatsapp | boolean, default false | the admin confirmed the store's consent text names WhatsApp |
| consent_confirmed_by_id / consent_confirmed_at | uuid? / timestamptz? | |
| shipped_status / delivered_status | varchar(40)? | WooCommerce status mapping (default `completed` / null) |
| status | `StoreStatus` | `CONNECTED`, `ERROR`, `DISCONNECTED` |
| last_error | varchar(200)? | plain text for the admin |
| last_event_at / last_synced_at | timestamptz? | the reconciler fetches from `last_synced_at` (at most 3 days back) |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

At most 5 rows where `status <> 'DISCONNECTED'` (checked in the service).

### store_events

Raw store deliveries, saved before processing (R9).

| Column | Type | Notes |
|---|---|---|
| id | bigint PK | |
| store_id | uuid FK store_connections `CASCADE` | |
| external_id | varchar(100) | `X-Shopify-Webhook-Id`, `X-WC-Webhook-Delivery-ID`, or `sync:{order}:{updated}` from the reconciler |
| topic | varchar(60) | |
| payload | jsonb | |
| status | `StoreEventStatus` | `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED` |
| error | varchar(200)? | |
| received_at / processed_at | timestamptz | |

Unique `(store_id, external_id)`. Index `(received_at)` for retention.

### store_automations

One automation of a store (FR-029, FR-034, FR-039).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| store_id | uuid FK store_connections `CASCADE` | |
| kind | `StoreAutomationKind` | `ORDER_CONFIRMED`, `ORDER_SHIPPED`, `ORDER_DELIVERED`, `ORDER_CANCELLED`, `COD_CONFIRMATION`, `CART_REMINDER` |
| enabled | boolean, default false | |
| steps | jsonb | ordered `[{ templateId, variableMapping, waitMinutes? }]`: one step for notifications and COD, up to 3 for cart reminders |
| settings | jsonb | COD: `{ confirmedReply, cancelledReply, alreadyAnsweredReply, reminderMinutes: 360, finalMinutes: 1440, autoCancel: false }` |
| updated_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

Unique `(store_id, kind)`.

### store_orders

An order seen from a store (FR-030, FR-035 – FR-037).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| store_id | uuid FK store_connections `CASCADE` | |
| external_id | varchar(64) | Shopify gid or WooCommerce order id |
| order_number | varchar(40) | as customers see it |
| contact_id | uuid? FK contacts `SET NULL` | |
| phone_e164 / phone_source | varchar(16)? / varchar(10)? | `shipping`, `billing`, `customer` |
| customer_name | varchar(120)? | null after erasure |
| total / currency | numeric(14,2) / char(3) | the store's currency |
| payment_kind | `PaymentKind` | `COD`, `PREPAID`, `UNPAID` |
| status | varchar(30) | the store's status |
| placed_at / store_updated_at | timestamptz | |
| cod_status | `CodStatus` | `NONE`, `ASKED`, `CONFIRMED`, `CANCELLED`, `NO_ANSWER`, `CLOSED` |
| cod_asked_at / cod_answered_at | timestamptz? | |
| cod_next_at | timestamptz? | the reminder or final time; null when none is due |
| cod_reminded | boolean, default false | |
| created_at / updated_at | timestamptz | |

Unique `(store_id, external_id)`. Index `(cod_status, cod_next_at)` for the tick.

### store_order_messages

Each notification or COD message of an order, at most once (FR-030).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| order_id | uuid FK store_orders `CASCADE` | |
| kind | `StoreMessageKind` | the automation kinds, plus `COD_REMINDER` and `COD_REPLY` |
| outcome | `StepOutcome` (005) | `QUEUED`, `SKIPPED` |
| skip_reason | varchar(40)? | `no_phone`, `opted_out`, `no_opt_in`, `stale`, `blocked`, `template_unavailable` |
| message_id | uuid? FK messages `SET NULL` | |
| created_at | timestamptz | |

Unique `(order_id, kind)`, except `COD_REPLY`, which may repeat (a partial unique index without it).

### store_carts

A checkout that may become an abandoned cart (FR-039 – FR-044).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| store_id | uuid FK store_connections `CASCADE` | |
| external_id | varchar(64) | Shopify checkout id, or WooCommerce order id for unpaid orders |
| contact_id | uuid? FK contacts `SET NULL` | |
| phone_e164 | varchar(16)? | |
| value / currency | numeric(14,2) / char(3) | |
| items_summary | varchar(300)? | for the template |
| cart_url | varchar(2000)? | recovery or payment link, sent through a 005 tracked link |
| started_at / store_updated_at | timestamptz | |
| status | `CartStatus` | `OPEN`, `REMINDING`, `RECOVERED`, `STOPPED`, `SKIPPED`, `EXPIRED` |
| stop_reason | varchar(40)? | `ordered`, `opted_out`, `blocked`, `replied`, `no_consent`, `no_phone`, `store_disconnected` |
| next_step / next_at | smallint / timestamptz? | |
| last_reminder_at | timestamptz? | |
| recovered_order_id | uuid? FK store_orders `SET NULL` | |
| recovered_value / recovered_at | numeric(14,2)? / timestamptz? | |
| created_at / updated_at | timestamptz | |

Unique `(store_id, external_id)`. Index `(status, next_at)`.

### store_cart_reminders

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| cart_id | uuid FK store_carts `CASCADE` | |
| step | smallint | 1–3 |
| outcome / skip_reason | `StepOutcome` / varchar(40)? | |
| message_id | uuid? FK messages `SET NULL` | |
| created_at | timestamptz | |

Unique `(cart_id, step)`.

### chat_links

A chat link and its QR code (FR-045 – FR-050).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among links not deleted |
| number_id | uuid FK whatsapp_numbers `RESTRICT` | |
| message | varchar(500) | the pre-filled text, without the reference |
| ref | char(6) unique | from an alphabet without look-alikes |
| code | char(10) unique | the short link code (005 alphabet) |
| flow_id | uuid? FK flows `SET NULL` | must be published |
| tag_id | uuid? FK tags `SET NULL` | |
| status | `ChatLinkStatus` | `ACTIVE`, `OFF` |
| deleted_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

### chat_link_opens

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| chat_link_id | uuid FK chat_links `CASCADE` | |
| device | `ClickDeviceKind` (005) | |
| opened_at | timestamptz | |

Index `(chat_link_id, opened_at)`. No IP is stored.

### chat_link_starts

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| chat_link_id | uuid FK chat_links `CASCADE` | |
| contact_id | uuid? FK contacts `SET NULL` | |
| conversation_id | uuid? FK conversations `SET NULL` | |
| new_contact | boolean | |
| started_at | timestamptz | |

Index `(chat_link_id, started_at)`. Unique `(chat_link_id, contact_id, started_at::date)` counts a
contact once a day.

### api_idempotent_responses

Saved answers of changing public API calls sent with an `Idempotency-Key` (FR-015). The 001
`idempotency_records` table keeps message sends; this one keeps any other answer.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| api_key_id | uuid FK api_keys `CASCADE` | |
| key | varchar(255) | the header value |
| request_hash | text | method, path and body; a different request with the same key gets 409 |
| status / body | smallint / jsonb | the first answer, returned again |
| expires_at / created_at | timestamptz | 24 hours, cleaned hourly with the 001 records |

Unique `(api_key_id, key)`.

### number_connection_checks

One wizard run (FR-051 – FR-055).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| number_id | uuid? FK whatsapp_numbers `SET NULL` | set once connected |
| waba_id / phone_number_id | varchar(40)? | |
| results | jsonb | `[{ check, result: PASSED/FAILED/WARNING, detail, fix }]`, no token |
| run_by_id | uuid? FK users `SET NULL` | |
| created_at | timestamptz | |

## 2. Changed tables and enums

- `api_keys`: `scopes text[] NOT NULL DEFAULT '{messages.send}'`.
- `messages`:
  - `api_campaign_id uuid? FK api_campaigns SET NULL`, indexed
  - `store_order_id uuid? FK store_orders SET NULL`, indexed
  - `store_cart_id uuid? FK store_carts SET NULL`, indexed
- `MessageOrigin` + `STORE` (shown as automatic in live chat, like `DRIP`).
- `ConsentSource` + `STORE`.
- `DripTriggerKind` + `ORDER_PLACED` and `ORDER_DELIVERED`, so drips can start on store events
  (FR-028). `DripJoinVia` gets the same values.
- `JourneyEventType` + `CHAT_LINK_STARTED`, `ORDER_PLACED` and `COD_ANSWERED`.
- `JourneyActor` + `API_KEY`: changes made through the public API show the key in the journey (FR-016).
- `NotificationType`:
  - `WEBHOOK_ENDPOINT_FAILING`
  - `STORE_CONNECTION_ERROR`
  - `API_CAMPAIGN_PAUSED`
  - `COD_CANCELLED` (when automatic cancel is off)
- Permission `integrations.manage` (admins).

## 3. State machines

- **Webhook delivery:**
  - `PENDING` → `DELIVERED` (2xx)
  - `PENDING` → `PENDING` (failed attempt with attempts left, `next_attempt_at` set)
  - `PENDING` → `FAILED` (last attempt failed)
  - `PENDING` → `CANCELLED` (endpoint deleted)
  - Resending `FAILED` or `DELIVERED` makes it `PENDING` again with the same event.
- **Webhook endpoint:**
  - `ACTIVE` ⇄ `PAUSED` (admin)
  - `ACTIVE` → `FAILING` (24 h without success and at least 10 failed attempts)
  - `FAILING` → `ACTIVE` (admin resume; due deliveries go at once)
- **API campaign:**
  - `DRAFT` → `LIVE`
  - `LIVE` ⇄ `PAUSED` (member or self-pause)
  - `LIVE`/`PAUSED` → `STOPPED` (final; the name is freed)
- **Store connection:**
  - `CONNECTED` → `ERROR` (access refused or unreachable, three tries in a row)
  - `ERROR` → `CONNECTED` (the next success, followed by a sync)
  - any → `DISCONNECTED` (admin)
- **COD:**
  - `NONE` → `ASKED` (sent)
  - `ASKED` → `CONFIRMED` or `CANCELLED` (first tap)
  - `ASKED` → `NO_ANSWER` (final time)
  - `ASKED` → `CLOSED` (the order is cancelled or paid in the store first)
- **Cart:**
  - `OPEN` → `REMINDING` (first reminder) → `RECOVERED`, `STOPPED` or `EXPIRED` (7 days after the
    last reminder)
  - `OPEN` → `SKIPPED` (no consent or no phone at the first due time)
  - `OPEN` → `RECOVERED` (ordered before the first reminder; not counted as recovered by a
    reminder, but closed)

## 4. Validation rules (from the spec)

- **Webhook endpoints:**
  - The URL must be `https://` and resolve to public addresses only (FR-001).
  - At least one event type.
  - Up to 20 endpoints.
- **API campaigns:**
  - `api_name` matches `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`.
  - Every template variable has a source (FR-017).
  - Marketing templates need the call's opt-in or an existing opt-in (FR-020).
  - The daily limit is 1–100,000.
- **Store connections:**
  - At most 5 active (FR-023).
  - `base_url` is https.
  - The connection test must pass before saving.
- **Automations:**
  - Notification and COD templates must be approved. COD needs exactly two quick-reply buttons.
  - Cart reminder steps: 1–3, waits of 30 minutes to 7 days, increasing.
- **Chat links:**
  - The message is 1–500 characters before the reference.
  - The flow must be published, and its number must be the link's number or all numbers (003).
- **API values:** strings of at most 1,024 characters. Attributes follow their types (001 import
  rules).

## 5. Retention and erasure

- **Daily retention job (FR-059):**
  - outbound events and deliveries after 30 days
  - store events after 30 days
  - API campaign triggers, store orders, store order messages, carts and cart reminders after 12
    months
  - chat link opens and starts after 12 months
  - number connection checks after 12 months
- **Contact deletion (FR-060):**
  - triggers, orders, carts and chat link starts keep their rows with `contact_id` and phone set to
    null and the customer name cleared
  - waiting cart reminders stop (`STOPPED`, `deleted`)
  - COD orders waiting for an answer close (`CLOSED`)
  - waiting webhook deliveries that name the contact are cancelled, and `contact.deleted` carries
    only the id
- **Audit actions (FR-057):**
  - `webhook_endpoint.created`, `webhook_endpoint.updated`, `webhook_endpoint.paused`,
    `webhook_endpoint.resumed`, `webhook_endpoint.deleted`, `webhook_endpoint.secret_renewed`,
    `webhook_delivery.resent`
  - `api_key.scopes_changed`
  - `store.connected`, `store.updated`, `store.disconnected`, `store.consent_confirmed`
  - `api_campaign.created`, `api_campaign.updated`, `api_campaign.live`, `api_campaign.paused`,
    `api_campaign.stopped`
  - `store_automation.updated`
  - `chat_link.created`, `chat_link.updated`, `chat_link.turned_off`, `chat_link.deleted`
  - `number.connected_with_wizard`, `number.fixed_with_wizard`
