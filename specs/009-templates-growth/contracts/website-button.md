# Contract: The Website Chat Button

**Feature**: `009-templates-growth` | **Research**: R15

## 1. The snippet

```html
<script async src="https://{PUBLIC_LINK_HOST}/w/widget.js" data-key="{KEY}"></script>
```

- `{PUBLIC_LINK_HOST}/w/…` is answered by the api at `/l/w/…`, the same mapping as the 005–008 links.
- `KEY` is the button's 12-character public key. It never changes, so edits apply without pasting
  the snippet again (FR-042).
- Several buttons on one page: only the first script tag runs; the others are ignored.

## 2. `GET /l/w/widget.js`

- **The file:** one static, versioned file for every button: `Cache-Control: public, max-age=86400`
  and an ETag.
- **Budget:** under 30 KB uncompressed (SC-010), checked by a unit test on the built file.
- **Code:** plain ES2019 JavaScript with no dependencies, in an IIFE. It adds one global guard,
  `window.__wbmChatButton`, and nothing else.
- **On load:**
  1. Read `data-key` from its own script tag (`document.currentScript`).
  2. Fetch `/l/w/{key}/config.json` without credentials. On any error, or on `{hidden: true}`, stop
     silently.
  3. Pick the rule: the first rule whose `match` and `value` fit the page (below). A rule with
     `hide: true` stops here.
  4. Render inside an open shadow root attached to a `div` at the end of `body` (the site's styles do not
     reach it; browser tests and accessibility checkers can):
     - a round button in `look.colour`, showing a WhatsApp icon (our own SVG) and `look.buttonText`
     - its position from `look.corner`, `offsetX` and `offsetY`, with `look.radius` corners
     - a `z-index` of 2147483000
  5. On click, show the greeting card: the brand image and name, the greeting, and a **Start chat**
     button. Escape closes it, focus moves into it, and it has `role="dialog"` and labels.
  6. **Start chat** opens `startUrl` (the rule's, else the default) with `?w={key}&p={encoded path}`
     in a new tab (`noopener`). On phones it uses the same tab.
- **Never:** cookies, storage, page data beyond the path, or exceptions thrown to the page.

### Page rule matching

- **What is matched:** `location.pathname + location.search`, without the fragment, lower-cased.
  Rule values are lower-cased when saved.
- **Kinds:**
  - `EXACT`: equal, with a trailing `/` ignored
  - `PREFIX`: starts with
  - `CONTAINS`: contains
- Rules are tried in the saved order, and the first match wins; with no match, the defaults apply
  (spec US8).

## 3. `GET /l/w/{key}/config.json`

- **Response:** the `WidgetPublicConfig` schema in templates-growth-api.openapi.yaml.
- **Headers:**
  - `Access-Control-Allow-Origin: *`, no credentials
  - `Cache-Control: public, max-age=60`, and an `ETag` from `version`
- **Rate limit:** the 005 link limiter per IP. Unknown keys get 404.
- **Hidden:** `{hidden: true}` when the button is paused or deleted, or its number is not
  `CONNECTED`.
- **Contents:** display data and chat link addresses only. No number ids, phone digits or personal
  data. The phone is in the chat link redirect, as in 006.

## 4. Chat links and counting

- **The links:** each button owns 006 chat links with `source: WIDGET`: one for the default message,
  and one per rule that has its own message. Their refs carry the 006 attribution, so chats started
  count per button and rule, and the link's tag and flow apply (006).
- **Opens:** the 006 route `/l/c/{code}` reads `w` and `p`:
  - `p` (path only, cut to 200 characters) goes to `chat_link_opens.page`
  - `w` must match the link's button, otherwise it is ignored
  - robots, link previews and `HEAD` requests are not counted (005 and 006 rules)
- **Live chat:** the chat item of a widget link's start shows "From the website button · {rule label
  or Default}".

## 5. Notes for the company's web team (setup guide in the designer)

- **Content Security Policy:** if the site uses one, allow the public link host in `script-src` and
  `connect-src`, and in `img-src` for the brand image.
- The script loads after the page (`async`), so it never blocks rendering.
- **Removing it:** to remove the button, delete the snippet or pause the button in the platform.
