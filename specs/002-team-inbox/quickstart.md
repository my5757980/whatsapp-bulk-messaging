# Quickstart: Live Chat (Shared Team Inbox)

**Feature**: `002-team-inbox` | **Plan**: [plan.md](./plan.md)

This builds on feature 001's quickstart (`specs/001-whatsapp-bulk-messaging/quickstart.md`). Follow
its §1–§2 first: Docker services, `.env`, migrations, seed and `npm run dev`.

## 1. Extra setup

```powershell
npm run db:migrate                                  # applies the 002 migrations
npx --no-install web-push generate-vapid-keys       # paste into .env (see below)
```

| Variable | Example | Notes |
|---|---|---|
| `WEB_PUSH_PUBLIC_KEY` | `BOr…` | VAPID public key. If empty, push is turned off and the settings page says so. |
| `WEB_PUSH_PRIVATE_KEY` | `x7…` | Secret: never commit it. |
| `WEB_PUSH_SUBJECT` | `mailto:it@company.example` | Contact address sent to push services. |
| `DATABASE_POOL_MAX` | `20` | Raise it if many people use live chat at the same time. |

Push needs `http://localhost` or HTTPS. Browsers allow service workers on localhost.

## 2. Simulate customers (mock-meta)

```powershell
npm run mock:inbound -- --from +971500000001 --name "Sara" --text "Hi, is the blue one available?"
npm run mock:inbound -- --from +971500000001 --image samples/media/photo.jpg --caption "this one"
npm run mock:inbound -- --from +971500000001 --location 25.2048,55.2708 --label "Office"
npm run mock:inbound -- --from +971500000001 --text "agent"          # a "talk to a person" keyword
npm run mock:inbound -- --from +971500000001 --reaction "👍" --to-wamid <wamid>
npm run mock:inbound -- --from +971500000002 --at "-25h" --text "old"  # creates a chat already in History
```

mock-meta answers free-form sends and read receipts, and emits sent, delivered and read webhooks.
Phones ending in `0000` fail with error 131026.

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Live chat | Open **Live chat**. Send "Hi" with the CLI. Open the chat, **Take chat**, reply "Hello 👋", then **Close chat**. Send an image with the CLI. | The chat appears in *Open* within 2 s without a refresh. After taking it, it is under *Taken* with your name. The reply shows ✓ → ✓✓ → read. Closing moves it back to *Open*. The image shows a preview. Campaign messages to this contact appear in the timeline with their campaign names. |
| US2 Window and History | Use the `--at "-25h"` chat. Open it from **Past chats**. Try to type. Use **Send template** with `order_confirmation` and fill `BODY.1` and `BODY.2`. Then reply from the CLI. | The reply box is locked with an explanation. The template is delivered. After the customer replies, the chat is live again and the window shows about 24 h left. Opted-out contacts get "This contact has opted out". |
| US3 Routing | In **Settings → Live chat**, add the keyword "agent". Send "agent" with the CLI. As agent A take the chat, then transfer it to agent B. Turn on auto-close and run `npm run inbox:age -- --conversation <id> --hours 25` (dev helper). Give agent C the rule *tag = Demo*. | The chat goes to *Waiting for agent* with an alert. After the transfer, B sees it and A does not. Auto-close closes the aged chat. C sees only chats of contacts tagged Demo. |
| US4 Saved replies and media | As a manager, create the saved reply "Opening hours" with the text "Hi {first_name}, we open at 9". In a chat type `/open`, pick it and send. Upload a PDF to the **Media library** and send it. Try a 20 MB video. | The text arrives with the name filled in. The PDF arrives. The video is refused before sending with "Videos up to 16 MB". |
| US5 Profile and blocking | Open the profile panel. Add the tag "VIP" and edit an attribute. Block the contact, then send a message with the CLI. Unblock, then send again. | Counts, source, campaigns with ticks and the journey show. The journey records the tag change. While blocked, nothing appears and there is no alert or automatic reply. After unblocking, messages appear. |
| US6 Automatic messages | In **Settings → Live chat**, set working hours that exclude now and turn on the off-hours message (text). Send twice within a minute. Then set hours that include now, turn on the welcome message and send from a new number. | One off-hours message only. The welcome message is sent once to the new number. Neither is sent in reply to STOP, START or "agent", nor to opted-out contacts. |
| US7 Alerts | Open **Alerts** (header). Turn the sound on and use **Turn on alerts for this browser**, then close the tab and send a message with the CLI. Pause the device and send again. | A chime plays while the tab is open. A push alert appears with the tab closed and the number masked for agents. Nothing arrives while paused. |
| US8 Notes and team view | In a chat, switch the box to **Note**, type `@`, pick a teammate and add the note. As a manager, open **Live chat → Team view** and choose *Last 7 days*. | The note is not sent to the customer and the teammate is alerted. The team view counts match the chats you handled. |

The labels above (Open, Waiting for agent, Taken, Past chats, Take chat, Close chat) are our UI
wording for the spec's Active, Requesting, Intervened, History, Intervene and Resolve (Principle II).

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                       # unit: state machine, window, visibility and agent rules, auto-message rules, saved-reply rendering
npm run test:integration       # one main-journey suite per story, against Docker Postgres, Redis and MinIO, with nock for Meta
npm run test:contract          # live chat responses vs contracts/inbox-api.openapi.yaml
npm run test:e2e               # Playwright with mock-meta: us1-live-chat … us8-team-view
npm run perf:inbox-seed        # SC-006 data: 10,000 chats and one chat of 5,000 messages (api + worker; automatic messages off)
npm run perf:inbox             # SC-006 list/open p95 and SC-001 message-to-stream p95 with 20 streams (uses the seed's output)
```

In CI, the `e2e-smoke` job also covers the live chat specs. The SSE stream is checked through the
Next.js proxy in dev mode, and in the standalone image during the Docker job's smoke step.

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| Chats don't update live | Browser dev tools: `GET /api/inbox/events` should stay open with `: ping` lines every 15 s. A proxy or extension buffering responses breaks SSE. |
| Media shows "unavailable" | Check the worker logs for `inbound-media` failures. The number's token must be valid, because the media download uses it. |
| No push alerts | Check that the VAPID keys are set, that the browser allowed notifications, that the device is not paused in **Alerts**, and that no dashboard tab is open (push is skipped while you're connected). |
| An agent sees no chats | Check their agent rules (Settings → Team → agent → Rules). |
