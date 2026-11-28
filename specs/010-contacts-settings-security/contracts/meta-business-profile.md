# Contract: Meta Graph Calls for the Business Profile and Number Status

**Feature**: 010 (US7, FR-031, FR-032, research R11) | **Checked against Meta's documentation**:
2026-11-28 | **Graph version**: the pinned `META_GRAPH_VERSION` of 001

All calls use the 001 `MetaGraphClient` with the system user token, retries and error mapping. The
`FakeGraph` (integration) and mock-meta (`tools/mock-meta/src/business-profile.ts`, e2e) answer the
same paths with Meta's response and error shapes.

## 1. Read the business profile

```text
GET /{phone-number-id}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical
```

- **Answer:** `{ "data": [ { "about": "...", "address": "...", "description": "...", "email": "...",
  "profile_picture_url": "https://...", "websites": ["https://..."], "vertical": "RETAIL",
  "messaging_product": "whatsapp" } ] }`.
- `profile_picture_url` is a short-lived Meta address. The web app shows it as given, and the
  platform never downloads it.

## 2. Change the business profile

```text
POST /{phone-number-id}/whatsapp_business_profile
{ "messaging_product": "whatsapp", "about": "...", "address": "...", "description": "...",
  "email": "...", "websites": ["https://..."], "vertical": "RETAIL", "profile_picture_handle": "..." }
```

- **Fields:** only changed fields are sent, and `messaging_product` is always present.
- **Answer:** `{ "success": true }`. The service then reads the profile again (§1) and returns what
  Meta holds.
- **Our checks before the call** (shared `BUSINESS_PROFILE_LIMITS`):

  | Field | Rule |
  |---|---|
  | `about` | 1–139 characters, not empty |
  | `address` | up to 256 characters |
  | `description` | up to 512 characters |
  | `email` | a valid email, up to 128 characters |
  | `websites` | up to 2, each up to 256 characters, starting with `http://` or `https://` |
  | `vertical` | empty, or one of `ALCOHOL`, `APPAREL`, `AUTO`, `BEAUTY`, `EDU`, `ENTERTAIN`, `EVENT_PLAN`, `FINANCE`, `GOVT`, `GROCERY`, `HEALTH`, `HOTEL`, `NONPROFIT`, `ONLINE_GAMBLING`, `OTC_DRUGS`, `OTHER`, `PHYSICAL_GAMBLING`, `PROF_SERVICES`, `RESTAURANT`, `RETAIL`, `TRAVEL` |

## 3. Profile picture

1. The platform checks the file: JPEG or PNG, square, at least 192×192 pixels, up to 5 MB. Otherwise
   `422 PICTURE_RULES`. Meta's API pages give no exact limit, so this is our guard, confirmed on the
   real account in the release checklist.
2. It uploads through the 001 Resumable Upload flow:
   - `POST /{app-id}/uploads?file_length=…&file_type=image/jpeg`, which returns `upload:…`
   - `POST /upload:…` with the bytes and `file_offset: 0`, which returns `{ "h": "<handle>" }`
3. It sends `POST /{phone-number-id}/whatsapp_business_profile` with `profile_picture_handle: <handle>`
   (§2).
4. The file is not stored by the platform.

## 4. Number status

```text
GET /{phone-number-id}?fields=verified_name,name_status,new_name_status,quality_rating,whatsapp_business_manager_messaging_limit
```

| Field | Meaning | Shown as |
|---|---|---|
| `verified_name` | the display name | the name |
| `name_status` | `APPROVED`, `DECLINED`, `EXPIRED`, `PENDING_REVIEW` or `NONE` | a badge; for `DECLINED` and `EXPIRED`, steps to request again in WhatsApp Manager |
| `new_name_status` | present only when a name change was requested | "Name change: pending / approved / declined" |
| `quality_rating` | `GREEN`, `YELLOW`, `RED` or `NA` | as in 001 |
| `whatsapp_business_manager_messaging_limit` | the messaging limit, shared by every number of the business portfolio | the limit; replaces the deprecated `messaging_limit_tier` |

- The answer is cached for 5 minutes per number, and also refreshed by the 001 number sync, which
  stores the limit in the existing `messaging_limit_tier` column.

## 5. Errors

| Meta answer | Platform answer |
|---|---|
| network error or 5xx after the 001 retries | `502 META_UNAVAILABLE` |
| 4xx with `error.message` and `error_user_msg` | `502 META_REFUSED`; `details` holds the field when Meta names one, and Meta's message |
| `190` token problems | `502 META_REFUSED`, and the 001 token alert path |
| number not connected (001 state) | `409 NUMBER_NOT_CONNECTED`, without calling Meta |

## 6. Audit

`business_profile.changed` records the number, the changed field names and the actor. It never
records the values, which can hold personal contact details.
