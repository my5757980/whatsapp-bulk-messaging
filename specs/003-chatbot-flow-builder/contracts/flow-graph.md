# Contract: Flow Graph JSON (version 1)

The draft (`flows.draft`), every published version and every revision store one graph document in
this shape. The zod schema in `packages/shared/src/flows/graph.ts` is the executable form of this
contract; the editor and the API both use it. Unknown fields are rejected.

## Document

```json
{
  "version": 1,
  "start": "welcome",
  "triggers": [ /* Trigger, 0–20 */ ],
  "steps": [ /* Step, 1–200 */ ]
}
```

- Step and trigger ids match `^[a-z0-9_-]{1,40}$` and are unique in the document.
- `start` names the first step. Every published flow can also be started from live chat.
- `position: {x, y}` on each step is editor layout only; the engine ignores it.

## Triggers

| kind | Fields | Notes |
|---|---|---|
| `KEYWORD` | `match` (`EXACT` \| `CONTAINS`), `phrases` (1–20 strings, 1–200 chars), `canInterrupt` (bool) | matched ignoring case and extra spaces |
| `PATTERN` | `pattern` (1–200 chars), `answerName?` (stores the matched text), `canInterrupt` | safe-pattern check, 25 ms limit |
| `TEMPLATE_BUTTON` | `templateId` (uuid), `buttonText` (1–25 chars), `canInterrupt` | the template must have that quick-reply button |
| `FIRST_MESSAGE` | `match`, `phrases`, `tagId?` (first-message tag), `startFlow` (bool, default true) | only a contact's first ever message |

Every trigger has `id`. Reserved keywords (opt-out, opt-in, "talk to a person") are refused.

## Steps

Common fields: `id`, `type`, `position`, optional `label` (editor name, ≤ 60 chars). Branch fields
hold the id of the next step or `null`. Required branches must be set to publish; optional ones
(`onInvalid`, `onTimeout`) end the session when `null`.

| type | Fields | Branches |
|---|---|---|
| `message` | `text?` (≤ 4096), `mediaAssetId?` (library file; at least one of the two), `fallbacks` (`{variable: text}`) | `next` (required unless last) |
| `buttons` | `text` (1–1024), `header?` (≤ 60), `footer?` (≤ 60), `buttons` (1–3 × `{key, title 1–20}`), `answerName?`, `saveTo?`, `timeoutMinutes` (1–1380, default 60), `fallbacks` | one per button (`buttons[i].next`), `onTimeout`, `onInvalid` (a typed answer that is no button) |
| `list` | `text` (1–1024), `header?`, `footer?`, `buttonLabel` (1–20), `sections` (1–10 × `{title? ≤ 24, rows}`), rows total 1–10 × `{key, title 1–24, description? ≤ 72}`, `answerName?`, `saveTo?`, `timeoutMinutes`, `fallbacks` | `sharedNext` **or** one `next` per row; `onTimeout`; `onInvalid` |
| `question` | `text` (1–4096), `answer` (see below), `answerName` (required), `saveTo?` (`{attributeKey}`), `retries` (0–5, default 2), `retryText` (1–1024), `timeoutMinutes`, `fallbacks` | `next`, `onInvalid`, `onTimeout` |
| `tags` | `add` (tag ids), `remove` (tag ids), at least one | `next` |
| `attributes` | `set` (1–20 × `{key, value}`; value `{source: "static", value}` \| `{source: "answer", name}` \| `{source: "field", key: "name" \| "phone"}` \| `null` to clear) | `next` |
| `condition` | `join` (`all` \| `any`), `rules` (1–10 × Rule) | `yes`, `no` |
| `delay` | `seconds` (5–82800) | `next` |
| `api` | `method` (`GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE`), `url` (https), `headers` (≤ 20 × `{name, value}`), `query` (≤ 20 × `{name, value}`), `body?` (JSON text ≤ 8 KB, variables allowed), `timeoutSeconds` (1–10, default 5), `map` (≤ 20 × `{path, answerName}`) | `success`, `failed` |
| `jump` | `flowId` (another flow, published at publish time) | none |
| `handover` | `note?` (≤ 500; added to the chat as an internal note) | none |
| `end` | — | none |

### Answer kinds (question steps)

| kind | Options | Stored as |
|---|---|---|
| `text` | `minLength?`, `maxLength?` (≤ 1000) | string |
| `number` | `min?`, `max?`, `integer?` | number |
| `email` | — | lower-case string |
| `phone` | — | E.164 string (company default country for local numbers) |
| `date` | `earliest?` / `latest?` (`"today"`, `"tomorrow"` or `YYYY-MM-DD`) | `YYYY-MM-DD` |

`saveTo.attributeKey` must name an existing contact attribute of a compatible type (TEXT takes any
kind; NUMBER takes number; DATE takes date; BOOLEAN is not a question target).

### Condition rules

`{subject, op, value?}` with subjects:

| subject | ops |
|---|---|
| `{kind: "attribute", key}` | `equals`, `not_equals`, `contains`, `starts_with`, `is_empty`, `is_not_empty`, `greater_than`, `less_than`, `before`, `after` |
| `{kind: "answer", name}` | same as attribute |
| `{kind: "field", key: "name" \| "phone"}` | `equals`, `not_equals`, `contains`, `starts_with`, `is_empty`, `is_not_empty` |
| `{kind: "tag", tagId}` | `is_present`, `is_absent` |
| `{kind: "consent"}` | `equals` with `OPTED_IN` \| `UNKNOWN` |
| `{kind: "workingHours"}` | `inside`, `outside` (002 working hours and time zone) |

Text comparisons ignore case. `greater_than`/`less_than` compare numbers; `before`/`after` compare
dates.

## Variables

Texts, header/footer, API URL, header values, query values and body may use `{first_name}`,
`{last_name}`, `{name}`, `{phone}`, `{attr:key}` and `{answer:name}` (002 saved-reply syntax plus
answers). API headers may also use `{secret:<id>}` for a flow secret. A missing value uses the step's
`fallbacks` entry, otherwise renders empty.

## Example

```json
{
  "version": 1,
  "start": "hours",
  "triggers": [{ "id": "kw", "kind": "KEYWORD", "match": "CONTAINS", "phrases": ["hours"], "canInterrupt": false }],
  "steps": [
    { "id": "hours", "type": "buttons", "position": { "x": 0, "y": 0 },
      "text": "We open 9–6, Monday to Saturday. Anything else?",
      "buttons": [ { "key": "loc", "title": "Location", "next": "where" }, { "key": "human", "title": "Talk to us", "next": "agent" } ],
      "timeoutMinutes": 60, "onTimeout": null, "onInvalid": null, "fallbacks": {} },
    { "id": "where", "type": "message", "position": { "x": -200, "y": 200 }, "text": "Find us at …", "mediaAssetId": "0190…", "fallbacks": {}, "next": null },
    { "id": "agent", "type": "handover", "position": { "x": 200, "y": 200 } }
  ]
}
```
