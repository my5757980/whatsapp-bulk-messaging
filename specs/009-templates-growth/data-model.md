# Data Model: More Template Types, Campaign Reports and the Website Chat Button

**Feature**: `009-templates-growth` | **Date**: 2026-11-27 | **Research**: [research.md](./research.md)

Conventions as in 001–008: uuid v7 ids, snake_case tables and columns, `timestamptz`, Prisma
migrations. One migration: `apps/api/prisma/migrations/20261210000000_templates_growth`.

## Enums

| Enum | Change |
|---|---|
| `TemplateKind` (new) | `STANDARD`, `CAROUSEL`, `LIMITED_TIME_OFFER`, `AUTHENTICATION` |
| `TtlAppliedBy` (new) | `META` (code and utility templates), `PLATFORM` (marketing) |
| `MessageOrigin` | + `OTP` |
| `MessageStatus` | + `EXPIRED` (final) |
| `ExpiredReason` (new) | `EXPIRED_BEFORE_SENDING`, `NOT_DELIVERED_IN_TIME`, `OFFER_ENDED` |
| `SkipReason` | + `OFFER_CODE_MISSING`, `MEDIA_URL_MISSING` |
| `ChatLinkSource` (new) | `MANUAL` (006 links), `WIDGET` (made for a website button, hidden from the chat links list) |
| `ChatWidgetStatus` (new) | `ACTIVE`, `PAUSED` |

Status ranking (shared `status.ts`): `EXPIRED` ranks below `DELIVERED`, `READ` and `FAILED`. So a
late Meta webhook replaces a `NOT_DELIVERED_IN_TIME` mark, while `EXPIRED_BEFORE_SENDING` and
`OFFER_ENDED` are never sent and never change.

## Template → `templates` (extended)

| Field | Type | Notes |
|---|---|---|
| kind | TemplateKind | Default `STANDARD`; existing rows get `STANDARD` |
| ttlSeconds | int? | Codes 30–900, utility 30–43200, marketing 43200–2592000 (R8); null means Meta's default and no platform drop |
| ttlAppliedBy | TtlAppliedBy? | Derived from the category when `ttlSeconds` is set |
| options | jsonb | The kind's settings (below); `{}` for `STANDARD` |

`options` by kind:
- **AUTHENTICATION:**
  - `securityNote` (bool)
  - `codeExpiryMinutes` (1–90 or null)
  - `button`: `COPY_CODE` or `ONE_TAP`
  - `buttonText` and `autofillText` (25 characters each)
  - `apps`: 1–5 `{packageName, signatureHash}`, for `ONE_TAP`
- **CAROUSEL:**
  - `cards`: 2–10 items, each `{ sampleMediaAssetId, bodyText?, bodyExamples[], buttons[] }`
  - `cardMediaFormat`: `IMAGE` or `VIDEO`
- **LIMITED_TIME_OFFER:**
  - `offerText` (up to 16 characters) and `showsEndTime` (bool)
  - `codeExample` (up to 15 characters)
  - the url button is in `components`

**Validation:** shared `validateTemplate` per kind (R2, R6, R7).
- An authentication body cannot be edited.
- Carousel and offer templates are marketing only.
- Offer templates have no footer.
- Carousel cards share one format and the same button types.

## Campaign → `campaigns` (extended)

| Field | Type | Notes |
|---|---|---|
| allowDuplicateRows | boolean | Default false; only for `UPLOAD` audiences (R10) |
| offerConfig | jsonb? | `{ endsAt, code: {source: 'static'\|'column'\|'attribute', value?, key?} }` for offer templates (R7) |
| cardMedia | jsonb? | Carousels: `[{ cardIndex, mediaAssetId }]`, defaulting to the template's samples (R6) |
| launchedById | uuid? → users | Set at launch; backfilled from `campaign.launched` audit entries, else `created_by_id` (R14) |

The variable mapping (`variable_mapping`, 001) gains these keys:
- `HEADER.media`: sources `static`, `column` or `attribute`, holding a URL (R9)
- `CARD.{i}.BODY.{n}` and `CARD.{i}.BUTTON.{b}` (R6)

**Launch checks** (shared `campaign-launch-checks`):
- the offer end is in the future and after the scheduled start
- card media matches the template's format and size limits and is uploaded to the number (R6)
- media addresses are checked (R9)

## Message → `messages` (extended)

| Field | Type | Notes |
|---|---|---|
| copyIndex | int | Default 0; 1, 2… for extra rows of one contact with `allowDuplicateRows` (R10) |
| expiredReason | ExpiredReason? | Set with status `EXPIRED` |
| expiresAt | timestamptz? | `sent_at + ttl` for Meta-applied TTL; read by the expired sweep |

- **Unique key:** `(campaign_id, contact_id, copy_index)` replaces `(campaign_id, contact_id)`.
- **New indexes:** `(created_at)` for the overview report, and a partial index `(expires_at) WHERE
  status = 'SENT'` for the sweep.
- **OTP rows:**
  - `origin = OTP`, `contact_id` null, `phone_e164`, `api_key_id`
  - `template_id`, `number_id`
  - `resolved_params` with the code masked; never the code (R4)

## MetaMediaUpload → `meta_media_uploads` (new)

A Meta media id for a library file on one number, reused by carousel campaigns (R6).

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| mediaAssetId | uuid → media_assets | `CASCADE` |
| numberId | uuid → whatsapp_numbers | `CASCADE` |
| metaMediaId | varchar(80) | From `POST /{phone-number-id}/media` |
| uploadedAt | timestamptz | Uploaded again after 25 days; rows deleted after 30 |

**Unique:** `(media_asset_id, number_id)`.

## OtpSettings → `otp_settings` (new, one row)

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| defaultTemplateId | uuid? → templates | An approved `AUTHENTICATION` template; `SET NULL` |
| defaultNumberId | uuid? → whatsapp_numbers | `SET NULL` |
| limitPerPhone | int | Default 5 (1–50) |
| limitWindowMinutes | int | Default 15 (1–1440) |
| updatedById | uuid? → users | |
| updatedAt | timestamptz | |

The per-phone counter lives in Redis (`wbm:otp:phone:{sha256}`, expiring with the window); nothing
about the code is stored.

## ChatWidget → `chat_widgets` (new)

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| key | char(12) unique | Public, from the 005 link code alphabet; in the snippet |
| name | citext unique | For the team |
| numberId | uuid → whatsapp_numbers | `RESTRICT`; a connected number when saved |
| chatLinkId | uuid → chat_links | The default message's link (`source: WIDGET`) |
| look | jsonb | `{ colour (#RRGGBB), buttonText (≤ 30), corner: 'BOTTOM_LEFT'\|'BOTTOM_RIGHT', offsetX, offsetY (0–200 px), radius (0–40 px) }` |
| brandName | varchar(60) | |
| brandImageAssetId | uuid? → media_assets | `SET NULL`; JPEG or PNG up to 1 MB |
| greeting | varchar(300) | |
| message | varchar(500) | The default pre-filled message |
| rules | jsonb | Ordered `[{ id, match: 'EXACT'\|'PREFIX'\|'CONTAINS', value (≤ 200), hide, greeting?, message?, chatLinkId? }]`, up to 50; a rule with its own message gets its own `WIDGET` chat link |
| status | ChatWidgetStatus | |
| createdById | uuid? → users | |
| createdAt, updatedAt | timestamptz | |

The public config (contracts/website-button.md) is built from this row. Opens and chats started are
read from the widget's chat links.

## ChatLink (extended, 006)

| Field | Type | Notes |
|---|---|---|
| source | ChatLinkSource | Default `MANUAL`; `WIDGET` links are hidden from the chat links list |
| widgetId | uuid? → chat_widgets | `CASCADE` for `WIDGET` links |
| widgetRuleId | varchar(40)? | The rule whose message the link carries; null for the default |

## ChatLinkOpen (extended, 006)

| Field | Type | Notes |
|---|---|---|
| page | varchar(200)? | The page path from the widget's `p` parameter, without query or fragment values |

**Index:** `(chat_link_id, page)` for per-page counts.

## ConsentEvent (index only, 001)

New index `(created_at)` for the opt-in and opt-out report.

## Not stored

- **Sample templates and help content:** shared data files (`packages/shared/src/templates/samples.ts`,
  `packages/shared/src/help/*.ts`), versioned with the code (R12, R13).
- **Reports:** streamed and never stored (R14).
- **Generator results:** computed per request (R16).
- **One-time codes:** they exist only in the request and the encrypted send job (R4).

## Retention and erasure

| Data | Kept | Erasure of a contact |
|---|---|---|
| OTP messages (`origin = OTP`) | 30 days | Messages to the contact's phone lose the phone |
| meta_media_uploads | 30 days after upload | n/a |
| chat_link_opens.page | as chat link opens (12 months, 006) | n/a (no contact on opens) |
| chat_widgets | until deleted | n/a |
| Campaign messages with `copy_index` > 0 | as campaign messages (12 months, 001) | As 001: the contact link, phone and parameters are cleared |
| consent_events | as 001 | Deleted with the contact (001) |

## State changes

- **Message:**
  - `QUEUED` → `EXPIRED` (`EXPIRED_BEFORE_SENDING` or `OFFER_ENDED`) at send time, with no Meta call
  - `SENT` → `EXPIRED` (`NOT_DELIVERED_IN_TIME`) by the sweep
  - `EXPIRED` → `DELIVERED`, `READ` or `FAILED` when a late webhook arrives (`NOT_DELIVERED_IN_TIME`
    only)
- **OTP message:** `QUEUED` → `SENT` → `DELIVERED` → `READ`, or `FAILED` (or `EXPIRED` at either
  point). Each change emits `otp.status`.
- **Chat widget:** `ACTIVE` ↔ `PAUSED`. While its number is not `CONNECTED`, the config is
  `{hidden: true}` whatever the status, and managers get a notification once per disconnection.
