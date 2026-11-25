# Data Model: Click-to-WhatsApp Ads and the Ads Manager

**Feature**: `007-ads-manager` | **Date**: 2026-11-25 | **Research**: [research.md](./research.md)

Conventions as in 001–006: uuid v7 ids, snake_case, `timestamptz`, soft deletes only where noted.
Money from Meta is kept in the ad account currency's **minor units** (`bigint`) with the currency
code beside it; it is never converted to USD.

## 1. New tables

### ads_connections

One row: the company's ad account and page (FR-001 – FR-004, R1, R2).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ad_account_id | varchar(40) | `act_…` without the prefix |
| ad_account_name | varchar(200) | |
| page_id | varchar(40) | |
| page_name | varchar(200) | |
| token_enc | text | system user token, 001 `TokenCipher` |
| page_token_enc | text? | page token for lead forms |
| currency | char(3) | from Meta |
| timezone | varchar(64) | from Meta (IANA name) |
| status | `AdsConnectionStatus` | `CONNECTED`, `ERROR` |
| checks | jsonb | last check results, no secrets |
| checked_at | timestamptz | |
| monthly_cap_minor | bigint? | spending cap; null = none (FR-018) |
| capped_month | char(7)? | `YYYY-MM` when the cap paused ads, so they are not paused twice |
| connected_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

A partial unique index on a constant keeps it to one row. Disconnecting deletes the row (ads keep
running at Meta; platform campaigns become read-only).

### ad_campaigns

What a manager builds (FR-005 – FR-020, FR-024).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among campaigns not deleted |
| goal | `AdGoal` | `CHATS`, `LEADS`, `WEBSITE` |
| status | `AdCampaignStatus` | see §3 |
| number_id | uuid? FK whatsapp_numbers `RESTRICT` | CHATS: fixed once submitted |
| prefilled_message | varchar(300)? | CHATS |
| welcome_sequence_id | varchar(40)? | Meta's welcome message sequence (R4) |
| lead_form_id | uuid? FK ad_lead_forms `RESTRICT` | LEADS |
| website_url | varchar(2000)? | WEBSITE |
| link_code | char(10)? unique | WEBSITE: `/l/a/:code` (R10) |
| targeting | jsonb | locations, ages, genders, interests, audiences in/out (shared schema) |
| placements | jsonb | `{ auto: true }` or chosen platforms and positions |
| special_category | `AdSpecialCategory` | `NONE` default |
| daily_budget_minor | bigint | ≥ Meta's minimum at submit |
| currency | char(3) | copied from the connection |
| start_at | timestamptz | |
| end_at | timestamptz? | |
| flow_id | uuid? FK flows `SET NULL` | starts for chats from this campaign |
| tag_id | uuid? FK tags `SET NULL` | added to contacts from chats or leads |
| meta_campaign_id / meta_adset_id | varchar(40)? | set when submitted |
| meta_status | varchar(40)? | last `effective_status` of the campaign |
| last_error | varchar(500)? | Meta's message when submitting or syncing failed |
| synced_at | timestamptz? | last status sync |
| submitted_at / ended_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| deleted_at | timestamptz? | drafts only |
| created_at / updated_at | timestamptz | |

Indexes: `(status)`, `(flow_id)`, `(tag_id)`, `(number_id)`.

### ad_versions

One creative of a campaign, one ad at Meta (FR-009, FR-012, FR-013).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ad_campaign_id | uuid FK ad_campaigns `CASCADE` | |
| position | smallint | 1–5 |
| media_asset_id | uuid FK media_assets `RESTRICT` | image or video from the 001 library |
| media_kind | `AdMediaKind` | `IMAGE`, `VIDEO` |
| meta_image_hash / meta_video_id | varchar(100)? | after upload |
| primary_text | varchar(2200) | |
| headline | varchar(255) | |
| call_to_action | varchar(40) | from the goal's allowed list |
| meta_creative_id / meta_ad_id | varchar(40)? | `meta_ad_id` unique |
| status | `AdVersionStatus` | `DRAFT`, `IN_REVIEW`, `ACTIVE`, `PAUSED`, `REJECTED`, `ENDED` |
| review_feedback | varchar(1000)? | Meta's reason when rejected |
| created_at / updated_at | timestamptz | |

Unique `(ad_campaign_id, position)`.

### ad_result_days

Meta's numbers per day in the account's time zone (FR-026, FR-027, R7).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ad_campaign_id | uuid FK ad_campaigns `CASCADE` | |
| ad_version_id | uuid? FK ad_versions `CASCADE` | null = the campaign's own row (reach) |
| day | date | |
| impressions / reach / clicks | bigint | |
| spend_minor | bigint | |
| meta_conversations | int | messaging conversations started (Meta's count) |
| meta_leads | int | |
| read_at | timestamptz | |

Unique `(ad_campaign_id, ad_version_id, day)` with `NULLS NOT DISTINCT`.

### ad_chat_starts

A chat that began from an ad (FR-021 – FR-024, R11).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| meta_ad_id | varchar(40) | Meta's `source_id` |
| ad_campaign_id | uuid? FK ad_campaigns `SET NULL` | null = "Other ads" |
| ad_version_id | uuid? FK ad_versions `SET NULL` | |
| contact_id | uuid? FK contacts `SET NULL` | |
| conversation_id | uuid? FK conversations `SET NULL` | |
| new_contact | boolean | from the 001 inbound handler's flag |
| headline / body | varchar(500)? | from the referral |
| media_url | varchar(2000)? | image, video or thumbnail URL |
| source_url | varchar(2000)? | |
| ctwa_clid | varchar(200)? | absent for Status placements |
| first_reply_at | timestamptz? | first business reply, for the free window |
| started_at | timestamptz | |

Unique `(meta_ad_id, contact_id, (started_at AT TIME ZONE 'UTC')::date)`; indexes on
`(ad_campaign_id, started_at)` and `(conversation_id)`.

### ad_audiences and ad_audience_members

Saved audiences at Meta (FR-031 – FR-034, R8).

`ad_audiences`:

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique among audiences not deleted |
| kind | `AdAudienceKind` | `CUSTOM`, `LOOKALIKE` |
| source | jsonb | CUSTOM: `{ type: tag, tagId }`, `{ type: filter, filter }` or `{ type: campaign_group, campaignId, group }` |
| origin_audience_id | uuid? FK ad_audiences `CASCADE` | LOOKALIKE |
| lookalike_country | char(2)? / lookalike_ratio | numeric(4,2)? 0.01–0.10 |
| meta_audience_id | varchar(40)? | |
| member_count | int | people we sent (CUSTOM) |
| status | `AdAudienceStatus` | `SYNCING`, `READY`, `TOO_SMALL`, `ERROR` |
| last_error | varchar(500)? | |
| synced_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| deleted_at | timestamptz? | the Meta audience is deleted too |
| created_at / updated_at | timestamptz | |

`ad_audience_members`: `(audience_id uuid FK CASCADE, contact_id uuid, phone_hash char(64), added_at)`,
primary key `(audience_id, contact_id)`. `contact_id` has no foreign key: a deleted contact's row
stays until the next sync removes its hash at Meta, then goes.

### ad_lead_forms and ad_leads

Lead forms and their leads (FR-035 – FR-039, R9).

`ad_lead_forms`:

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext | unique |
| questions | jsonb | standard (name, phone, email) and up to 3 own questions |
| privacy_url | varchar(2000) | |
| consent_text | varchar(300) | must name WhatsApp |
| tag_id | uuid? FK tags `SET NULL` | |
| welcome_template_id | uuid? FK templates `SET NULL` | |
| welcome_mapping | jsonb | variable sources (lead answers or contact fields) |
| meta_form_id | varchar(40)? unique | |
| last_lead_at | timestamptz? | catch-up cursor |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

`ad_leads`:

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| form_id | uuid FK ad_lead_forms `CASCADE` | |
| meta_lead_id | varchar(40) unique | once each |
| meta_ad_id | varchar(40)? | |
| ad_campaign_id | uuid? FK ad_campaigns `SET NULL` | |
| answers | jsonb | `{ field: value }`; cleared on contact deletion |
| phone_e164 | varchar(16)? | |
| email | varchar(320)? | |
| consent | boolean | the WhatsApp checkbox |
| contact_id | uuid? FK contacts `SET NULL` | |
| status | `AdLeadStatus` | `PROCESSED`, `NO_PHONE`, `INVALID_PHONE`, `FAILED` |
| welcome_message_id | uuid? FK messages `SET NULL` | |
| submitted_at / received_at | timestamptz | |

### ad_link_opens

Website ad visits (FR-030, R10): `(id uuid PK, ad_campaign_id uuid FK CASCADE, device ClickDevice,
opened_at timestamptz)`, index `(ad_campaign_id, opened_at)`. No IP is stored.

## 2. Changed tables and enums

- `messages`: `ad_lead_id uuid? FK ad_leads SET NULL` (the welcome template), indexed.
- `MessageOrigin` + `ADS` (shown as automatic in live chat).
- `ConsentSource` + `LEAD_FORM`.
- `JourneyEventType` + `AD_CHAT_STARTED`, `LEAD_RECEIVED`.
- `NotificationType` + `ADS_CONNECTION_ERROR`, `AD_REJECTED`, `AD_NOT_DELIVERING`,
  `ADS_SPEND_CAP_REACHED`.
- Outbound event types (006 catalog) + `ad.chat_started`, `ad.lead_received`.
- New enums: `AdsConnectionStatus`, `AdGoal`, `AdCampaignStatus`, `AdSpecialCategory`,
  `AdMediaKind`, `AdVersionStatus`, `AdAudienceKind`, `AdAudienceStatus`, `AdLeadStatus`.

## 3. State machines

**Ad campaign**:

```text
DRAFT ──submit──▶ SUBMITTING ──ok──▶ IN_REVIEW ──Meta approves──▶ ACTIVE ◀──resume── PAUSED
  ▲                   │                  │                          │  └──pause / cap──▶ PAUSED
  └──duplicate        └──Meta error──▶ ERROR (fix and submit again)  ├──all versions rejected──▶ REJECTED
                                                                     └──end date / end──▶ ENDED
```

- `SUBMITTING` is held while the Meta objects are made; a failure rolls back and sets `ERROR` with
  Meta's message.
- `REJECTED` returns to `IN_REVIEW` when a rejected version is edited and resubmitted.
- Meta's states win: a campaign paused in Meta's tools shows `PAUSED` at the next sync.
- `ENDED` and deleted drafts are final.

**Ad version**: `DRAFT → IN_REVIEW → ACTIVE ⇄ PAUSED`, `IN_REVIEW → REJECTED → IN_REVIEW` (edited),
any → `ENDED` with the campaign.

**Saved audience**: `SYNCING → READY | TOO_SMALL | ERROR`; each daily sync passes through `SYNCING`.

## 4. Validation rules (from the spec)

- A campaign has 1–5 versions; each has media, primary text and headline within Meta's hard limits,
  and a call to action allowed for the goal.
- CHATS needs a number linked to the page (when Meta lets us read it) and a pre-filled message of
  1–300 characters; LEADS needs a lead form; WEBSITE needs an https URL.
- `daily_budget_minor` ≥ Meta's minimum for the currency; `end_at` > `start_at`; `start_at` not in
  the past at submit (it becomes now).
- Age 18–65 (65 = 65 and over); with a special category, ages, gender and detailed targeting follow
  Meta's limits (the builder disables them).
- Launches and budget increases respect the cap (R7).
- A lead form has a consent question naming WhatsApp and a privacy link; at most 3 own questions.
- An audience needs at least 100 people to be offered (R8).

## 5. Retention and erasure

- Daily retention: `ad_result_days` after 25 months; `ad_leads`, `ad_chat_starts` and
  `ad_link_opens` after 12 months.
- Contact deletion: their leads' `answers`, `phone_e164` and `email` are cleared (status kept for
  counts); their chat starts keep the row with `contact_id` null; their audience memberships are
  removed at Meta by the next audience sync (the row's hash is used for the removal, then dropped).
- Audit actions (FR-041): `ads.connected`, `ads.disconnected`, `ads.checks_run`,
  `ads.spend_cap_changed`, `ad_campaign.created`, `ad_campaign.submitted`, `ad_campaign.paused`,
  `ad_campaign.resumed`, `ad_campaign.ended`, `ad_campaign.budget_changed`,
  `ad_campaign.duplicated`, `ad_audience.created`, `ad_audience.deleted`, `ad_lead_form.created`,
  `ad_leads.exported`.
