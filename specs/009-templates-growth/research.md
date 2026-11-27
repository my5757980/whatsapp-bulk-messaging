# Research: More Template Types, Campaign Reports and the Website Chat Button

**Feature**: `009-templates-growth` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)

Meta facts were read on 2026-11-27 from Meta's WhatsApp Business Platform documentation (sources at
the end). They are re-checked in T-tasks marked *(verify)* before each story ships, as in 001–008.

## R1. One template model for the new kinds

- **Decision:** keep the 001 `templates` row (Meta `components` JSON plus our columns) and add:
  - `kind`: `STANDARD | CAROUSEL | LIMITED_TIME_OFFER | AUTHENTICATION`
  - `ttl_seconds` (nullable) and `ttl_applied_by` (`META | PLATFORM`, derived from the category)
  - `options` JSON for the kind's settings: the code options (security note, code validity, button,
    apps), the carousel's card samples, the offer heading and expiry flag

  The shared `TemplateDraft` (`packages/shared/src/template-rules.ts`) gains `kind`, `cards`, `offer`,
  `auth` and `ttlSeconds`. `validateTemplate` checks every kind, so the web editor and the api report
  the same problems next to the same field (001 FR-018). The 001 submit service maps each kind to
  Meta's components (contracts/meta-templates.md).
- **Rationale:** sends, sync, retargeting and reports keep working on one table. The kinds differ only
  in their components and send parameters.
- **Alternatives considered:** a table per kind (joins everywhere for no gain); storing only Meta's
  components (the editor would have to parse them back, and the code options are not all in them).

## R2. Authentication templates

- **Decision** (Meta, 2026-11-27):
  - **Create:** category `AUTHENTICATION`.
    - `BODY` with `add_security_recommendation` (true adds "For your security, do not share this
      code."). Meta fixes the wording ("*{code}* is your verification code") and translates it.
    - Optional `FOOTER` with `code_expiration_minutes`, 1–90.
    - `BUTTONS` with one `otp` button:
      - `otp_type: copy_code`, with an optional `text` (25 characters)
      - or `otp_type: one_tap`, with `text`, `autofill_text` (25 each) and `supported_apps`: 1–5
        `{package_name, signature_hash}` items. `package_name` has at least two dot-separated
        segments, each starting with a letter, `[a-zA-Z0-9_]`, at most 224 characters.
        `signature_hash` is exactly 11 characters of `[a-zA-Z0-9+/=]`. The legacy top-level
        `package_name` and `signature_hash` are not used (they stop working in v21.0).
    - Meta stores the button as `url`; the sync reads it back.
    - No URLs, media or emojis. Zero-tap is out of scope (spec).
  - **Send:** the code goes twice: as the body's text parameter and as the button parameter
    (`sub_type: url`, `index: 0`).
  - **Code format:** Meta allows up to 15 characters. We accept `^[0-9A-Za-z]{4,15}$`, so mistakes
    such as spaces or a whole sentence are refused before sending.
  - **One-tap:** the company's Android app must start Meta's handshake no more than 10 minutes (or the
    code validity) before the message. That is the app team's work; the release checklist names it,
    and phones without the app see a copy-code button.
- **Rationale:** follow Meta's documented creation and send bodies exactly; the editor offers only the
  options, so templates cannot be refused for wording.
- **Alternatives considered:** letting members type the body (Meta refuses changed wording).

## R3. The one-time code API

- **Decision:**
  - **Route:** `POST /api/v1/otp` with the new API key scope `otp.send`.
    - Body: `{ to, code, template?: {name, language}, numberId? }`. The template and number default to
      the admin's choice in the code settings.
    - Returns `202 { id, status: "queued" }` at once.
    - `Idempotency-Key` works as in 006, so a retried request does not send a second code. The stored
      response holds no code.
  - **Status:** `GET /api/v1/otp/{id}` returns `{ id, to, status, failureCode, failureReason,
    queuedAt, sentAt, deliveredAt, readAt }`. The new outbound event `otp.status` (group `otp`)
    carries the same fields, never the code.
  - **Records:** each code is a `messages` row with the new origin `OTP`:
    - `contact_id` null, `phone_e164` set, `api_key_id`
    - `resolved_params` with the code masked (`••••`)

    No contact is created and consent is not read or changed. Blocked numbers are refused, because
    blocking (002) is the company's own decision about a number.
  - **Limits:**
    - Per phone: a Redis counter `wbm:otp:phone:{sha256(phone)}` with a fixed window. The admin
      setting defaults to 5 codes per 15 minutes; requests above it get `429 TOO_MANY_CODES`.
    - The 006 per-key rate limit still applies.
- **Rationale:** codes are made and checked by the company's own systems (spec assumption); the
  platform delivers them fast and reports the outcome. One message table keeps status webhooks,
  delivery tracking and retention in one place.
- **Alternatives considered:**
  - Reusing `POST /v1/messages`: it needs `messages.send`, checks consent and creates contacts,
    which a code must not do (FR-004, FR-007).
  - A verify service that makes and checks codes: out of scope.

## R4. Keeping the code secret

- **Decision:**
  - The code exists in clear only in the request body and in the encrypted send job.
    - The api encrypts it with the 001 `TokenCipher` into the job's data (`codeEnc`).
    - The send processor decrypts it just before building Meta's payload.
    - OTP jobs use `removeOnComplete: true` and `removeOnFail: true`, so nothing stays in Redis.
  - **Postgres:** `resolved_params` holds the masked code; idempotency records store the masked
    response; audit entries and exports never include it.
  - **Logs:** the send processor and `MetaClient` never log request bodies (verified in T-tasks),
    and `sanitizeLogObject` masks a `code` key.
  - **Test:** `otp-no-code-leak.int-spec.ts` sends codes through success, failure and retry paths, then
    scans messages, idempotency records, audit entries, outbound events, captured logs and Redis job
    data for the codes (SC-002, the 008 card-data scan pattern).
- **Rationale:** a code is a credential for a few minutes; the safest code is one that is never
  written down.
- **Alternatives considered:** an encrypted column on `messages`, cleared after sending (still
  written to disk and to backups).

## R5. Codes first on the number's queue

- **Decision:** OTP send jobs go on the number's 002 send queue **without a priority**. BullMQ runs
  jobs without a priority before prioritized ones (chat replies use 1, campaigns 10). So a code waits
  only for the number's rate limiter, never behind a campaign. If the number is in error, the
  quality rating stops sending, or the number is over its messaging limit, the request fails at once
  with the reason instead of waiting.
- **Rationale:** one queue per number keeps one rate limiter (constitution Principle IV) while codes
  overtake everything else.
- **Alternatives considered:** a separate code queue per number (two limiters could exceed Meta's
  rate); priority 1 shared with chat replies (a busy live chat would delay codes).

## R6. Carousel templates

- **Decision** (Meta, 2026-11-27):
  - **Kind:** marketing only. The spec was corrected from "marketing or utility".
  - **Limits:**
    - 2–10 cards; the number of cards is fixed at creation
    - message body up to 1024 characters with variables
    - card body up to 160 characters; if one card has body text, all must
    - card header: image (JPEG or PNG, 5 MB) or video (MP4, 16 MB), the same format on every card
    - up to 2 buttons per card from `quick_reply`, `url` and `phone_number`, with the same components
      on every card
  - **Create:** card headers use the 001 Resumable Upload `header_handle`, one sample per card.
  - **Send:** a `carousel` component with `cards[card_index]`. Each card's header is
    `{image|video: {id}}`. Only media ids are documented, so the card media is uploaded to the sending
    number with `POST /{phone-number-id}/media` before launch.
    - The 001 cache `media_assets.meta_media_ids` (through `MediaService.ensureMetaMediaId`) keeps one
      Meta id per media asset and number and uploads again when the id is old, so no new table.
    - The same cards go to every recipient (spec FR-011); card body and button variables can differ
      per recipient.
  - **Mapping keys:** `CARD.{i}.BODY.{n}` and `CARD.{i}.BUTTON.{b}` join the 001 keys
    `BODY.{n}`, `HEADER.{n}` and `BUTTON.{b}`.
  - **Quick replies:** each button gets the payload `wbm:c{i}:b{b}`. The 002 parser reads the card and
    button from it, live chat shows "Card 2 · Book now", and 003 template button triggers match on the
    button text as today.
  - **Results:** the same tracked links (005), retry rounds and retargeting as other campaigns.
- **Rationale:** follow the documented structure. One upload per asset and number keeps launch fast
  for large campaigns.
- **Alternatives considered:**
  - Media by link in cards (not documented for carousels).
  - Per-recipient card media (not asked; it would mean one upload per recipient).

## R7. Limited-time offer templates

- **Decision** (Meta, 2026-11-27):
  - **Kind:** marketing only, with no footer.
  - **Create:** components in this order:
    - optional `HEADER`, IMAGE or VIDEO
    - `limited_time_offer`: `text` up to 16 characters, and `has_expiration` to show the end time
    - `BODY` up to 600 characters, variables counted in the limit
    - `BUTTONS`: `copy_code` (example up to 15 characters) and `url` (up to 2000 characters, one
      variable at the end)
  - **Send:**
    - `limited_time_offer` parameter `{expiration_time_ms}`: the end as a Unix time in milliseconds.
      The page's example value looks like a duration; we send the timestamp *(verify on mock and on
      the release check)*.
    - `copy_code` button parameter `{type: coupon_code, coupon_code}` (up to 15 characters, index 0).
    - The url button at index 1.
  - **Campaign:** the campaign's `offer_config` holds `{ endsAt, code: {source: static|column|attribute,
    value|key} }`.
    - The audience snapshot resolves each recipient's code, into `resolved_params['$offerCode']`.
      A missing code skips the recipient with the new skip reason `OFFER_CODE_MISSING`.
    - Launch is refused when `endsAt` is past or before the scheduled start.
    - The send processor drops messages once `endsAt` has passed (R8, reason `OFFER_ENDED`).
  - Meta shows web and desktop users a notice instead of the offer; the help text says so.
- **Rationale:** an offer must never arrive after it ended; the platform knows the end time.
- **Alternatives considered:** a code per campaign only (the spec asks for per-recipient codes too).

## R8. Time-to-live and expired messages

- **Decision** (Meta, 2026-11-27):
  - **Meta's rules:**
    - The field is `message_send_ttl_seconds` on create and edit.
    - Authentication: 30–900 s, default 10 minutes. Utility: 30–43200 s, default 30 days (`-1` also
      means 30 days).
    - Marketing TTL (12 h–30 days) exists only in Meta's Marketing Messages API, not the Cloud API we
      use. The spec was corrected.
    - If Meta changes a template's category, it clears the custom TTL.
  - **Our rule:**
    - Codes take 30–900 s and utility 30–43200 s; both are sent to Meta (`ttl_applied_by: META`).
    - Marketing takes 43200–2592000 s and is applied only by our queue (`PLATFORM`).
    - Unset means Meta's default and no platform drop. When the template sync sees a category change,
      the TTL is cleared if it no longer fits.
  - **No error code:** Meta gives none for a dropped message ("assume the message was dropped" when no
    delivered status arrives within the TTL). So:
    - **Before sending:** the send processor drops a message whose `queued_at + ttl` has passed, with
      the new status `EXPIRED` and the reason `EXPIRED_BEFORE_SENDING`. The same check with the offer
      end gives `OFFER_ENDED`.
    - **After sending:** a 5-minute `expired-sweep` on the maintenance queue marks `SENT` messages of
      Meta-applied TTL templates whose `sent_at + ttl + 10 min` has passed as `EXPIRED` /
      `NOT_DELIVERED_IN_TIME`. It uses an index on `(status, sent_at)` for those rows.
    - A later `delivered`, `read` or `failed` webhook still wins over `EXPIRED`.
  - `EXPIRED` is a final status for campaign completion, never retried by retry rounds (005), and
    counted separately in results and reports.
- **Rationale:** members see "not delivered in time" instead of an endless "sent", and the queue never
  sends a stale code or a past offer.
- **Alternatives considered:**
  - Mapping to `FAILED` with a made-up code (it would mix with real failures and retry rules).
  - Marketing TTL through the Marketing Messages API (another API and onboarding, out of scope).

## R9. Media from a web address in campaigns

- **Decision:**
  - **Mapping:** the new key `HEADER.media` with sources `static` (one address), `column` (an upload
    column) or `attribute`. The snapshot writes `resolved_params['$headerMediaUrl']`, the parameter
    the public API and API campaigns already use (006), and the send processor already sends `link`.
  - **Launch check:** the 003 safe HTTP client (https only, public addresses only, 5-second timeout,
    3 redirects) sends `HEAD` (or a ranged `GET` when `HEAD` is refused). It checks the content type
    against the header format (001 `HEADER_MEDIA`) and the size limit.
    - Every distinct address is checked up to 1,000, 5 at a time.
    - Above 1,000 distinct addresses, a random sample of 1,000 is checked; the rest fail on their own
      at send time with Meta's reason. The spec's FR-022 is worded to match.
    - Problems block the launch with up to 50 rows and reasons.
  - **API:** the public API keeps its https-only check (006). A failed send shows the reason from the
    help entries (R12).
- **Rationale:** the existing link parameter and safe client mean no new send path; the cap keeps a
  launch check under a minute.
- **Alternatives considered:**
  - Downloading every file and uploading it to Meta (slow, stores customer documents).
  - No check at all (a typo would fail a whole campaign).

## R10. "Send to every row"

- **Decision:**
  - `campaigns.allow_duplicate_rows` (default false) is offered only for upload audiences.
  - With it on, the upload processor keeps every valid row. Each row becomes a message with
    `copy_index` 0, 1, 2… per contact, and its own row variables.
  - The `messages` unique key changes from `(campaign_id, contact_id)` to
    `(campaign_id, contact_id, copy_index)`. Existing rows get 0, so dispatch and idempotency are
    unchanged.
  - Opted-out, blocked and invalid numbers are still skipped.
  - The estimate and results count messages, plus "recipients with more than one message".
  - Retarget groups and replied counts stay per contact (distinct contact ids).
- **Rationale:** the smallest change that lets one person get one message per order, without touching
  the dispatcher.
- **Alternatives considered:**
  - A synthetic contact per row (pollutes contacts).
  - Merging rows into one message (not what the option means).

## R11. Replied counts that match the retarget group

- **Decision:**
  - The 005 `REPLIED` SQL fragment (retarget.service) moves to
    `apps/api/src/modules/campaigns/replied.sql.ts`. Both the retarget group and the results count use
    it: distinct contacts whose campaign message was delivered and who wrote to the number within 3
    days after.
  - The results endpoint adds `replied` and `replyRate = replied / delivered` (distinct contacts), and
    the recipients list adds a `replied` filter.
  - Results are cached for 60 seconds, as the 005 click counts are.
  - The campaign export gets `replied`, `replied_at` and `clicks` columns (FR-037).
- **Rationale:** one definition, so SC-006 (count equals group size) holds by construction.
- **Alternatives considered:** a stored counter updated on inbound messages (two definitions drift).

## R12. Help content as data

- **Decision:**
  - **Error meanings:** `packages/shared/src/help/error-meanings.ts` maps a Meta error code to
    `{ title, meaning, action, checkedAt }`.
    - It starts with every code the platform already handles (the 001 classifier list plus 131050,
      131051, 131052, 131053 and 131057) and the platform's own reasons (unknown outcome, expired
      before sending, offer ended, not delivered in time, media address problems).
    - The api's `describeMetaError` reads it. Results and message details show the meaning and action
      next to the reason.
    - Unknown codes show Meta's text with general advice and count in
      `wbm_unknown_error_codes_total{code}`, so maintainers know which entries to add.
  - **Guidelines:** `packages/shared/src/help/template-guidelines.ts` has sections (category,
    variables, media, buttons, carousel, offer, authentication, rejection reasons) with short points
    and a `checkedAt` date. The editor shows them in a side panel per section.
  - **Frequency capping:**
    - The campaign wizard's review step shows a note for marketing templates.
    - Results show the 131049 count (already the 005 `HELD_BACK` group) with its explanation and
      "not charged".
  - All texts are our own words, written from Meta's public pages (constitution Principle II).
    Maintainers edit the data files, and the screens do not change (FR-030).
- **Rationale:** shared data serves the web and the api, versions with the code, and needs no CMS.
- **Alternatives considered:** a help CMS or database table (more moving parts for a few dozen
  entries).

## R13. Sample templates as versioned data

- **Decision:**
  - `packages/shared/src/templates/samples.ts` exports `TEMPLATE_SAMPLES`. Each sample is `{ id,
    version, industry, purpose, type, language, category, name, draft }`, where `draft` is a
    `TemplateDraft` without account or media.
  - **Coverage:** at least 60 samples over at least 10 industries (retail, food, health, education,
    real estate, travel, beauty, automotive, finance, services), every purpose in FR-024, and every
    type. At least 10 are also in Arabic (`ar`).
  - **Unit test:** every sample passes `validateTemplate` (media samples are exempt only from the
    missing-file rule), and the test checks the coverage and that names are unique.
  - **Routes:** `GET /template-samples` (filters and search, any member) and
    `POST /template-samples/{id}/copy { wabaId, name }` (template managers). The copy creates a
    `DRAFT` template. A media sample's draft asks for a file before submitting, through the normal
    editor issue.
  - Samples are written by us for this project and are reviewed against the rejection reasons in R12.
- **Rationale:** samples change with releases, are reviewed in pull requests, and need no table.
- **Alternatives considered:** a database table seeded by migration (harder to review and update).

## R14. Reports

- **Decision:**
  - **Permission:** the new permission `reports.view` (admins and managers). Downloads also need
    `data.export`.
  - **Routes:** three JSON summaries and three streamed CSVs. Each takes a `from` and `to` in the
    company time zone (002 working hours), at most 366 days long and within the last 12 months.
    - **Overview:** campaign messages by day, by template category and by number:
      - sent, delivered, read and failed (by reason)
      - expired (by reason)
      - replied and clicked (distinct contacts)
      - estimated cost from the 001 rate card
    - **Team member:** campaigns by the new `campaigns.launched_by_id`, with their totals, plus the
      002 `conversation_openings` stats in the range: chats taken, chats closed, replies sent and
      median first response.
      - `launched_by_id` is set at launch. The migration backfills it from the `campaign.launched`
        audit entries, or the creator when there is none.
    - **Opt-ins and opt-outs:** `consent_events` in the range with the contact's name and phone,
      status, source and actor, plus counts by source and day. A new index on `created_at` supports
      it.
  - **CSV:** streamed in batches like the 001 campaign export (flat memory) and never stored, so
    nothing needs deleting (FR-049). Each download is audited as `data.exported` with the report type.
    Phones are masked for roles that see masked phones (001).
- **Rationale:** aggregate SQL over indexed tables meets SC-007 (100,000 messages in 30 seconds)
  without a reporting store.
- **Alternatives considered:**
  - Nightly rollup tables (stale numbers and another job to maintain).
  - Stored files with expiry (the same result with storage and cleanup).

## R15. The website chat button

- **Decision:**
  - **Data:** a `chat_widgets` row: a public `key` (12 characters), the number, the look (colour,
    text, corner, margins, radius), brand name and image, greeting, pre-filled message, ordered page
    rules, status, and the 006 chat links it uses.
    - **Chat links:** one link for the default message, plus one per page rule that changes the
      message. They are marked `source: WIDGET` and hidden from the chat links list.
  - **Snippet:** `<script async src="{PUBLIC_LINK_BASE_URL}/w/widget.js" data-key="{key}"></script>`.
    The api serves it at `/l/w/widget.js` (one static, versioned file, cached for a day) and the
    config at `/l/w/{key}/config.json`.
    - The config has CORS `*`, no cookies, a 60-second cache with an ETag, and the 005 link rate
      limit.
    - It returns only display data and the chat link addresses, or `{ hidden: true }` while the number
      is not connected or the button is paused.
  - **Script:** plain JavaScript, no dependencies, under 30 KB (SC-010).
    - It renders in a shadow root so the site's styles do not leak in.
    - It picks the first matching rule (exact, starts with, or contains, on the page path and query).
    - "Start chat" opens the rule's chat link with `?w={key}&p={path}`.
    - If the config cannot load, it does nothing and never throws on the host page.
  - **Counts:**
    - The 006 chat link route records the open with the new nullable `chat_link_opens.page` (from `p`,
      path only, 200 characters), skipping robots and previews as today.
    - Chats started are counted by the 006 ref in the pre-filled message, so they are per button and
      per page rule; opens are per page. The spec's FR-043 says so.
    - Live chat shows "From the website button · {rule or default}".
  - **Brand image:** a media library file served at `/l/w/{key}/image` from storage.
  - **Designer:** the web app's preview renders the same script against a draft config, at desktop and
    phone widths.
- **Rationale:** reusing chat links gives counts, tags, flows and attribution for free. A static script
  plus a small config keeps the snippet unchanged after edits (FR-042).
- **Alternatives considered:**
  - An iframe (heavier, harder to position).
  - A script per button with the config inlined (every change would bust caches and need a new
    snippet).
  - Per-page attribution of chats (WhatsApp gives no link between a web open and the later message).

## R16. The link and QR generator

- **Decision:** the new route `POST /tools/whatsapp-link { phone, message }` is open to any signed-in
  member and stores nothing.
  - It checks the phone with libphonenumber (the company's default country).
  - It returns `{ url: "https://wa.me/{digits}?text={encoded}", qrPng (data URL), qrSvg }` from the
    `qrcode` library 006 already uses.
  - "Save as chat link" opens the 006 chat link form filled in, for connected numbers only.
- **Rationale:** item 12.2 is mostly covered by 006 chat links; this adds the quick, untracked variant
  in a few lines.
- **Alternatives considered:** QR generation in the browser (a second QR library in the web bundle).

## R17. Roles, audit, events, retention and monitoring

- **Decision:**
  - **Roles:** the new permission `reports.view` (admin, manager) and the API key scope `otp.send`.
    - New template kinds and TTL follow `templates.manage`.
    - The code settings (limit, default template and number) follow `settings.manage`.
    - Website buttons follow `campaigns.manage` to change and `campaigns.view` to see.
    - Samples, help and the generator are open to every member.
  - **Audit actions:** `otp_settings.changed`, `chat_widget.created`, `chat_widget.updated`,
    `chat_widget.deleted`, `template_sample.copied`, plus the existing `template.*`, `api_key.*` and
    `data.exported` (with the report type).
  - **Outbound event:** `otp.status` (group `otp`).
  - **Retention:**
    - OTP messages are deleted after 30 days.
    - Widget opens follow chat link opens (12 months).
    - Reports store nothing.
    - **Erasure:** OTP messages to the contact's phone lose the phone. Report data follows campaign
      data (001, 005).
  - **Metrics:**
    - `wbm_otp_sends_total{result}`
    - `wbm_otp_send_seconds` (histogram: request to Meta accepted)
    - `wbm_messages_expired_total{reason}`
    - `wbm_widget_opens_total`
    - `wbm_reports_exported_total{type}`
    - `wbm_unknown_error_codes_total{code}`
  - **Alerts:**
    - `WbmOtpFailing`: more than 20% of codes fail in 15 minutes, with at least 10 sent.
    - `WbmOtpSlow`: p95 of request to accepted above 5 seconds for 10 minutes.
- **Rationale:** the same shape as 005–008.

## R18. Fakes and mock-meta

- **Decision:**
  - **Unit and integration:** nock fakes extend the 001 `FakeGraph` with:
    - template creation for the three kinds, validated against R2, R6 and R7, and
      `message_send_ttl_seconds`
    - the media upload `POST /{phone-number-id}/media`
    - send payload checks for carousel, offer and code messages
    - a delivery hold so TTL sweeps can be tested
  - **e2e:** `tools/mock-meta` gets the same routes:
    - `POST /mock/hold-delivery { phoneNumberId, on }`
    - `GET /mock/site/{page}`: a test website page with the snippet, whose key comes from a query
      parameter, so page rules can be tested
    - the inbound CLI's `--button-payload` for card quick replies
- **Rationale:** the same pattern as 005–008, so CI never calls Meta.

## Sources (read 2026-11-27)

- Meta, Copy code authentication templates:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates/
- Meta, One-tap autofill authentication templates:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/autofill-button-authentication-templates/
- Meta, Template time-to-live:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live
- Meta, Media card carousel templates:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/media-card-carousel-templates/
- Meta, Limited-time offer templates:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/limited-time-offer-templates/
