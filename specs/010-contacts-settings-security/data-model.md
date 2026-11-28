# Data Model: Contacts, Settings and Security

**Feature**: `010-contacts-settings-security` | **Date**: 2026-11-28 | **Migration**:
`20261217000000_contacts_settings_security`

All ids are UUID v7, and all times are `timestamptz`. The conventions are those of 001–009:
snake_case columns, Prisma models in PascalCase and audit through `audit_logs`.

## 1. New enums

| Enum | Values |
|---|---|
| `LeadSourceKind` | `UNKNOWN`, `ORGANIC`, `API`, `IMPORT`, `CAMPAIGN_UPLOAD`, `CHAT_LINK`, `AD`, `LEAD_FORM`, `FORM`, `WEBSITE_BUTTON`, `STORE`, `CUSTOM` |
| `BulkActionKind` | `TAG_ADD`, `TAG_REMOVE`, `DRIP_ENROL` |
| `BulkActionStatus` | `QUEUED`, `RUNNING`, `DONE`, `FAILED` |
| `AutoTagEvent` | `CONTACT_CREATED`, `CAMPAIGN_REPLY`, `LINK_CLICK`, `OPTED_IN`, `OPTED_OUT` |
| `DateAutomationTiming` | `YEARLY`, `ONCE` |
| `DateAutomationStatus` | `OFF`, `ON`, `PAUSED` |
| `OccurrenceStatus` | `PENDING`, `SENT`, `SKIPPED`, `FAILED` |

**Values added to existing enums:**
- `AudienceType`: `SEGMENT`
- `MessageOrigin`: `DATE_AUTOMATION`
- `NotificationType`: `DATE_AUTOMATION_PAUSED`

## 2. Changed tables

### contacts (001, 002)

| Column | Type | Notes |
|---|---|---|
| `lead_source_kind` | `LeadSourceKind` NOT NULL DEFAULT `UNKNOWN` | Set only in the create branch (R5). The migration maps existing `lead_source` text to kinds. |
| `lead_source` | varchar(80) (existing) | Now the label: the import label, a custom label or a chat link name. |

- **New index:** `contacts (lead_source_kind)`.

### campaigns (001)

| Column | Type | Notes |
|---|---|---|
| `segment_id` | uuid NULL → `segments.id` ON DELETE RESTRICT | Set when `audience_type = SEGMENT`. A check makes it required for SEGMENT and empty otherwise. |

### settings (001)

| Column | Type | Notes |
|---|---|---|
| `opt_out_reply` | jsonb NOT NULL DEFAULT `{"kind":"NONE"}` | `{ kind: NONE \| TEXT \| TEMPLATE, text?, templateId?, variables? }` (R8) |
| `opt_in_reply` | jsonb NOT NULL DEFAULT `{"kind":"NONE"}` | as above |
| `require_2fa` | boolean NOT NULL DEFAULT false | Company setting (FR-028) |

### messages (001)

- **New index:** `messages (contact_id, created_at)`, for behaviour rules over "any campaign in the
  last N days" (R1).

## 3. New tables

### segments

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar(80) UNIQUE NOT NULL | |
| `description` | varchar(300) NULL | |
| `rules` | jsonb NOT NULL | `SegmentRulesSchema`: 1–5 groups, 1–30 rules in total |
| `created_by_id` | uuid → users ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz | |

- **Rules:**
  - Members are never stored.
  - Deleting a segment is refused while a draft, scheduled, running or paused campaign uses it
    (`SEGMENT_IN_USE`); the RESTRICT foreign key is the database guard.

### bulk_actions

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | `BulkActionKind` | |
| `params` | jsonb | `{ tagIds: [] }`, or `{ dripId }` |
| `selection` | jsonb | `{ contactIds: [≤10,000] }`, `{ filter }` or `{ segmentId }` |
| `status` | `BulkActionStatus` DEFAULT `QUEUED` | `QUEUED → RUNNING → DONE \| FAILED` |
| `total` | int NULL | known once counted |
| `processed`, `changed` | int DEFAULT 0 | updated per batch |
| `result` | jsonb NULL | for `DRIP_ENROL`: the 005 counts (enrolled, opted out, already in, not found) |
| `error` | varchar(300) NULL | |
| `created_by_id` | uuid → users | |
| `created_at`, `started_at`, `finished_at` | timestamptz | |

- **Retention:** deleted after 90 days. It holds selections and counts, never contact lists beyond
  the chosen ids.

### auto_tag_rules

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `event` | `AutoTagEvent` | |
| `lead_source_kind` | `LeadSourceKind` NULL | Required for `CONTACT_CREATED`, empty otherwise (check) |
| `tag_id` | uuid → tags ON DELETE CASCADE | |
| `enabled` | boolean DEFAULT true | |
| `created_by_id` | uuid → users | |
| `created_at` | timestamptz | |

- **Unique:** `(event, lead_source_kind, tag_id)`.

### global_attributes

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `key` | varchar(40) UNIQUE | `^[a-z][a-z0-9_]{0,39}$`, separate from contact attribute keys |
| `description` | varchar(200) NULL | |
| `value` | varchar(1024) NOT NULL DEFAULT '' | Empty values are refused where they are used (FR-016) |
| `updated_by_id` | uuid → users ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz | |

### date_automations

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar(80) UNIQUE | |
| `attribute_key` | varchar(40) | Must name a DATE attribute definition |
| `timing` | `DateAutomationTiming` | |
| `offset_days` | smallint DEFAULT 0 | −30 to 30 (check) |
| `send_time` | char(5) | `HH:mm`, company time zone |
| `number_id` | uuid → whatsapp_numbers ON DELETE RESTRICT | |
| `template_id` | uuid → templates ON DELETE RESTRICT | Must be APPROVED when switched on |
| `variable_mapping` | jsonb DEFAULT `{}` | the 001 `VariableMapping`, with the `global` source |
| `status` | `DateAutomationStatus` DEFAULT `OFF` | |
| `paused_reason` | varchar(120) NULL | `TEMPLATE_NOT_APPROVED`, `NUMBER_DISCONNECTED` or `SENDING_OFF` |
| `last_run_date` | date NULL | last company date fully processed |
| `created_by_id` | uuid → users | |
| `created_at`, `updated_at` | timestamptz | |

- **Status changes:**
  - `OFF ⇄ ON` by a member with `campaigns.launch`.
  - `ON → PAUSED` by the tick, on a template or number problem; admins are notified.
  - `PAUSED → ON` by a member, after the problem is fixed. It starts from the current day.

### date_automation_occurrences

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `automation_id` | uuid → date_automations ON DELETE CASCADE | |
| `contact_id` | uuid → contacts ON DELETE CASCADE | Erasure removes the rows |
| `due_date` | date | company date |
| `status` | `OccurrenceStatus` DEFAULT `PENDING` | `PENDING → SENT \| SKIPPED \| FAILED` |
| `reason` | varchar(40) NULL | `opted_out`, `blocked`, `invalid`, `no_date`, `missing_value`, `not_opted_in`, `too_late` or `send_failed` |
| `message_id` | uuid NULL → messages ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz | |

- **Unique:** `(automation_id, contact_id, due_date)`. This is the double-send guard (SC-004).
- **Index:** `(automation_id, due_date, status)`.
- **Retention:** deleted with their messages after 12 months.

### user_two_factor

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK → users ON DELETE CASCADE | |
| `secret_enc` | text | base32 secret encrypted with `TokenCipher` |
| `enabled_at` | timestamptz NULL | NULL while setup is not confirmed |
| `last_step` | bigint NULL | last accepted time step (replay guard) |
| `created_at`, `updated_at` | timestamptz | |

### user_recovery_codes

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid → users ON DELETE CASCADE | |
| `code_hash` | char(64) | HMAC-SHA256 with the server key |
| `used_at` | timestamptz NULL | |
| `created_at` | timestamptz | |

- **Rules:** 10 rows per member; making new codes deletes the old ones. Turning 2FA off or a reset
  deletes both tables' rows for the member.

### number_business_profiles

| Column | Type | Notes |
|---|---|---|
| `number_id` | uuid PK → whatsapp_numbers ON DELETE CASCADE | |
| `about`, `address`, `description`, `email`, `vertical` | text NULL | as Meta returned them |
| `websites` | text[] DEFAULT `{}` | |
| `profile_picture_url` | text NULL | Meta's address (short-lived), shown, never fetched by us |
| `name_status`, `new_name_status` | varchar(20) NULL | |
| `verified_name` | varchar(200) NULL | |
| `read_at` | timestamptz | last read from Meta |
| `changed_at`, `changed_by_id` | timestamptz NULL, uuid NULL | last change through the platform |

### oba_checklist

| Column | Type | Notes |
|---|---|---|
| `id` | smallint PK DEFAULT 1 | single row (check `id = 1`) |
| `steps` | jsonb DEFAULT `{}` | `{ stepId: { done: boolean, at, byId } }`, with ids from `@wbm/shared` |
| `applied_at` | date NULL | |
| `result` | varchar(20) NULL | `PENDING`, `APPROVED` or `DECLINED` |
| `note` | varchar(500) NULL | |
| `updated_at`, `updated_by_id` | | |

## 4. Shared data (not tables)

- **`SegmentRulesSchema`:** the rule kinds of R1. Each rule has a stable index used in error
  details.
- **`LEAD_SOURCE_LABELS` and `legacyLeadSource(text)`:** the R5 mapping, used by the migration test.
- **`dueOn(date, timing, offset, today)`:** the yearly, once and 29 February rules of R9.
- **`BUSINESS_PROFILE_LIMITS`, `BUSINESS_VERTICALS` and `PROFILE_PICTURE_RULES`:** see R11.
- **`OBA_CHECKLIST_STEPS` and `NUMBER_GUIDES`:** text, links and `checkedAt` (R12).

## 5. Validation summary

- **Segments:** 1–5 groups and 1–30 rules in total. Tag, attribute and campaign references must
  exist when saved; later deletions mark the rule broken. Day windows are 7, 30 or 90 for behaviour,
  and 1–365 for `added` and `last_inbound`.
- **Bulk actions:** at least one tag; a selection is required; explicit ids at most 10,000.
- **Global attributes:** key pattern and uniqueness, value up to 1,024 characters. Deletion is
  refused while in use (R7).
- **Keyword replies:**
  - TEXT: 1–1,024 characters.
  - TEMPLATE: approved and `UTILITY`, with every variable mapped (fields, attributes or global
    attributes).
- **Date automations:**
  - The attribute is a DATE attribute; offset −30 to 30; `send_time` matches `^([01]\d|2[0-3]):[0-5]\d$`.
  - The template is approved; marketing templates are allowed and send only to opted-in contacts.
  - Every variable is mapped.
- **2FA:** codes are 6 digits; recovery codes are 10 characters from the link-code alphabet,
  case-insensitive. Five wrong codes in a row lock the second step for 15 minutes.
- **Business profile:** the R11 limits are checked before anything is sent to Meta.
