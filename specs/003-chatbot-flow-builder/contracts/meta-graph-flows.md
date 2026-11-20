# Contract: WhatsApp Cloud API Usage for Flows (Graph API v27.0)

Flows send only free-form messages inside the 24-hour window, through the 002 session send path
(`POST /{phone-number-id}/messages`). Text and media steps use the same payloads as 002 live chat
replies (`contracts/meta-graph-inbox.md` in 002). This file adds the interactive messages and the
inbound shapes flows react to. Verify field names and limits against Meta's current reference before
release; mock-meta implements exactly this subset.

## 1. Sending reply buttons (buttons step)

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "971501234567",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "text", "text": "Opening hours" },
    "body": { "text": "We open 9–6, Monday to Saturday. Anything else?" },
    "footer": { "text": "Reply with a button" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "s:0190b2…:3:loc", "title": "Location" } },
        { "type": "reply", "reply": { "id": "s:0190b2…:3:human", "title": "Talk to us" } }
      ]
    }
  }
}
```

Limits: body 1–1024, header text ≤ 60, footer ≤ 60, 1–3 buttons, title 1–20, id 1–256.

## 2. Sending a list (list step)

```json
{
  "messaging_product": "whatsapp",
  "to": "971501234567",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "body": { "text": "Which branch suits you?" },
    "action": {
      "button": "Choose a branch",
      "sections": [
        { "title": "Dubai", "rows": [
          { "id": "s:0190b2…:5:marina", "title": "Dubai Marina", "description": "Open until 10 pm" },
          { "id": "s:0190b2…:5:deira", "title": "Deira" }
        ] }
      ]
    }
  }
}
```

Limits: body 1–1024 (our limit), list button label 1–20, 1–10 sections, section title ≤ 24, at most
10 rows in total, row title 1–24, row description ≤ 72, row id ≤ 200.

Reply ids are `s:<sessionId>:<waitToken>:<optionKey>`. A reply whose session or token no longer
matches is a stale tap and is handled like any other customer message.

## 3. Inbound replies flows read

Button tap on an interactive message:

```json
{ "from": "971501234567", "id": "wamid.IN…", "timestamp": "1763600000", "type": "interactive",
  "context": { "from": "15550100", "id": "wamid.OUT…" },
  "interactive": { "type": "button_reply", "button_reply": { "id": "s:0190b2…:3:loc", "title": "Location" } } }
```

List choice:

```json
{ "type": "interactive",
  "interactive": { "type": "list_reply", "list_reply": { "id": "s:0190b2…:5:marina", "title": "Dubai Marina", "description": "Open until 10 pm" } } }
```

Quick-reply button of a template (001 campaigns, API or live chat templates):

```json
{ "type": "button", "context": { "from": "15550100", "id": "wamid.TEMPLATE…" },
  "button": { "text": "Yes, interested", "payload": "Yes, interested" } }
```

The template-button trigger resolves `context.id` to the sent template through `messages.wa_message_id`
and matches `button.text`; 002 already stores these as `BUTTON_REPLY` / `LIST_REPLY` chat items with
the original fields in the payload.

## 4. Statuses and errors

Interactive messages get the same sent/delivered/read/failed webhooks as other free-form messages and
reuse 002's status handling. A send refused because the window closed (131047) or for other
permanent reasons ends the session with `WINDOW_CLOSED` or `SEND_FAILED`.

## 5. mock-meta additions

- Accept `type: interactive` with `button` and `list` payloads; validate the limits above and answer
  400 (code 131009, "Parameter value is not valid") when they are broken.
- Inbound CLI: `--button-id <id> --button-reply <title>`, `--list-id <id> --list-reply <title>`, and
  `--context <wamid>` for template quick-reply taps (`--quick-reply <text>` already exists).
