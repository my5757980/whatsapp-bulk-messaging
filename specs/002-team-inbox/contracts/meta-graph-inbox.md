# Contract: WhatsApp Cloud API calls and webhooks used by Live Chat

**Graph version:** `v27.0`, pinned (`META_GRAPH_API_VERSION`). Base: `META_GRAPH_BASE_URL`. Auth:
`Authorization: Bearer <number token>`, decrypted per number as in 001. This extends
`specs/001-whatsapp-bulk-messaging/contracts/meta-webhooks.md` (§3, §4 and §7). Items marked
**verify** must be re-checked against Meta's current reference while implementing.

## 1. Inbound messages: `field: "messages"` → `value.messages[]`

Each entry has `from` (wa_id), `id` (wamid), `timestamp` (unix seconds, string) and `type`. It may
have `context: {from, id}` (a reply to one of our messages) and `errors[]`. Contact names come from
`value.contacts[].profile.name` (used to name new contacts).

| `type` | Fields read | Stored as (data-model §1) |
|---|---|---|
| `text` | `text.body` | TEXT |
| `image` / `video` / `sticker` | `<type>.id`, `mime_type`, `caption?`, `sha256?` | the matching kind; media downloaded (§3) |
| `document` | `document.id`, `mime_type`, `filename?`, `caption?` | DOCUMENT |
| `audio` | `audio.id`, `mime_type`, `voice?` | AUDIO, with `payload.voice` |
| `location` | `location.latitude`, `longitude`, `name?`, `address?` | LOCATION |
| `contacts` | `contacts[].name.formatted_name`, `phones[].phone`, `emails[].email` | CONTACTS |
| `interactive` | `interactive.type` = `button_reply` \| `list_reply` (`id`, `title`, `description?`) \| `nfm_reply` (`response_json`) | BUTTON_REPLY / LIST_REPLY / FORM_REPLY |
| `button` | `button.text`, `button.payload` (template quick reply) | BUTTON_REPLY |
| `reaction` | `reaction.message_id`, `reaction.emoji` (empty = removed) | REACTION |
| `order`, `system`, `unsupported`, `unknown`, others | `errors[0].code/title` when present | UNSUPPORTED, with `payload.rawType` |

**Processing order:**
1. Signature check and storage (001).
2. Dedupe with `wa_message_id` `ON CONFLICT DO NOTHING`.
3. Consent keywords (001).
4. "Talk to a person" keywords.
5. Conversation update, opening start and journey events.
6. Automatic messages.
7. Realtime event, then push.

A blocked contact stops after step 5, with no event, push or automatic reply.

## 2. Outbound free-form message: `POST /{phone-number-id}/messages`

```json
{ "messaging_product": "whatsapp", "recipient_type": "individual", "to": "<E.164 without +>",
  "type": "text", "text": { "body": "…", "preview_url": true } }
```

**Media:**
- Body: `"type": "image" | "video" | "audio" | "document"` with `{"<type>": {"id": "<media id>"}}`
  or `{"link": "https://…"}`.
- Optional `caption` for image, video and document. Optional `filename` for document.
- `audio` takes no caption.
- Media IDs come from `POST /{phone-number-id}/media`, uploaded once per number and reused (001
  `MediaService`).

**Response:** `{"messages":[{"id":"wamid…"}]}`. Store the ID in `chat_messages.wa_message_id`.

**Errors:** the 001 classifier applies, with one addition:
- `131047`: re-engagement required (outside the 24-hour window). Permanent: mark FAILED with
  reason "The 24-hour reply window has closed — send a template". **Verify** the code.

## 3. Inbound media download

1. `GET /{media-id}` returns `{"url":"…","mime_type":"…","sha256":"…","file_size":"…","id":"…"}`.
2. `GET <url>` with the same `Authorization` header returns the binary. The URL expires
   (currently about 5 min; **verify**), so download right away.
3. Reject over 100 MB. Store in S3 at `media/inbound/{uuid}` and create a `media_assets` row with
   purpose `INBOUND`.

## 4. Read receipt: `POST /{phone-number-id}/messages`

```json
{ "messaging_product": "whatsapp", "status": "read", "message_id": "<latest inbound wamid>" }
```

**Response:** `{"success": true}`. Best effort: failures are logged, never shown to users.
**Verify** whether marking the latest message also marks earlier ones.

## 5. Status webhooks for free-form messages

These are the same `value.statuses[]` payloads as 001 §3. The handler matches `messages.wa_message_id`
first, then `chat_messages.wa_message_id`, and applies the shared precedence rules.

Free-form replies inside the window are free service messages, so pricing data in their status
callbacks is stored but not costed. **Verify** the pricing category, expected to be `service`.

## 6. mock-meta (tools) obligations

- `POST /{id}/messages` accepts every §2 shape and the §4 read call. Free-form sends get the same
  sent/delivered/read webhooks as templates. Numbers ending in `0000` fail with 131026.
- `GET /{media-id}` and its download URL serve stored test files.
- The inbound CLI posts signed §1 payloads for every type:
  - `npm run mock:inbound -- --from +971500000001 --text "Hi"`
  - `--image ./samples/photo.jpg`, `--location 25.2,55.3`, `--reaction 👍 --to-wamid <id>`, and so on
