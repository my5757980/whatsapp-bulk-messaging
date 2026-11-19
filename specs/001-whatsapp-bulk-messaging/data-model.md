# Data Model: WhatsApp Bulk Messaging Core

**Feature**: `001-whatsapp-bulk-messaging` | **Date**: 2026-11-16 | **Plan**: [plan.md](./plan.md)

## Conventions

- **Database:** PostgreSQL. Prisma schema lives in `apps/api/prisma/schema.prisma`. Every table has `id` (uuid v7), `created_at` and `updated_at` unless noted.
- **Phones:** stored as E.164 strings (`+971501234567`).
- **Countries:** ISO 3166-1 alpha-2.
- **Money:** integer **USD micros** (1 USD = 1,000,000).
- **Enums:** shown in UPPER_CASE; Prisma enums mirror them.
- **FR references:** link fields to the spec requirements.

---

## 1. Access & audit

### User (`users`)

| Field | Type | Rules |
|---|---|---|
| email | citext | unique, valid email |
| name | text | 1–120 chars |
| password_hash | text? | argon2id; null until the invitation is accepted |
| role | enum `ADMIN \| MANAGER \| AGENT` | FR-006 |
| status | enum `INVITED \| ACTIVE \| DEACTIVATED` | DEACTIVATED → sign-in refused, sessions revoked |
| last_login_at | timestamptz? | |

**States:** `INVITED → ACTIVE → DEACTIVATED → ACTIVE`. Only an ADMIN may change role or status; the last active ADMIN cannot be demoted or deactivated.

### Invitation (`invitations`)

| Field | Type | Rules |
|---|---|---|
| email | citext | |
| role | enum (as User.role) | |
| token_hash | text | unique, SHA-256 |
| invited_by_id | uuid → users | |
| expires_at | timestamptz | created_at + 7 d |
| accepted_at | timestamptz? | single use |

### Session (`sessions`)

| Field | Type | Rules |
|---|---|---|
| user_id | uuid → users | cascade delete |
| token_hash | text | unique |
| expires_at | timestamptz | absolute 7 d |
| last_seen_at | timestamptz | idle timeout 12 h |
| ip | inet? | |
| user_agent | text? | |

### AuditLog (`audit_logs`), FR-008

| Field | Type | Rules |
|---|---|---|
| actor_user_id | uuid? → users | null for system actions |
| actor_api_key_id | uuid? → api_keys | |
| action | text | from the enum list below |
| target_type | text | e.g. `campaign`, `contact` |
| target_id | text? | |
| metadata | jsonb | never secrets |
| ip | inet? | |
| created_at | timestamptz | indexed; retained ≥ 12 months |

Actions:

| Area | Actions |
|---|---|
| Auth | `auth.login`, `auth.login_failed`, `auth.logout` |
| Users | `user.invited`, `user.role_changed`, `user.deactivated`, `user.reactivated` |
| Numbers | `number.connected`, `number.disconnected`, `number.credentials_changed` |
| Campaigns | `campaign.launched`, `campaign.scheduled`, `campaign.paused`, `campaign.auto_paused`, `campaign.resumed`, `campaign.cancelled` |
| Data | `data.exported`, `contact.deleted` |
| API keys | `api_key.created`, `api_key.revoked` |
| Settings | `settings.updated`, `rate_card.updated` |

### Settings (`settings`, single row `id = 1`)

| Field | Type | Rules |
|---|---|---|
| default_country_code | char(2) | FR-004 |
| default_timezone | text | IANA zone, e.g. `Asia/Dubai` |
| opt_out_keywords | text[] | default `{STOP,UNSUBSCRIBE}`; uppercase, unique |
| opt_in_keywords | text[] | default `{START}`; must not overlap the opt-out list |

---

## 2. WhatsApp numbers

### WhatsAppNumber (`whatsapp_numbers`), FR-001–FR-003

| Field | Type | Rules |
|---|---|---|
| label | text | internal name |
| waba_id | text | Meta WhatsApp Business Account ID |
| phone_number_id | text | unique |
| display_phone_number | text | from Meta |
| verified_name | text | from Meta |
| connection_status | enum `CONNECTED \| ERROR \| DISCONNECTED` | ERROR when the token is rejected |
| quality_rating | enum `GREEN \| YELLOW \| RED \| UNKNOWN` | from Meta (`quality_rating`) |
| messaging_limit_tier | text? | from Meta if available, else admin-entered (research R8) |
| throughput_level | text? | from Meta `throughput` |
| send_rate_per_second | int | default 20, range 1–80 (higher only after a Meta upgrade) |
| sending_enabled | bool | kill switch (Principle I); false blocks dispatch |
| access_token_enc | text | AES-256-GCM `v1:iv:tag:ct`; never returned by the API |
| last_synced_at | timestamptz? | refreshed ≤ every 6 h (FR-002) |
| last_error | text? | |

---

## 3. Contacts & consent

### Contact (`contacts`), FR-009–FR-015

| Field | Type | Rules |
|---|---|---|
| phone_e164 | text | unique; validated with libphonenumber |
| country_code | char(2) | derived from the phone |
| name | text? | ≤ 120 chars |
| attributes | jsonb | `{ key: value }`, keys must exist in `attribute_definitions`, values match the type; GIN index |
| consent_status | enum `OPTED_IN \| OPTED_OUT \| UNKNOWN` | FR-012 |
| consent_source | enum `IMPORT \| UPLOAD_CONFIRMATION \| API \| KEYWORD \| MANUAL`? | |
| consent_source_note | text? | e.g. "checkout form" |
| consent_at | timestamptz? | |

**Indexes:** `consent_status`; GIN(`attributes`); trigram on `name` and `phone_e164` for search.

**Deletion (FR-015):** hard-delete the contact, its tags and consent events. For linked `messages`, set `contact_id = null` and `phone_e164 = null`, and keep `recipient_country` and the statuses so campaign totals stay correct.

### Tag (`tags`) and ContactTag (`contact_tags`)

- `tags.name`: unique, case-insensitive, 1–50 chars.
- `contact_tags`: PK (`contact_id`, `tag_id`), cascade delete, index on `tag_id`.

### AttributeDefinition (`attribute_definitions`), FR-011

| Field | Type | Rules |
|---|---|---|
| key | text | unique, `^[a-z][a-z0-9_]{0,39}$` |
| label | text | |
| type | enum `TEXT \| NUMBER \| DATE \| BOOLEAN` | values validated on write; DATE stored as ISO `YYYY-MM-DD` |

### ConsentEvent (`consent_events`)

| Field | Type | Rules |
|---|---|---|
| contact_id | uuid → contacts | cascade delete |
| status | enum (as Contact.consent_status) | |
| source | enum (as Contact.consent_source) | |
| note | text? | |
| actor_user_id | uuid? | |

**Consent states:** `UNKNOWN → OPTED_IN` (import/upload confirmation/API/keyword START/manual) `→ OPTED_OUT` (keyword STOP/manual) `→ OPTED_IN` (keyword START/manual). Every change writes a ConsentEvent and updates the Contact in one transaction.

### ImportJob (`import_jobs`), FR-010

| Field | Type | Rules |
|---|---|---|
| kind | enum `CONTACTS \| CAMPAIGN_AUDIENCE` | |
| campaign_id | uuid? → campaigns | required for CAMPAIGN_AUDIENCE |
| file_key | text | object-storage key; file deleted after 30 d |
| mapping | jsonb | `{ phone: "col", name: "col", tags: "col", attributes: {key: "col"}, optInSource: "col"? }` |
| opt_in_source_note | text? | required when the user confirms opt-in for the whole file |
| status | enum `QUEUED \| PROCESSING \| COMPLETED \| FAILED` | |
| total_rows / created_count / updated_count / skipped_count / error_count | int | |
| error_file_key | text? | row-level error CSV |
| created_by_id | uuid → users | |
| finished_at | timestamptz? | |

### CampaignUploadRow (`campaign_upload_rows`)

- Fields: `campaign_id` → campaigns (cascade), `row_number` int, `phone_e164` text, `data` jsonb (raw columns for variable mapping).
- Unique (`campaign_id`, `phone_e164`); duplicates are counted as skipped.

---

## 4. Templates & media

### Template (`templates`), FR-016–FR-019

| Field | Type | Rules |
|---|---|---|
| waba_id | text | |
| meta_template_id | text? | null while a local draft |
| name | text | `^[a-z0-9_]{1,512}$` |
| language | text | e.g. `en_US` |
| category | enum `MARKETING \| UTILITY \| AUTHENTICATION` | |
| parameter_format | enum `POSITIONAL \| NAMED` | |
| components | jsonb | Meta component array (HEADER/BODY/FOOTER/BUTTONS) |
| variables | jsonb | derived list `[{ component: "BODY"\|"HEADER"\|"BUTTON", index?, placeholder: "1"\|"name", example }]` |
| status | enum `DRAFT \| PENDING \| APPROVED \| REJECTED \| PAUSED \| DISABLED \| DELETED` | only APPROVED is usable (FR-019) |
| rejection_reason | text? | |
| header_media_asset_id | uuid? → media_assets | |
| last_synced_at | timestamptz? | |
| created_by_id | uuid? | null when synced from Meta |

Unique (`waba_id`, `name`, `language`).

**Validation before submit (FR-018); verify the limits against Meta's docs at implementation:**

- body is required and ≤ 1,024 chars
- header text ≤ 60 chars, footer ≤ 60 chars
- every variable has a sample value
- variables are sequential (`{{1}}…{{n}}`) for POSITIONAL
- buttons ≤ 10 in total: URL ≤ 2, phone ≤ 1
- header media type and size are within Meta's limits

**States:** `DRAFT → PENDING → APPROVED | REJECTED`; `APPROVED → PAUSED → APPROVED | DISABLED`; any state `→ DELETED`. Status changes come from the webhook or a sync and are idempotent.

### MediaAsset (`media_assets`)

| Field | Type | Rules |
|---|---|---|
| storage_key | text | |
| mime_type | text | image/jpeg, image/png, video/mp4, application/pdf |
| size_bytes | int | within Meta limits per type |
| purpose | enum `TEMPLATE_SAMPLE \| CAMPAIGN_HEADER` | |
| meta_header_handle | text? | for template samples |
| meta_media_ids | jsonb | `{ phoneNumberId: { id, uploadedAt } }`, re-uploaded when stale |

---

## 5. Campaigns & messages

### Campaign (`campaigns`), FR-020–FR-031

| Field | Type | Rules |
|---|---|---|
| name | text | 1–120 chars |
| number_id | uuid → whatsapp_numbers | must be CONNECTED with sending enabled to launch |
| template_id | uuid → templates | must be APPROVED to launch |
| state | enum `DRAFT \| SCHEDULED \| RUNNING \| PAUSED \| COMPLETED \| CANCELLED` | |
| audience_type | enum `FILTER \| ALL_OPTED_IN \| UPLOAD \| RETARGET` | |
| audience_filter | jsonb? | `{ all: [ {tag: "vip"}, {attr: "city", op: "eq", value: "Dubai"} ] }` (ops: eq, neq, contains, gt, lt, before, after, is_true, is_false) |
| variable_mapping | jsonb | `{ "BODY.1": { source: "column"\|"field"\|"attribute"\|"static", key, fallback? } }` |
| header_media_asset_id | uuid? | required when the template header is media |
| scheduled_at | timestamptz? | must be in the future when scheduling |
| timezone | text | IANA |
| source_campaign_id | uuid? → campaigns | retarget origin |
| retarget_status | enum `FAILED \| NOT_READ \| READ \| DELIVERED`? | |
| paused_reason | text? | e.g. `token_expired`, `template_paused`, `manual` |
| launched_at / completed_at / cancelled_at | timestamptz? | |
| totals | jsonb | cached counts per status; refreshed by worker every 5 s while running |
| estimated_cost_usd_micros | bigint | pre-launch estimate |
| created_by_id | uuid → users | |

**State machine:**

```text
DRAFT --launch(now)--> RUNNING --all messages final--> COMPLETED
DRAFT --launch(at)--> SCHEDULED --time reached--> RUNNING
SCHEDULED --unschedule--> DRAFT
RUNNING --pause(manual|auto)--> PAUSED --resume--> RUNNING
SCHEDULED|RUNNING|PAUSED --cancel--> CANCELLED   (PENDING/QUEUED messages -> CANCELLED)
```

- A campaign is COMPLETED when no message remains `PENDING`, `QUEUED` or `SENDING`.
- Delivered and read updates keep arriving after completion.

### Message (`messages`): one row per recipient per campaign, or per API send

| Field | Type | Rules |
|---|---|---|
| origin | enum `CAMPAIGN \| API` | |
| campaign_id | uuid? → campaigns | required when `origin = CAMPAIGN` |
| api_key_id | uuid? → api_keys | required when `origin = API` |
| contact_id | uuid? → contacts | null after contact deletion |
| phone_e164 | text? | null after contact deletion |
| recipient_country | char(2) | kept for cost after deletion |
| number_id | uuid → whatsapp_numbers | |
| template_id | uuid → templates | |
| resolved_params | jsonb | final parameter values (fallbacks applied) |
| status | enum `PENDING \| QUEUED \| SENDING \| SENT \| DELIVERED \| READ \| FAILED \| SKIPPED \| CANCELLED` | |
| skip_reason | enum `OPTED_OUT \| NO_OPT_IN \| INVALID_NUMBER \| DUPLICATE \| MISSING_VARIABLE`? | FR-021 |
| failure_code | int? | Meta error code |
| failure_reason | text? | readable text |
| attempts | int | default 0 |
| wa_message_id | text? | unique |
| pricing_category | text? | from the webhook `pricing.category` |
| billable | bool? | from the webhook `pricing.billable` |
| cost_usd_micros | bigint? | set on billable delivery |
| queued_at / sent_at / delivered_at / read_at / failed_at | timestamptz? | |

**Constraints:**

- Unique (`campaign_id`, `contact_id`) where `campaign_id` is not null. This enforces at most one message per recipient per campaign (FR-022).
- Indexes: (`campaign_id`, `status`), (`api_key_id`, `created_at`), unique `wa_message_id`.

**Status precedence (FR-025):** `PENDING(0) < QUEUED(1) < SENDING(2) < SENT(3) < DELIVERED(4) < READ(5)`.

- An update applies only if its rank is greater than the current rank.
- `FAILED` applies only while the current rank is below DELIVERED.
- `SKIPPED` and `CANCELLED` are set only by the platform, from PENDING or QUEUED.
- The pause path moves `QUEUED → PENDING`.

### MessageEvent (`message_events`)

| Field | Type | Rules |
|---|---|---|
| message_id | uuid → messages | cascade delete |
| type | enum `QUEUED \| SENT_ACCEPTED \| SENT \| DELIVERED \| READ \| FAILED \| RETRY_SCHEDULED \| SKIPPED \| CANCELLED \| REQUEUED` | |
| occurred_at | timestamptz | Meta timestamp when from a webhook |
| payload | jsonb | errors / pricing / attempt |
| dedupe_key | text | unique, e.g. `wamid.X:delivered` or `{messageId}:retry:{n}` |

### WebhookEvent (`webhook_events`)

| Field | Type | Rules |
|---|---|---|
| received_at | timestamptz | |
| signature_valid | bool | invalid → rejected with 401 and stored with `payload = null` for audit |
| payload | jsonb? | raw body; retained 30 days |
| processed_at | timestamptz? | |
| error | text? | processing failure (dead-letter visibility) |

---

## 6. Cost, API & notifications

### RateCardEntry (`rate_card_entries`), FR-029

| Field | Type | Rules |
|---|---|---|
| category | enum `MARKETING \| UTILITY \| AUTHENTICATION \| SERVICE` | |
| country_code | text | ISO-2 or `*` default |
| price_usd_micros | bigint | ≥ 0 |
| effective_from | date | |

- Unique (`category`, `country_code`, `effective_from`).
- **Lookup:** the latest `effective_from` ≤ the message date, matching the exact country, else `*`.

### ApiKey (`api_keys`), FR-032–FR-037

| Field | Type | Rules |
|---|---|---|
| name | text | |
| prefix | char(8) | lookup aid |
| key_hash | text | unique, SHA-256 |
| last4 | char(4) | |
| rate_limit_per_minute | int | default 60 |
| created_by_id | uuid → users | |
| last_used_at | timestamptz? | |
| revoked_at | timestamptz? | revoked keys are rejected |

### IdempotencyRecord (`idempotency_records`), FR-036

| Field | Type | Rules |
|---|---|---|
| api_key_id | uuid → api_keys | |
| key | text | ≤ 255 chars |
| request_hash | text | SHA-256 of the normalised body |
| message_id | uuid → messages | |
| expires_at | timestamptz | created_at + 24 h; purged hourly |

Unique (`api_key_id`, `key`).

### Notification (`notifications`), FR-038

| Field | Type | Rules |
|---|---|---|
| user_id | uuid? → users | null = all admins |
| type | enum `CAMPAIGN_COMPLETED \| CAMPAIGN_AUTO_PAUSED \| QUALITY_DROPPED \| CREDENTIALS_FAILED` | |
| title / body | text | |
| link | text? | |
| read_at | timestamptz? | |

---

## Relationships

```text
User 1─* Session, User 1─* Invitation(invited_by), User 1─* AuditLog(actor)
WhatsAppNumber 1─* Campaign, WhatsAppNumber 1─* Message
Template 1─* Campaign, Template 1─* Message, MediaAsset 0..1─* Template/Campaign
Contact *─* Tag (ContactTag), Contact 1─* ConsentEvent, Contact 1─* Message
Campaign 1─* Message, Campaign 1─* CampaignUploadRow, Campaign 0..1─* Campaign(retarget source)
Message 1─* MessageEvent
ApiKey 1─* Message(API), ApiKey 1─* IdempotencyRecord
```

## Retention

| Data | Retention |
|---|---|
| Campaigns and messages | 12 months after a campaign ends (API messages: 12 months), then purged by the daily retention job |
| Audit logs | ≥ 12 months |
| Webhook events and import files | 30 days |
| Idempotency records | 24 hours |
