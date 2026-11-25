# Contract: Outbound Webhook Events

**Feature**: `006-integrations-platform` | **Research**: R1–R3

What the platform sends to a webhook endpoint (US1). This page is also the basis of the guide shown
to admins and developers.

## 1. Request

```http
POST {endpoint url}
content-type: application/json
user-agent: wbm-webhooks/1
webhook-id: evt_0193f1c2-7b5e-7c3a-9d41-6a2e5b8c0f17
webhook-timestamp: 1795530000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4= v1,Q2xpZW50IHNlY3JldCByb3RhdGlvbiBleGFtcGxlIG9ubHk=

{
  "id": "evt_0193f1c2-7b5e-7c3a-9d41-6a2e5b8c0f17",
  "type": "message.status",
  "timestamp": "2026-11-24T10:20:00.000Z",
  "api_version": "2026-11",
  "data": { ... }
}
```

- **Signature:** `base64(HMAC_SHA256(key, "{webhook-id}.{webhook-timestamp}.{raw body}"))`.
  - The key is the endpoint secret without its `whsec_` prefix, base64-decoded.
  - There are two `v1,` values only during the 24 hours after a secret is renewed.
  - Accept the request when any value matches, compared in constant time.
  - Refuse timestamps more than 5 minutes away from your clock.
- **Answer:** any 2xx within 10 seconds means delivered. Anything else, a timeout or a redirect is a
  failure.
- **Retries:** the waits are 10 s, 1 min, 5 min, 30 min, 1 h, 2 h, 4 h, 8 h and 8 h. When your
  endpoint answers 2xx again, its waiting events are sent at once.
- **Order and repeats:** events are delivered at least once and may arrive out of order. Use `id`
  to ignore repeats, and `timestamp` (when it happened) to order them.

## 2. Common shapes

```json
"contact": { "id": "uuid", "phone": "+971501234567", "name": "Sara Ali" }
"message": { "id": "uuid", "waMessageId": "wamid....", "origin": "CAMPAIGN|API|DRIP|FLOW|AI|LIVE_CHAT|STORE", "campaignId": "uuid|null", "apiCampaignId": "uuid|null", "dripId": "uuid|null", "templateName": "order_update|null" }
```

`contact` is `null` when the contact has been deleted. Phone numbers are E.164.

## 3. Event types

| Type | `data` |
|---|---|
| `message.status` | `{ message, contact, status: "sent"\|"delivered"\|"read"\|"failed", failure: { code, title } \| null, statusAt }` |
| `message.received` | `{ message: { id, waMessageId, type: "text"\|"image"\|"video"\|"audio"\|"document"\|"location"\|"button"\|"interactive"\|"sticker"\|"contacts" }, contact, conversationId, numberId, text?: string, buttonPayload?: string }`. `text` and `buttonPayload` are left out when the endpoint turned content off |
| `contact.created` | `{ contact, source: "dashboard"\|"import"\|"api"\|"flow"\|"ai"\|"inbound"\|"store", tags, attributes }` |
| `contact.updated` | `{ contact, changed: ["name", "attributes.city", ...] }` |
| `contact.deleted` | `{ contact: { id } }` |
| `contact.tags_changed` | `{ contact, added: ["vip"], removed: [] }` |
| `contact.opted_in` | `{ contact, source: "IMPORT"\|"API"\|"KEYWORD"\|"MANUAL"\|"AI_AGENT"\|"STORE"\|"UPLOAD_CONFIRMATION", note }` |
| `contact.opted_out` | `{ contact, source }` |
| `link.clicked` | `{ contact, campaignId \| null, dripId \| null, destination, device: "MOBILE"\|"DESKTOP"\|"TABLET"\|"OTHER", clickedAt }` |
| `drip.joined` | `{ contact, drip: { id, name }, via: "MANUAL"\|"TAG_ADDED"\|"OPTED_IN"\|"IMPORTED"\|"API_CREATED"\|"LINK_CLICKED"\|"ORDER_PLACED"\|"ORDER_DELIVERED" }` |
| `drip.finished` | `{ contact, drip }` |
| `drip.left` | `{ contact, drip, reason: "REPLIED"\|"OPTED_OUT"\|"BLOCKED"\|"DELETED"\|"STOP_TAG"\|"CLICKED"\|"REMOVED"\|"INVALID_NUMBER"\|"ARCHIVED" }` |
| `chat.assigned` | `{ conversationId, contact, numberId, assignee: { id, name } \| null, by: "member"\|"rule"\|"flow"\|"ai" }` |
| `chat.closed` | `{ conversationId, contact, numberId, closedBy: { id, name } \| null }` |
| `api_campaign.triggered` | `{ apiCampaign: { id, name, apiName }, contact, outcome: "QUEUED"\|"NOT_SENT", reason \| null, messageId \| null }` |
| `store.notification_sent` | `{ store: { id, name, platform }, order: { id, number }, kind: "ORDER_CONFIRMED"\|"ORDER_SHIPPED"\|"ORDER_DELIVERED"\|"ORDER_CANCELLED"\|"COD_CONFIRMATION"\|"CART_REMINDER", contact, messageId }` |
| `store.cod_answered` | `{ store, order, contact, answer: "CONFIRMED"\|"CANCELLED"\|"NO_ANSWER", cancelledInStore: boolean }` |
| `store.cart_recovered` | `{ store, cart: { id }, order: { id, number }, contact, value, currency }` |
| `test.ping` | `{ endpointId, sentBy: { id, name } }` |

## 4. Rules

- No event carries secrets, API keys, tokens or store credentials.
- `message.received` with content off carries no text, captions, button text or payloads.
- Events about agents' masked views do not exist: endpoints always get full E.164 numbers, so only
  admins can add endpoints (FR-056).
- `api_version` changes only when a field is removed or changes meaning. New fields and new types
  can appear at any time, and receivers must ignore what they do not know.

## 5. Tool guides (documentation, no listing in app stores)

- **Zapier:** Webhooks by Zapier, "Catch Raw Hook"; check the signature in a Code step.
- **Make:** Custom webhook module; check the signature with the HMAC function.
- **n8n:** Webhook node with "Raw Body" on, then a Crypto node (HMAC SHA256, base64).
- **Pabbly Connect:** Webhook trigger; the same check as Make.
- To change data back on the platform, these tools call the public API (`contracts/public-api-v1.openapi.yaml`)
  with an API key that has the right permissions.
