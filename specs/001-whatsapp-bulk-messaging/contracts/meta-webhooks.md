# Contract: Meta WhatsApp Webhooks (inbound)

**Endpoint base:** `https://<public-host>/api/webhooks/meta`. It must be reachable over public
HTTPS; use a tunnel for local development.
**Scope:** feature `001-whatsapp-bulk-messaging`. Research decisions R9–R12 apply.
**Verify at implementation:** the subscribed field names and payload details, against Meta's current docs.

## 1. Verification handshake

```http
GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<n>
```

| Condition | Response |
|---|---|
| `hub.mode == "subscribe"` and `hub.verify_token == META_WEBHOOK_VERIFY_TOKEN` | `200` with body = `hub.challenge` (text/plain) |
| Otherwise | `403` |

## 2. Event delivery

```http
POST /api/webhooks/meta
Content-Type: application/json
X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of raw body using META_APP_SECRET>
```

**Processing contract:**

1. Compute the HMAC over the **raw bytes** before any JSON parsing, and compare with a timing-safe equality check.
   - Mismatch or missing header → `401`; store `webhook_events(signature_valid=false, payload=null)`.
2. Insert `webhook_events(signature_valid=true, payload)`.
3. Enqueue the event to the `webhooks` queue.
4. Respond `200` (target p95 < 200 ms). No business logic runs in the request.
5. Processing must be **idempotent**: the same payload delivered N times has the same effect as once.

**Envelope (subset used):**

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{ "field": "messages", "value": { "metadata": { "phone_number_id": "<PHONE_NUMBER_ID>" }, "statuses": [], "messages": [] } }]
  }]
}
```

Each `phone_number_id` maps to `whatsapp_numbers.phone_number_id`. Unknown numbers are logged and ignored.

## 3. `field: "messages"` → `value.statuses[]`

| Payload field | Use |
|---|---|
| `id` | `wa_message_id` → `messages.wa_message_id` (unknown IDs are kept for 24 h in case the send response is still in flight, then ignored) |
| `status` | `sent` \| `delivered` \| `read` \| `failed` \| `deleted` |
| `timestamp` | Unix seconds → event `occurred_at` and the `*_at` columns |
| `recipient_id` | Sanity check against the message phone |
| `pricing.billable`, `pricing.category`, `pricing.pricing_model` | `messages.billable`, `pricing_category` → cost (R17) |
| `errors[].code`, `errors[].title`, `errors[].message`, `errors[].error_data.details` | `failure_code` and `failure_reason` for `failed` |

**Rules:**

- `dedupe_key = "<id>:<status>"`, unique in `message_events`. A duplicate is a no-op.
- Precedence `QUEUED < SENDING < SENT < DELIVERED < READ`. Never downgrade. `failed` applies only while below `DELIVERED`.
- `deleted` is recorded as an event only; it does not change the status.
- After each update, mark the campaign totals stale; the worker recomputes them every 5 s while the campaign is running.

## 4. `field: "messages"` → `value.messages[]` (inbound customer messages)

| Payload field | Use |
|---|---|
| `from` | Customer phone (digits) → E.164 → contact lookup or create |
| `type == "text"`, `text.body` | Consent keyword check (R12) |
| `type == "button"`, `button.text` | Quick-reply text; same keyword check |

**Rules:**

- Normalise the text: trim, collapse whitespace, uppercase. An exact match in `settings.opt_out_keywords` makes the contact `OPTED_OUT`; a match in `opt_in_keywords` makes it `OPTED_IN`.
- Write a `consent_events` row with source `KEYWORD`. Running campaigns skip the contact (worker re-check, R11).
- `dedupe_key = "<message id>:inbound"`.
- Message content is not stored in this feature; the shared inbox is a later feature. Only the consent outcome is stored.

## 5. `field: "message_template_status_update"`

| Payload field | Use |
|---|---|
| `message_template_id`, `message_template_name`, `message_template_language` | Find the template |
| `event` (e.g. `APPROVED`, `REJECTED`, `PAUSED`, `DISABLED`) | Update `templates.status` |
| `reason` | `templates.rejection_reason` |

When the new status is PAUSED or DISABLED, auto-pause every RUNNING campaign that uses the template, with `paused_reason = template_<status>`, and notify admins (FR-027).

## 6. `field: "phone_number_quality_update"`

| Payload field | Use |
|---|---|
| `display_phone_number` | Find the number |
| `event` / current limit or tier info | Update `quality_rating` and `messaging_limit_tier` when present |

On a downgrade, create a `QUALITY_DROPPED` notification for admins.

## 7. Outbound send call (for reference; used by the send worker)

```http
POST https://graph.facebook.com/{META_GRAPH_API_VERSION}/{phone_number_id}/messages
Authorization: Bearer <decrypted access token>
```

Request body:

```json
{
  "messaging_product": "whatsapp",
  "to": "<E.164 without +>",
  "type": "template",
  "template": {
    "name": "<name>",
    "language": { "code": "<language>" },
    "components": [
      { "type": "header", "parameters": [{ "type": "image", "image": { "id": "<media id>" } }] },
      { "type": "body", "parameters": [{ "type": "text", "text": "<BODY.1>" }] },
      { "type": "button", "sub_type": "url", "index": "0", "parameters": [{ "type": "text", "text": "<BUTTON.0.1>" }] }
    ]
  }
}
```

**Outcomes:**

- **Success:** `messages[0].id` is stored as `wa_message_id`, and the status becomes `SENT`.
- **Error:** classified per research R9 into transient (retry), permanent (FAILED) or campaign-blocking (auto-pause).
