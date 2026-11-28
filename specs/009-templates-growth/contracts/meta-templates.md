# Contract: Meta Calls for the New Template Kinds

**Feature**: `009-templates-growth` | **Research**: R2, R6 – R8, R18

All calls go through the 001 `MetaClient` on the pinned `META_GRAPH_API_VERSION` with the system user
token. Facts were read on 2026-11-27 (research Sources); entries marked *(verify)* are checked
against Meta's pages in the story's first task.

## 1. Create and edit templates

`POST /{WABA_ID}/message_templates` (create) and `POST /{TEMPLATE_ID}` (edit), as in 001. Our
`TemplateDraft` maps to Meta's body by kind.

### Authentication

```json
{
  "name": "login_code", "language": "en_US", "category": "AUTHENTICATION",
  "message_send_ttl_seconds": 600,
  "components": [
    { "type": "BODY", "add_security_recommendation": true },
    { "type": "FOOTER", "code_expiration_minutes": 10 },
    { "type": "BUTTONS", "buttons": [{ "type": "OTP", "otp_type": "COPY_CODE", "text": "Copy code" }] }
  ]
}
```

- **One-tap:** `"otp_type": "ONE_TAP"`, `"text"`, `"autofill_text"`, and
  `"supported_apps": [{ "package_name": "com.example.app", "signature_hash": "K8a/AINcGX7" }]`
  (1–5 apps; `signature_hash` is exactly 11 characters).
- `FOOTER` is left out when there is no code validity.
- **Limits:** `code_expiration_minutes` 1–90; TTL 30–900 s.
- Meta returns the button as `URL`; the 001 sync stores Meta's components as they come back.

### Carousel (marketing)

```json
{
  "name": "new_arrivals", "language": "en_US", "category": "MARKETING",
  "components": [
    { "type": "BODY", "text": "Hi {{1}}, our new arrivals are here.", "example": { "body_text": [["Sara"]] } },
    { "type": "CAROUSEL", "cards": [
      { "components": [
        { "type": "HEADER", "format": "IMAGE", "example": { "header_handle": ["<handle>"] } },
        { "type": "BODY", "text": "Linen shirt, {{1}}", "example": { "body_text": [["AED 120"]] } },
        { "type": "BUTTONS", "buttons": [
          { "type": "QUICK_REPLY", "text": "Tell me more" },
          { "type": "URL", "text": "Shop", "url": "https://shop.example.com/p/{{1}}", "example": ["shirt-1"] }
        ] }
      ] }
    ] }
  ]
}
```

- **Limits:**
  - 2–10 cards
  - message body up to 1024 characters; card body up to 160, on every card or on none
  - header `IMAGE` or `VIDEO`, the same on every card
  - up to 2 buttons per card (`QUICK_REPLY`, `URL`, `PHONE_NUMBER`), the same components on every card
- Each card's sample is uploaded with the 001 Resumable Upload flow (`header_handle`).

### Limited-time offer (marketing, no footer)

```json
{
  "name": "weekend_offer", "language": "en_US", "category": "MARKETING",
  "components": [
    { "type": "HEADER", "format": "IMAGE", "example": { "header_handle": ["<handle>"] } },
    { "type": "LIMITED_TIME_OFFER", "limited_time_offer": { "text": "Weekend deal", "has_expiration": true } },
    { "type": "BODY", "text": "Hi {{1}}, 20% off everything until Sunday.", "example": { "body_text": [["Sara"]] } },
    { "type": "BUTTONS", "buttons": [
      { "type": "COPY_CODE", "example": "WKND20" },
      { "type": "URL", "text": "Shop now", "url": "https://shop.example.com/offer/{{1}}", "example": ["wknd"] }
    ] }
  ]
}
```

- **Limits:**
  - `text` up to 16 characters
  - body up to 600 characters, examples included
  - code example up to 15 characters
  - url up to 2000 characters, with one variable at the end

### Time-to-live

- **Authentication and utility:** `message_send_ttl_seconds` goes on create and edit. Authentication
  takes 30–900 s and utility 30–43200 s; when it is left out, Meta's default applies.
- **Marketing:** nothing is sent to Meta (the Cloud API takes no marketing TTL); the platform applies
  it in its queue.
- **Category changes:** the 001 sync reads the category back. When Meta moved a template to
  marketing, the TTL Meta held is gone, so the platform clears `ttl_seconds` when it is outside the
  marketing range, or keeps it as `PLATFORM`.

## 2. Upload card media

`POST /{PHONE_NUMBER_ID}/media` (multipart: `messaging_product=whatsapp`, `type`, `file`)
returns `{ "id": "<MEDIA_ID>" }`.

- It is called before launch for each carousel card file and number, through the 001
  `MediaService.ensureMetaMediaId` cache (`media_assets.meta_media_ids`), which uploads again when the
  cached id is old.

## 3. Send

`POST /{PHONE_NUMBER_ID}/messages` with `type: template`, as in 001.

### Authentication

```json
"components": [
  { "type": "BODY", "parameters": [{ "type": "text", "text": "<CODE>" }] },
  { "type": "BUTTON", "sub_type": "url", "index": "0", "parameters": [{ "type": "text", "text": "<CODE>" }] }
]
```

The code comes from the decrypted send job (research R4) and is never written to `resolved_params`,
which holds `••••`.

### Carousel

```json
"components": [
  { "type": "BODY", "parameters": [{ "type": "text", "text": "Sara" }] },
  { "type": "CAROUSEL", "cards": [
    { "card_index": 0, "components": [
      { "type": "HEADER", "parameters": [{ "type": "image", "image": { "id": "<MEDIA_ID>" } }] },
      { "type": "BODY", "parameters": [{ "type": "text", "text": "AED 120" }] },
      { "type": "BUTTON", "sub_type": "quick_reply", "index": "0", "parameters": [{ "type": "payload", "payload": "wbm:c0:b0" }] },
      { "type": "BUTTON", "sub_type": "url", "index": "1", "parameters": [{ "type": "text", "text": "shirt-1" }] }
    ] }
  ] }
]
```

- Every card the template has is sent.
- **Quick replies:** the payload `wbm:c{card}:b{button}` comes back as `messages[].button.payload`.
  The 002 parser maps it to the card and button for live chat. 003 template button triggers still
  match on the button text.

### Limited-time offer

```json
"components": [
  { "type": "HEADER", "parameters": [{ "type": "image", "image": { "link": "https://…" } }] },
  { "type": "BODY", "parameters": [{ "type": "text", "text": "Sara" }] },
  { "type": "LIMITED_TIME_OFFER", "parameters": [{ "type": "limited_time_offer", "limited_time_offer": { "expiration_time_ms": 1767225599000 } }] },
  { "type": "BUTTON", "sub_type": "copy_code", "index": 0, "parameters": [{ "type": "coupon_code", "coupon_code": "WKND20" }] },
  { "type": "BUTTON", "sub_type": "url", "index": 1, "parameters": [{ "type": "text", "text": "wknd" }] }
]
```

- `expiration_time_ms` is the offer's end as a Unix time in milliseconds. Meta's example value looks
  like a duration *(verify on the release check)*.
- The header may use a media `id` or a `link`, as for standard templates.

### Media by address (standard templates, 006 parameter)

The header parameter is `{ "type": "image|video|document", "image|video|document": { "link": "https://…" } }`
from `resolved_params['$headerMediaUrl']` (research R9).

## 4. Statuses

- The 001 webhook handling is unchanged.
- **No Meta code for TTL:** Meta sends no special code for a dropped message, so the platform marks
  it (research R8):
  - `EXPIRED` / `NOT_DELIVERED_IN_TIME` when no `delivered` arrives by `sent_at + ttl + 10 minutes`
  - a later `delivered`, `read` or `failed` replaces that mark
- **OTP messages:** each status change also emits `otp.status` (contracts/public-otp-v1.openapi.yaml).

## 5. Fakes

**`FakeGraph`** (nock, integration tests) is extended with:
- **template create and edit:** checks each kind's components and limits, and stores
  `message_send_ttl_seconds`. It answers like Meta: invalid bodies get Meta-style errors, and
  authentication buttons come back as `URL`.
- **media upload:** `POST /{PHONE_NUMBER_ID}/media` returns `media-<n>` ids and records them.
- **send:** checks the payload by the template's kind. Codes must appear twice. Carousels must have
  every card with a media id. Offers must carry the end time and code. The fake records the call.
- **status:** `holdDelivery(phoneNumberId)` sends no `delivered` webhook, so the expired sweep runs.

**`tools/mock-meta`** (e2e) gets the same behaviour and these routes:
- `POST /mock/hold-delivery { phoneNumberId, on }`
- `GET /mock/site/{page}?key=…`: a plain HTML page with the website button snippet pointing at the
  api, so page rules can be tested
- the inbound CLI's `--button-payload "wbm:c1:b0" --button-text "Tell me more"` for card quick replies
