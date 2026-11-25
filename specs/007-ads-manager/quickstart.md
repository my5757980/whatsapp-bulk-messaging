# Quickstart: Click-to-WhatsApp Ads and the Ads Manager

**Feature**: `007-ads-manager` | **Date**: 2026-11-25

## 1. Run it locally

Everything from the 006 quickstart, plus:

```powershell
docker compose up -d          # Postgres, Redis, MinIO
npm run dev:mock-meta         # mock Graph API with the ads routes (tools/mock-meta/src/ads.ts)
npm run dev                   # api, worker and web
```

Settings (`.env`):
- `META_GRAPH_BASE_URL=http://localhost:4010` and `META_GRAPH_API_VERSION=v27.0` (as before)
- `PUBLIC_LINK_BASE_URL` for website ad links (as in 005/006)
- `ADS_FREE_WINDOW_HOURS=72` (optional; Meta's free entry point window shown in live chat)

## 2. Mock Meta for ads

- Tokens: `mock-ads-token-ok-full` (every permission), `mock-ads-token-no-leads` (no `leads_retrieval`).
- Ad account `act_MOCKADS` (AED, Asia/Dubai) and page `MOCKPAGE`, linked to the mock numbers.
- New ads are in review for 3 seconds, then active. A version whose text contains `reject-me` is
  rejected with a reason.
- Insights grow each time they are read while an ad is active.
- `POST http://localhost:4010/mock/ads/lead` sends a signed lead webhook:
  `{ "formId": "<meta form id>", "phone": "+971501234567", "name": "Sara", "consent": true }`.
- `npm run mock:inbound -- --from +971501234567 --phone-number-id <id> --text "Hi" --referral-ad <meta ad id>`
  sends a customer message from an ad.

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Connection | **Ads → Connect**, paste `mock-ads-token-no-leads`, then `mock-ads-token-ok-full`. Pick `act_MOCKADS` and `MOCKPAGE`, save. | The first token names the missing `leads_retrieval` with its fix. The second lists the account and page; checks pass (lead terms as a warning if not accepted); the saved connection shows AED and Asia/Dubai and never shows the token. |
| US2 Launch | **Ads → New ad**: goal *WhatsApp chats*, a mock number, pre-filled message "Hi, I saw your ad", UAE, ages 25–45, automatic placements, budget AED 50 a day, one image version; submit. Then a second campaign with a version containing `reject-me`. | The first shows *In review*, then *Active* within a minute. The second's version shows *Rejected* with the reason; editing the text and resubmitting returns it to review. A budget under Meta's minimum is refused with the minimum. |
| US3 Ad chats | Choose the flow "Welcome" and the tag `from-ad` on the active campaign. Send a customer message with `--referral-ad <its version's ad id>`, then one with an unknown ad id. | The chat shows the ad's headline and picture and "Free ad window until …" after the first reply; the journey has *Started a chat from an ad*; the contact has `from-ad`; the flow replied. The second chat is listed under *Other ads*. |
| US4 Results | Open the campaign's results after a few minutes. | Impressions, clicks and spend per day from Meta, chats started 1, new contacts 1, cost per chat = spend ÷ chats. The export lists each day and version. |
| US5 Manage and cap | Pause and resume the campaign; raise the budget; set a monthly cap below this month's planned spend and raise the budget again; then lower the cap below the spend so far. | Pause and resume follow at Meta. The budget change passes first, then is refused with the remaining amount. When spend reaches the cap, the platform pauses its campaigns and alerts admins. |
| US6 Audiences | Tag 150 contacts `vip` (5 of them opted out). Make an audience from the tag, then a 1% lookalike in AE. Remove the tag from 10 contacts and run *Update now*. | Meta receives 145 hashed numbers, then the 10 are removed. The lookalike can be chosen in the builder. A 50-contact audience is *Too small*. |
| US7 Leads | Create a lead form "Spring offer" (name, phone, the WhatsApp consent question) with tag `spring` and a welcome template; launch a lead ad with it. Send two mock leads, one with consent. Send the first again. | Two contacts tagged `spring`; only the consenting one is opted in (source *Lead form*) and gets the welcome template once; the repeated lead is recorded once. |
| US8 Website and AI | Build a website ad to `https://example.com/offer`; ask **Write with AI** for texts from "Spring sale on shoes, 30% off". Open the ad's counted link twice (once as a preview). | The AI fills the main text and headline within limits for editing. Visits show 1 (the preview is not counted) next to Meta's link clicks. |

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit: targeting, budgets and cap, statuses, referral, hashing, checks, limits
npm run test:integration    # ads-connection, ads-launch, ads-sync, ads-results-cap, ads-audiences, ads-leads, ads-chats, ads-links
npm run test:contract       # responses vs contracts/ads-api.openapi.yaml
npm run test:e2e            # ads-us1 … ads-us8 on mock-meta
```

## 5. Before go-live (release checklist)

- The company's Meta app with the permissions in research R1 (app review or advanced access where
  Meta asks for it, especially `leads_retrieval`), a system user token, and the page subscribed to
  lead notifications on the app's callback.
- The ad account active with a payment method; the page linked to the WhatsApp numbers used in ads.
- The custom audience terms and the lead ads terms accepted.
- A test campaign with a small budget, a real chat from it, and a real test lead.
