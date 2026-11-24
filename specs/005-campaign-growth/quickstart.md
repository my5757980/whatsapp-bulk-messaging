# Quickstart: Campaign Growth

**Feature**: `005-campaign-growth` | **Plan**: [plan.md](./plan.md)

Builds on the 001–004 quickstarts: Docker services, `.env`, migrations, seed and `npm run dev` (web
:3000, api :4000, worker, mock-meta :4010). Connect a mock number and sync templates as 001 does.

## 1. Extra setup

```powershell
npm run db:migrate          # applies the 005 migration (tracked links, clicks, retry rounds, drips)
```

`.env` (see `.env.example`):

```dotenv
# Where tracked links live: the company's public HTTPS address in production,
# for example https://go.company.example. Locally, the api's own /l route:
PUBLIC_LINK_BASE_URL=http://localhost:4000/l
```

In production this must be `https://` on a domain the company owns, served by the same public host
that receives Meta's webhooks.

For a tracked button, create a template in **Templates → New template** with a URL button and
choose **Tracked link button**. The editor fills the address with
`${PUBLIC_LINK_BASE_URL}/{{1}}` and an example code. mock-meta approves it during the next sync.

## 2. Simulate clicks and replies

```powershell
# A real click (a phone browser):
curl -s -o NUL -w "%{http_code} %{redirect_url}\n" -A "Mozilla/5.0 (Linux; Android 15)" http://localhost:4000/l/<code>
# A WhatsApp link preview (redirected, not counted):
curl -s -o NUL -w "%{http_code}\n" -A "WhatsApp/2.24.20.72 A" http://localhost:4000/l/<code>
# A customer reply (for Replied and the drip leaving rule):
npm run mock:inbound -- --from +971500000001 --name "Sara" --text "interested, tell me more"
```

Each recipient's code is in the mock-meta sent log (`GET http://localhost:4010/mock/sent`, the button
parameter). The dashboard never shows codes: a code opens its recipient's link and counts a click.

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Clicks | Create a campaign with the tracked button to `https://shop.example/sale` for 3 contacts and send it. Open two contacts' links (one twice) as a phone and one as a WhatsApp preview. Open **Results → Clicked**. | 2 clickers, 3 clicks, click rate 2/3 of delivered. The Clicked view shows both contacts with their first and last clicks; the preview is not counted. Each click shows in the contact's journey. Exporting gives the same rows. |
| US2 Retarget | On the campaign, open **Retarget**, see the group sizes, choose **Clicked**, then launch the draft. Reply from a third contact and retarget **Replied**. | The draft names the source and group; at launch its audience is exactly the clickers (minus opted-out). Replied holds the contact who wrote within 3 days. |
| US3 Retries | Set retries to 2 rounds (30 minutes, 1 hour) on a draft of 20 contacts: 5 with numbers ending in `1016`, 2 ending in `0000` and 1 ending in `1049`. mock-meta fails the first send to `…1016` with 131016 and then delivers, fails `…0000` with 131026, and fails `…1049` with 131049. Launch it and open **Scheduled retries**. | Round 1 holds the 5 temporary failures, never the 131026 ones; after it, 5 are recovered and nobody gets the message twice. The 131049 failure shows under **Held back**, not in a round. |
| US4 Drip | In **Drips → New drip**, add 3 steps (10 minutes, 1 hour, 1 day) with quiet hours 21:00–9:00, activate it and enrol two contacts by hand. Reply from one. Pause and resume. | Both get step 1 after about 10 minutes. The one who replied leaves (journey "Left drip: replied") and gets nothing more. Steps due in quiet hours wait until 9:00, and paused drips send nothing. Drip messages show in live chat as automatic. |
| US5 Starting events | Set the drip to start on the tag "new lead" and on a click in the US1 campaign. Tag a contact, click as another, and tag a contact already in the drip. | The first two join once and get step 1; the third is not enrolled again. |
| US6 Results | Open the drip's **Results**. | Contacts in, finished and left by reason; per-step sent, delivered, read, clicked, replied, failed and skipped equal the contacts listed under each number; the export matches. |

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit: codes, bot detection, retryable failures, retry windows, quiet hours, due times, leaving rules
npm run test:integration    # growth-clicks, growth-retarget, growth-retries, growth-drips, growth-drip-events, growth-drip-results, retention, contact deletion
npm run test:contract       # responses vs contracts/growth-api.openapi.yaml
npm run test:e2e            # Playwright: growth-us1 … growth-us6 with mock-meta
$env:PERF_NUMBER_ID="<number id>"; npm run perf:drips   # SC-005 with 10,000 enrolled contacts (api and worker running)
```

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| A button cannot be tracked | Its template address must start with `PUBLIC_LINK_BASE_URL` followed by `/{{1}}`. Create the template with **Tracked link button**. |
| Clicks stay at zero | Is `PUBLIC_LINK_BASE_URL` reachable from phones (public https)? Previews and robots are not counted; open the link in a phone browser. |
| A retry round was skipped | Its note says why: past 24 hours, the template paused or disabled, or the number disconnected. |
| A drip paused itself | Its reason shows: a step's template is not approved any more, or the number disconnected. Fix it, then resume. |
| Drip steps are late | Quiet hours, the number's sending speed, or Meta's messaging limit; the `WbmDripLagging` alert and the due lag metric show it. |
