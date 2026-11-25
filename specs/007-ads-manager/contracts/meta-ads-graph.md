# Meta Graph calls used by 007 (and answered by mock-meta)

Version: the pinned `META_GRAPH_API_VERSION` (v27.0). Base `${META_GRAPH_BASE_URL}/${version}`.
Auth: `Authorization: Bearer <system user token>` unless a page token is named. Items marked
*(verify)* are checked against Meta's reference when the client method is written; mock-meta and
the nock fakes follow this file.

## Connection (R1, R2)

| Call | Purpose |
|---|---|
| `GET /debug_token?input_token=…` | token validity, scopes, expiry (as 006) |
| `GET /me/adaccounts?fields=account_id,name,account_status,disable_reason,currency,timezone_name,funding_source_details` | ad accounts |
| `GET /me/accounts?fields=id,name,tasks,access_token` | pages and page tokens |
| `GET /act_{id}?fields=tos_accepted` | custom audience terms *(verify)* |
| `GET /{page-id}?fields=leadgen_tos_accepted,whatsapp_number` | lead terms and the linked number *(verify)* |

## Building (R3–R5)

| Call | Purpose |
|---|---|
| `GET /search?type=adgeolocation&q=…&location_types=["country","region","city"]` | locations |
| `GET /search?type=adinterest&q=…` | interests |
| `GET /act_{id}/delivery_estimate?targeting_spec=…&optimization_goal=…` | audience size |
| `GET /act_{id}/minimum_budgets` | minimum daily budgets per currency |
| `POST /act_{id}/adimages` (bytes) → `images.{name}.hash` | image upload |
| `POST /act_{id}/advideos` (file) → `id`; `GET /{video-id}?fields=status` | video upload and readiness |
| `GET /{video-id}?fields=picture` | the thumbnail a video creative needs (`video_data.image_url`) |
| `POST /{waba-id}/welcome_message_sequences` → `sequence_id` | pre-filled message (`autofill_message`) |
| `POST /act_{id}/adcreatives` → `id` | creative (`object_story_spec`, `asset_feed_spec.additional_data.partner_app_welcome_message_flow_id` for chats *(verify)*) |
| `POST /act_{id}/campaigns` → `id` | `name`, `objective`, `special_ad_categories` (`[]`, `CREDIT`, `EMPLOYMENT`, `HOUSING`, `ISSUES_ELECTIONS_POLITICS` *(verify: credit may be `FINANCIAL_PRODUCTS_SERVICES` on newer versions)*), `special_ad_category_country` with a category, `is_adset_budget_sharing_enabled: false` (budgets live on the ad set) *(verify)*, `status` |
| `POST /act_{id}/adsets` → `id` | `campaign_id`, `daily_budget`, `start_time`, `end_time`, `billing_event`, `bid_strategy: LOWEST_COST_WITHOUT_CAP`, `optimization_goal`, `destination_type`, `promoted_object` (chats: `{ page_id, whatsapp_phone_number: "+<digits>" }`), `targeting`, `status` |
| `POST /act_{id}/ads` → `id` | `adset_id`, `creative: { creative_id }`, `status` |
| `DELETE /{id}` | rollback of a failed launch |

## Running and results (R6, R7)

| Call | Purpose |
|---|---|
| `GET /{campaign-id}?fields=effective_status,configured_status,start_time,stop_time` | campaign state |
| `GET /{adset-id}?fields=effective_status,daily_budget,end_time` | ad set state |
| `GET /{adset-id}/ads?fields=id,effective_status,ad_review_feedback,issues_info` | versions *(verify the feedback field)* |
| `POST /{campaign-id}` `{ status: PAUSED or ACTIVE }` | pause, resume, end (`ARCHIVED` is not used; ending sets the end time to now and pauses) |
| `POST /{adset-id}` `{ daily_budget, end_time }` | budget and end date |
| `POST /{ad-id}` `{ status }`, `{ creative: { creative_id } }` | pause a version, resubmit an edited version |
| `GET /{campaign-id}/insights?level=ad&time_increment=1&time_range=…&fields=ad_id,impressions,reach,clicks,ctr,cpc,spend,actions,cost_per_action_type` | per version per day |
| `GET /{campaign-id}/insights?time_increment=1&time_range=…&fields=reach,impressions,spend` | campaign reach per day |

Meta's conversations: `actions[action_type = onsite_conversion.messaging_conversation_started_7d]`;
leads: `actions[action_type = lead]`.

## Audiences (R8)

| Call | Purpose |
|---|---|
| `POST /act_{id}/customaudiences` `{ name, subtype: CUSTOM, customer_file_source: USER_PROVIDED_ONLY }` | create |
| `POST /{audience-id}/users` `{ payload: { schema: "PHONE_SHA256", data: [hash, …] } }` | add (≤ 10,000 per call) |
| `DELETE /{audience-id}/users` (same payload) | remove |
| `POST /act_{id}/customaudiences` `{ subtype: LOOKALIKE, origin_audience_id, lookalike_spec: { country, ratio } }` | lookalike |
| `GET /{audience-id}?fields=approximate_count_lower_bound,operation_status` | size and state |
| `DELETE /{audience-id}` | delete |

## Lead forms (R9)

| Call | Purpose |
|---|---|
| `POST /{page-id}/leadgen_forms` (page token) | create a form: questions, privacy policy, custom disclaimer checkbox *(verify)* |
| `POST /{page-id}/subscribed_apps` `{ subscribed_fields: leadgen }` (page token) | lead notifications |
| `GET /{leadgen-id}?fields=created_time,ad_id,form_id,field_data,custom_disclaimer_responses` | one lead |
| `GET /{form-id}/leads?filtering=[{field:"time_created",operator:"GREATER_THAN",value:…}]` | catch-up |

Webhook (to `/api/webhooks/meta`, app secret signature):

```json
{ "object": "page", "entry": [{ "id": "<page-id>", "time": 1764000000,
  "changes": [{ "field": "leadgen", "value": { "leadgen_id": "…", "form_id": "…", "ad_id": "…", "page_id": "…", "created_time": 1764000000 } }] }] }
```

## Inbound referral (R11)

In `messages[]` of a WhatsApp `messages` webhook:

```json
"referral": { "source_url": "https://fb.me/…", "source_id": "<ad-id>", "source_type": "ad",
  "headline": "…", "body": "…", "media_type": "image", "image_url": "https://…",
  "ctwa_clid": "…" }
```

`ctwa_clid` is left out for Status placements; some referrals carry only `source_url`.

## mock-meta behaviour

- Token `mock-ads-token-ok` (20+ characters) has every permission; `mock-ads-token-no-leads` lacks
  `leads_retrieval`. Ad account `act_MOCKADS` (AED, Asia/Dubai, active), page `MOCKPAGE` linked to
  the mock numbers.
- New ads stay `PENDING_REVIEW` for 3 seconds, then `ACTIVE`; a version whose primary text contains
  `reject-me` becomes `DISAPPROVED` with a reason.
- Insights add impressions, clicks and spend each time they are read while active.
- `POST /mock/ads/lead` sends a signed `leadgen` webhook for a form with given answers.
- `npm run mock:inbound -- --referral-ad <ad-id>` adds a referral to the customer message.
