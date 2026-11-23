# Data Model: Campaign Growth

**Feature**: `005-campaign-growth` | **Date**: 2026-11-23 | **Research**: [research.md](./research.md)

Conventions as in 001–004: uuid v7 ids, snake_case tables and columns, `timestamptz`, Prisma
migrations only (`apps/api/prisma/migrations/20261128000000_campaign_growth`).

## 1. New tables

### tracked_link_targets

One tracked button or link variable of a campaign or a drip step (FR-001, FR-006, FR-007).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid? FK campaigns `CASCADE` | exactly one of campaign_id or drip_step_id |
| drip_step_id | uuid? FK drip_steps `CASCADE` | |
| variable_key | varchar(20) | 001 variable key, for example `BUTTON.0.1` or `BODY.2` |
| destination | varchar(2000) | `https://` or `http://` address |
| add_campaign_tags | boolean, default false | adds `utm_source=whatsapp`, `utm_medium=message`, `utm_campaign=<name>` |
| created_at / updated_at | timestamptz | |

Unique `(campaign_id, variable_key)` and `(drip_step_id, variable_key)`. Check constraint: one owner.

### tracked_links

One recipient's short link (FR-002).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| code | char(10) unique | random `[0-9A-Za-z]`, never reused |
| target_id | uuid FK tracked_link_targets `CASCADE` | |
| message_id | uuid FK messages `CASCADE` | purged with the message (FR-039) |
| contact_id | uuid? FK contacts `SET NULL` | null after erasure |
| created_at | timestamptz | |

Unique `(message_id, target_id)`.

### link_clicks

One real click (previews and robots are only counted in metrics; FR-003, FR-004).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| tracked_link_id | uuid FK tracked_links `CASCADE` | |
| target_id | uuid | copied for grouping |
| campaign_id | uuid? | copied; null for drips |
| drip_step_id | uuid? | copied; null for campaigns |
| contact_id | uuid? FK contacts `SET NULL` | |
| device | enum `ClickDevice` (`MOBILE`, `DESKTOP`, `OTHER`) | |
| clicked_at | timestamptz | |

Indexes: `(campaign_id, contact_id)`, `(drip_step_id, contact_id)`, `(target_id)`, `(clicked_at)`.
No IP address is stored.

### campaign_retry_rounds

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid FK campaigns `CASCADE` | |
| round | smallint | 1–3 |
| status | enum `RetryRoundStatus` (`SCHEDULED`, `RUNNING`, `DONE`, `CANCELLED`, `SKIPPED`) | |
| due_at | timestamptz | |
| started_at / finished_at | timestamptz? | |
| recipients | int, default 0 | messages put into the round |
| recovered | int, default 0 | of those, ended SENT, DELIVERED or READ |
| note | varchar(200)? | why it was skipped or cancelled |

Unique `(campaign_id, round)`.

### drips

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among drips that are not archived (partial unique index) |
| number_id | uuid FK whatsapp_numbers `RESTRICT` | |
| status | enum `DripStatus` (`DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`) | |
| paused_reason | varchar(40)? | `TEMPLATE_UNAVAILABLE`, `NUMBER_DISCONNECTED`, or null when a member paused it |
| quiet_from / quiet_to | varchar(5)? | `HH:MM` in the company time zone (the 002 working-hours format); both null means no quiet hours; may cross midnight |
| quiet_days | int[] | ISO weekdays the quiet hours apply to; default every day |
| leave_on_reply | boolean, default true | |
| leave_on_click | boolean, default false | |
| stop_tag_ids | uuid[] | |
| allow_rejoin | boolean, default false | |
| activated_at / paused_at / archived_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

### drip_steps

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drip_id | uuid FK drips `CASCADE` | |
| position | smallint | 1–10, unique per drip among live steps |
| template_id | uuid FK templates `RESTRICT` | |
| variable_mapping | jsonb | 001 `VariableMapping` |
| header_media_asset_id | uuid? FK media_assets `SET NULL` | |
| wait_minutes | int | 0 allowed only at position 1; else 10 – 43,200 (30 days) |
| deleted_at | timestamptz? | soft delete: results keep history, waiting contacts move on |
| created_at / updated_at | timestamptz | |

### drip_triggers

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drip_id | uuid FK drips `CASCADE` | |
| kind | enum `DripTriggerKind` (`TAG_ADDED`, `OPTED_IN`, `IMPORTED`, `API_CREATED`, `LINK_CLICKED`) | |
| tag_id | uuid? FK tags `CASCADE` | `TAG_ADDED` only |
| campaign_id | uuid? FK campaigns `CASCADE` | `LINK_CLICKED`; null = any campaign |

### drip_enrolments

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| drip_id | uuid FK drips `CASCADE` | |
| contact_id | uuid? FK contacts `SET NULL` | |
| status | enum `EnrolmentStatus` (`ACTIVE`, `FINISHED`, `LEFT`) | |
| joined_via | enum `DripJoinVia` (`TAG_ADDED`, `OPTED_IN`, `IMPORTED`, `API_CREATED`, `LINK_CLICKED`, `MANUAL`) | |
| joined_by_id | uuid? FK users `SET NULL` | `MANUAL` |
| current_position | smallint | the next step to send |
| next_due_at | timestamptz? | null when finished or left |
| left_reason | enum `DripLeftReason`? | `REPLIED`, `OPTED_OUT`, `BLOCKED`, `DELETED`, `STOP_TAG`, `CLICKED`, `REMOVED`, `INVALID_NUMBER`, `ARCHIVED` |
| joined_at / ended_at | timestamptz | ended = finished or left |

Partial unique index `(drip_id, contact_id) WHERE status = 'ACTIVE'` (FR-026); index
`(status, next_due_at)` for the tick; index `(contact_id, status)` for leaving rules.

### drip_step_sends

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| enrolment_id | uuid FK drip_enrolments `CASCADE` | |
| step_id | uuid FK drip_steps `CASCADE` | |
| outcome | enum `StepOutcome` (`QUEUED`, `SKIPPED`) | the message's own status tells the rest |
| skip_reason | varchar(40)? | `NO_OPT_IN`, `TEMPLATE_UNAVAILABLE`, … |
| message_id | uuid? FK messages `SET NULL` | |
| created_at | timestamptz | |

Unique `(enrolment_id, step_id)`; index `(step_id)`.

### drip_events

Outbox of starting events (R8). Rows are deleted once consumed.

| Column | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| kind | `DripTriggerKind` | |
| contact_id | uuid | |
| tag_id / campaign_id | uuid? | |
| occurred_at | timestamptz | |

## 2. Changed tables and enums

- **campaigns:** + `retry_rounds smallint default 0` (0–3) and `retry_delays_min int[] default '{}'`.
- **messages:**
  - + `retry_round smallint default 0`, the last round that re-sent the message
  - + `drip_enrolment_id uuid?` FK `SET NULL` and + `drip_step_id uuid?` FK `SET NULL`
  - index `(drip_step_id)`
  - drip messages have no `campaign_id`, so the unique `(campaign_id, contact_id)` is unaffected
- **MessageOrigin:** + `DRIP`.
- **RetargetStatus:** + `CLICKED`, `NOT_CLICKED`, `REPLIED`, `NOT_REPLIED`, `HELD_BACK`.
- **JourneyEventType:** + `DRIP_JOINED`, `DRIP_LEFT`, `LINK_CLICKED`.
- **Audit actions:** + `campaign.retry_plan_changed`, `campaign.retry_round_cancelled`,
  `tracked_link.destination_changed`, `drip.created`, `drip.updated`, `drip.activated`,
  `drip.paused`, `drip.resumed`, `drip.archived`, `drip.deleted`, `drip.contacts_enrolled`,
  `drip.contact_removed`.
- **Settings / env:** `PUBLIC_LINK_BASE_URL` (env; required to be `https://` in production).

## 3. State machines

**Drip:** `DRAFT → ACTIVE` (activate; checks of FR-022) `→ PAUSED` (a member, or automatically on
`TEMPLATE_UNAVAILABLE` or `NUMBER_DISCONNECTED`) `→ ACTIVE` (resume, checks again) `→ ARCHIVED`
(from any state; active enrolments leave with `ARCHIVED`). Only `DRAFT` drips with no enrolments
can be deleted.

**Enrolment:** `ACTIVE → FINISHED` (the last step was sent or skipped) or `ACTIVE → LEFT` (a
leaving rule). `next_due_at` moves after each step: the step's wait after the previous step was
sent; when that lands in quiet hours, the tick waits until they end.

**Retry round:** `SCHEDULED → RUNNING → DONE`; `SCHEDULED → CANCELLED` (a member, or the campaign
was cancelled); `SCHEDULED → SKIPPED` (past 24 hours, template unavailable, or number disconnected).
A paused campaign keeps its rounds `SCHEDULED`, and they start after it resumes, if still inside
24 hours.

## 4. Validation rules (from the spec)

- **Tracked links:**
  - destination is a valid `https://` or `http://` address of at most 2,000 characters, not on
    `PUBLIC_LINK_BASE_URL`
  - a URL button can be tracked only when its template address is `${PUBLIC_LINK_BASE_URL}/{{1}}`
  - a body or header variable can be tracked when the variable is mapped to the link
- **Retry plan:**
  - 0–3 rounds, delays from {30, 60, 120, 240, 480, 720} minutes, sum at most 1,440
  - editable while the campaign is `DRAFT` or `SCHEDULED`
- **Drips:**
  - 1–10 steps
  - waits of 10–43,200 minutes (0 allowed at step 1)
  - every step template `APPROVED`, of the drip number's account and fully mapped
  - stop tags exist
  - triggers valid (tag exists, campaign exists)
  - at most 20 active drips
  - at most 100,000 active enrolments per drip
- **Manual enrolment:** at most 100,000 contacts per request; opted-out contacts and contacts
  already in the drip are counted and skipped.

## 5. Retention and erasure

- `link_clicks`: 12 months.
- `tracked_links`: with their message (001 retention).
- `drip_enrolments` and their `drip_step_sends`: 12 months after `ended_at`.
- `drip_events`: consumed rows are deleted; rows older than 1 day are purged.
- `campaign_retry_rounds`: with their campaign.
- Contact deletion:
  - active enrolments end as `LEFT`/`DELETED`
  - `contact_id` is cleared on enrolments, clicks and tracked links
  - counts stay
