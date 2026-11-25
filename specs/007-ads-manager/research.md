# Research: Click-to-WhatsApp Ads and the Ads Manager

**Feature**: `007-ads-manager` | **Date**: 2026-11-25 | **Plan**: [plan.md](./plan.md)

Public sources only (Meta's developer documentation, read 2026-11-25; list at the end). Field names
marked *(verify)* are documented in places that disagree or were not shown in full. They are pinned
in `contracts/meta-ads-graph.md` and mock-meta, and checked against Meta's reference when the client
method is written (T-tasks call this out). Nothing here copies a competitor's design.

## R1. One Graph client, one version, one token

- **Decision:**
  - The Marketing API is part of the Graph API. Ads calls use the pinned `META_GRAPH_API_VERSION`
    (v27.0, as 001 and 006) through a new thin `MetaAdsClient` beside `MetaGraphClient`, with the same
    timeout, error parsing (`MetaApiError`) and network error rules.
  - The company's own Meta app and a **system user token** of its business portfolio, with these
    permissions: `ads_management`, `ads_read`, `business_management`, `pages_show_list`,
    `pages_read_engagement`, `pages_manage_ads`, `pages_manage_metadata`, `leads_retrieval`, and
    `whatsapp_business_management` (for the pre-filled message, R4).
  - The token is stored with the 001 `TokenCipher`. The page token that lead forms need is read from
    `GET /me/accounts` with the system user token and stored encrypted too.
  - Rate limits: Marketing API calls are counted per ad account (business use case limits). The
    client reads the `x-business-use-case-usage` header and slows syncs above 75%.
- **Rationale:** one version and one client style keep upgrades deliberate (constitution I). A
  system user token does not expire with a person's session.
- **Alternatives considered:** the official `facebook-nodejs-business-sdk`: rejected, large and
  generated for every object; we use a few calls. Facebook Login for each manager: rejected, one
  company uses one business portfolio.

## R2. The ads connection checks (reusing the 006 wizard pattern)

- **Decision:**
  - `POST /ads/connection/token` checks the token with `debug_token` (app token when `META_APP_ID`
    is set, as in 006), lists ad accounts (`GET /me/adaccounts?fields=account_id,name,account_status,
    disable_reason,currency,timezone_name,funding_source_details`) and pages (`GET /me/accounts`). A
    session in Redis holds the encrypted token for 30 minutes (as the 006 wizard).
  - Checks, each PASSED / FAILED / WARNING with a fix (shared `adsChecks`):
    - token: valid, expiry, the permissions in R1 (missing ones named)
    - ad account: `account_status` 1 = active; other values (disabled, unsettled, pending review,
      closed) fail with `disable_reason`; a missing funding source fails
    - currency and time zone shown (information)
    - page: can be used for ads (`tasks` include ADVERTISE)
    - WhatsApp numbers linked to the page: read with the page field Meta documents *(verify)*; when
      it cannot be read, a WARNING says Meta checks the link when the ad is created
    - terms: the ad account's custom audience terms (`tos_accepted`) and the page's lead terms
      (`leadgen_tos_accepted`) *(verify)*; missing terms are WARNINGs that block only audiences or
      lead forms
  - The saved connection is one row (one ad account, one page). "Run checks" repeats them with the
    stored token; a failed token or account check sets the connection to ERROR, which blocks
    launches and changes (FR-004) and alerts admins.
- **Rationale:** the same flow admins know from the number wizard; each check maps to one field.

## R3. Object structure: one campaign, one ad set, up to five ads

- **Decision:** a platform ad campaign is created at Meta as:
  - **Campaign:** `objective` by goal (ODAX): chats → `OUTCOME_ENGAGEMENT`; leads →
    `OUTCOME_LEADS`; website → `OUTCOME_TRAFFIC`. `special_ad_categories` from the builder (empty
    array for none). `status: ACTIVE` once launched.
  - **Ad set:** `daily_budget` in the account currency's minor units, `start_time`, `end_time`,
    `billing_event: IMPRESSIONS`, `targeting` (R5), and by goal:
    - chats: `destination_type: WHATSAPP`, `optimization_goal: CONVERSATIONS`,
      `promoted_object: { page_id, whatsapp_phone_number }`
    - leads: `destination_type: ON_AD`, `optimization_goal: LEAD_GENERATION`,
      `promoted_object: { page_id }`
    - website: `destination_type: WEBSITE`, `optimization_goal: LINK_CLICKS`
    `promoted_object` cannot change after creation, so the number is fixed once launched.
  - **Ads:** one per version, each with its creative (R4). Created `ACTIVE`; Meta sets
    `effective_status: PENDING_REVIEW` until review ends.
  - Launch order: media upload → creatives → campaign → ad set → ads. A failure part way rolls back by
    deleting what was made, so a retry starts clean; the campaign shows ERROR with Meta's message.
- **Rationale:** the smallest structure that covers the spec; complex structures stay in Meta's
  tools (spec Assumptions).

## R4. Creatives and the pre-filled message

- **Decision:**
  - **Media:** files come from the 001 media library. Images go to `POST /act_{id}/adimages` (returns
    a hash); videos to `POST /act_{id}/advideos` (returns an id; the version waits until Meta's
    processing is ready). Before upload the platform checks Meta's published limits: images JPG or
    PNG up to 30 MB and at least 600 px wide; videos MP4 or MOV up to 4 GB and 1 second to 241
    minutes; ratios 1.91:1 to 9:16.
  - **Creative:** `object_story_spec` with the page, the primary text, the headline and the image
    hash or video id. Buttons: chats → `WHATSAPP_MESSAGE`; leads → `SIGN_UP` (or `LEARN_MORE`);
    website → `LEARN_MORE`, `SHOP_NOW` or `CONTACT_US`, with the tracked link (R10).
  - **Pre-filled message (chats):** Meta's documented way is a *welcome message sequence* on the
    WhatsApp Business Account (`POST /{waba-id}/welcome_message_sequences`, with the pre-filled text
    in `autofill_message`), referenced from the creative in
    `asset_feed_spec.additional_data.partner_app_welcome_message_flow_id` *(verify the combination
    with `object_story_spec`)*. Without it, Meta shows its default "Hello! Can I get more info on
    this?".
  - **Text limits:** the builder enforces Meta's hard limits and shows the recommended lengths
    (primary text 125 characters, headline 40) as hints.
- **Rationale:** documented fields only; the default greeting is the fallback if the sequence
  cannot be made.

## R5. Targeting, estimates and minimum budgets

- **Decision:**
  - Locations from `GET /search?type=adgeolocation` (countries, regions, cities), interests from
    `GET /search?type=adinterest`; ages 18–65+, genders all/men/women; custom audiences to include
    or exclude (R8).
  - Placements: automatic (no placement fields), or chosen: `publisher_platforms` facebook and
    instagram with feeds and stories positions. **WhatsApp Status** is offered for chat ads with an
    image or video only, as Meta documents it (the `whatsapp` platform with the `status` position,
    with Instagram stories selected too *(verify)*), so Status ads are in scope where the account
    has them (spec: "if Meta offers them").
  - Special ad categories apply Meta's limits: no age, gender or detailed targeting changes beyond
    what Meta allows; the builder disables those fields.
  - The audience size comes from `GET /act_{id}/delivery_estimate` (or `reachestimate`), shown as a
    range; "-1" means unavailable (custom audiences).
  - Minimum budgets from `GET /act_{id}/minimum_budgets` (per currency): the builder uses
    `min_daily_budget_imp` and refuses lower budgets.
- **Rationale:** these are Meta's own lookup endpoints, so labels and limits stay current.

## R6. Status and review sync

- **Decision:** an `ads` BullMQ queue with an `ads-status` job every 5 minutes for campaigns in
  review, active or paused: read the campaign, ad set and ads (`effective_status`, `configured_status`,
  `ad_review_feedback`/`review_feedback` *(verify the field name)*, `issues_info`). The platform
  state follows Meta's: PENDING_REVIEW → In review; ACTIVE → Active; PAUSED / CAMPAIGN_PAUSED /
  ADSET_PAUSED → Paused; DISAPPROVED → Rejected (the version, with the reason); WITH_ISSUES or
  PENDING_BILLING_INFO → Error with an alert; ended dates → Ended. Changes made in Meta's tools are
  read, never undone (FR-017). A rejected version is edited by a new creative on the same ad.
- **Rationale:** a 5-minute poll meets SC-002 (15 minutes) with few calls; Meta's ads webhooks need
  more setup for little gain at this scale.

## R7. Results and the spending cap

- **Decision:**
  - An `ads-insights` job every hour for active campaigns (and once a day for the last 28 days of
    every campaign that ran, as Meta updates attribution):
    `GET /{campaign-id}/insights?level=ad&time_increment=1&fields=ad_id,impressions,reach,clicks,
    ctr,cpc,spend,actions,cost_per_action_type`, plus one campaign-level call for reach (reach cannot
    be added up). Meta's conversations come from the `onsite_conversion.messaging_conversation_started_7d`
    action. Rows go to `ad_result_days` in the account's time zone and currency.
  - The platform's own numbers come from its records: chats started and new contacts
    (`ad_chat_starts`), contacts who replied (a customer message after the first business reply),
    leads (`ad_leads`), visits (website links, R10).
  - **Cap:** spend this month (account time zone) from insights. A launch, resume or budget increase
    is refused when *spend so far + the daily budgets of the platform's active campaigns, with the new
    one, × the days left this month* would pass the cap. The hourly job pauses every platform
    campaign when the month's spend reaches the cap, and alerts admins and managers (SC-006: at most
    about two hours past the cap with hourly insights).
- **Rationale:** Meta's numbers stay Meta's; our counts come from our data, so cost per chat uses
  both.

## R8. Audiences from contacts

- **Decision:**
  - `POST /act_{id}/customaudiences` with `subtype: CUSTOM`, `customer_file_source:
    USER_PROVIDED_ONLY`. Members are added with `POST /{audience-id}/users` and removed with
    `DELETE`, in batches of at most 10,000, with the schema `PHONE_SHA256`: E.164 digits without the
    plus sign and without leading zeros, SHA-256 in lowercase hex. Only phone numbers are sent
    (FR-044).
  - Sources: a tag, a saved contact filter (the 001 audience filter) or a 005 campaign group. Opted-out,
    blocked and deleted contacts are always left out.
  - `ad_audience_members` keeps the hashes sent, so the daily `ads-audiences` job sends only the
    difference (adds and removals). Changes reach Meta's matching within about 24 hours (SC-007 is
    measured from our removal call).
  - Lookalikes: `subtype: LOOKALIKE`, `origin_audience_id`, `lookalike_spec: { country, ratio }`
    (1–10%). A source needs at least 100 people; smaller audiences are shown as too small and not
    offered (FR-034).
  - The ad account must accept the custom audience terms (R2 check).
- **Rationale:** the documented customer file flow; keeping the hashes we sent is the only way to
  remove people without resending everything.

## R9. Lead forms and leads

- **Decision:**
  - Forms are created with `POST /{page-id}/leadgen_forms` (page token): questions full name, phone,
    email and up to three custom questions, `privacy_policy` (URL and link text), and a custom
    disclaimer checkbox that names WhatsApp, unticked by default *(verify field names)*. Forms
    cannot be changed at Meta after use; editing makes a new form.
  - The page is subscribed to the `leadgen` field (`POST /{page-id}/subscribed_apps`). Meta posts
    page webhooks to the app's callback, the same `/api/webhooks/meta` route as WhatsApp (object
    `page`, field `leadgen`, value with `leadgen_id`, `form_id`, `ad_id`, `created_time`), signed
    with the app secret, so the 001 receiver stores and checks them. A new handler fetches the lead
    (`GET /{leadgen-id}?fields=created_time,ad_id,form_id,field_data,custom_disclaimer_responses`).
  - A catch-up job every 15 minutes reads `GET /{form-id}/leads` since the last lead, so missed
    notifications are recovered. `ad_leads.meta_lead_id` is unique, so each lead is recorded once.
  - Each lead with a valid phone upserts a contact (country from the phone, else the company
    default), adds the form's tag, and opts in with source `LEAD_FORM` only when the WhatsApp
    checkbox was ticked. A chosen welcome template is sent once to consenting leads through the 001
    send queue.
  - Lead retrieval needs `leads_retrieval` and `pages_manage_ads`; Meta may require App Review or
    advanced access. The release checklist lists it.
- **Rationale:** the documented lead ads flow; the catch-up covers Meta's webhook gaps.

## R10. Website ads

- **Decision:** a website ad links to `${PUBLIC_LINK_BASE_URL}/a/{code}` (one code per ad campaign),
  answered by the api at `/l/a/:code` with the 005 rules (previews and robots not counted, the same
  rate limit) and a 302 to the destination with `utm_source=meta&utm_medium=paid&utm_campaign=<name>`
  added. Visits are counted per day (`ad_link_opens`).
- **Rationale:** a per-recipient 005 tracked link does not fit ads (there is no recipient). This
  reuses the 006 chat link redirect pattern in a few lines.

## R11. Chats from ads

- **Decision:**
  - The 002 inbound handler reads `messages[].referral` (`source_type: ad`, `source_id` = the ad id,
    `source_url`, `headline`, `body`, `media_type`, `image_url`/`video_url`/`thumbnail_url`,
    `ctwa_clid`, which Meta leaves out for Status placements). It is stored in the chat item's payload
    and passed to an `AdChatMatcher`, called before the 006 chat link matcher and the 003 flow router.
  - The matcher records an `ad_chat_starts` row (once per contact per ad per day), links it to the
    platform's ad version by `meta_ad_id` (else "Other ads"), adds the campaign's tag, writes the
    `AD_CHAT_STARTED` journey entry, and starts the campaign's flow with the 006 rules (not over a
    running flow or a member's chat). New contacts use the 001 inbound handler's new-contact flag
    (006).
  - The flow link lives on the ad campaign (`flow_id`); the flow builder's **Ads** trigger card edits
    the same link (FR-025), so there is one source of truth.
  - **Free ad window:** Meta's rule (2026): a chat from an ad opens a free entry point window of 72
    hours when the business replies within 24 hours; some sources report longer windows being
    rolled out. Live chat shows "Free ad window until …" computed as 72 hours from the first
    business reply when it came within 24 hours (a setting, `ADS_FREE_WINDOW_HOURS`, default 72),
    labelled as Meta's rule. Sending rules do not change (FR-023).
- **Rationale:** referral data is the documented link between a chat and its ad.

## R12. AI ad texts

- **Decision:** `POST /ads/ai-text` calls the 004 AI service with a short system prompt (goal, offer
  description, language, Meta's limits) and asks for JSON `{ primaryText, headline }` (up to 3
  options). It counts against the 004 monthly limit and applies the AI settings' content rules. It
  never submits.
- **Rationale:** reuses the existing service, settings and limits.

## R13. Permissions, audit, retention, metrics and alerts

- **Decision:**
  - Permissions reuse existing ones: connecting, the cap and disconnecting need
    `integrations.manage` (admins); building, audiences and lead forms need `campaigns.manage`;
    submitting, pausing, resuming, ending and budget changes need `campaigns.launch`; viewing needs
    `campaigns.view` (agents see masked phones); exports need `data.export`.
  - Audit actions: `ads.connected`, `ads.disconnected`, `ads.checks_run`, `ads.spend_cap_changed`,
    `ad_campaign.created`, `ad_campaign.submitted`, `ad_campaign.paused`, `ad_campaign.resumed`,
    `ad_campaign.ended`, `ad_campaign.budget_changed`, `ad_campaign.duplicated`,
    `ad_audience.created`, `ad_audience.deleted`, `ad_lead_form.created`, `ad_leads.exported`.
  - Retention: `ad_result_days` 25 months; `ad_leads` 12 months; `ad_chat_starts` 12 months;
    `ad_link_opens` 12 months. Deleting a contact clears their leads' answers and phone, sets their
    chat starts' contact to null, and queues their removal from audiences.
  - Metrics: `wbm_ads_sync_total{job,result}`, `wbm_ad_chat_starts_total{matched}`,
    `wbm_ad_leads_total{result}`, `wbm_ads_spend_cap_pauses_total`. Alert `WbmAdsSyncFailing`
    (over 50% of syncs failing for 30 minutes).
  - Outbound webhook events (006): `ad.chat_started` and `ad.lead_received` (ids, form or ad, and the
    contact id; answers only for endpoints that include content).

## R14. Testing

- **Decision:**
  - Unit (shared): targeting validation, budget and cap math, referral parsing, text limits, phone
    normalization for hashing, status mapping, free window computation.
  - Integration (nock Graph): the connection checks, launch with rollback, status sync, insights and
    the cap, audiences with diffs, leads (webhook and catch-up, once each), chats from ads with the
    tag and flow, website link counting, permissions, retention and erasure.
  - mock-meta gains ads routes (`tools/mock-meta/src/ads.ts`): ad accounts and pages, objects with
    review that turns ACTIVE after a few seconds (a word in the text makes it DISAPPROVED), insights
    that grow, audiences, lead forms with a test lead, and `mock:inbound --referral-ad <ad-id>`.
  - E2e (Playwright): connect, build and launch a chat ad to Active, a chat from it with its flow and
    tag, results, pause and the cap, an audience from a tag, a lead form lead.
- **Rationale:** the same test levels as 001–006; Meta is always mocked (constitution V).

## Sources (read 2026-11-25)

- [Ads that Click to WhatsApp](https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp)
- [Click to multidestination](https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-multidestination)
- [Ad promoted object](https://developers.facebook.com/docs/marketing-api/reference/ad-promoted-object)
- [Ad set destination type](https://developers.facebook.com/docs/marketing-api/adset/destination_type/)
- [Welcome message sequences](https://developers.facebook.com/documentation/business-messaging/whatsapp/ctwa/welcome-message-sequences/)
- [Ads in WhatsApp Status](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-in-whatsapp-status) and [placement targeting](https://developers.facebook.com/docs/marketing-api/audiences/reference/placement-targeting)
- [Webhook text message reference (referral)](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text)
- [Conversation-based pricing: free entry point](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing/)
- [Customer file custom audiences](https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences) and [users edge](https://developers.facebook.com/docs/marketing-api/reference/custom-audience/users)
- [Lead ads webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen) and [retrieving leads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving)
- [Ad account minimum budgets](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/minimum_budgets)
- [Ads effective status](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/effective-status)
- [Ads action stats](https://developers.secure.facebook.com/docs/marketing-api/reference/ads-action-stats/)
- [Targeting search](https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search) and [delivery estimate](https://developers.facebook.com/docs/marketing-api/reference/ad-account/delivery_estimate)
