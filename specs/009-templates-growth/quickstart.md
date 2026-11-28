# Quickstart: More Template Types, Campaign Reports and the Website Chat Button

**Feature**: `009-templates-growth` | **Date**: 2026-11-27

## 1. Run it locally

Everything from the 008 quickstart. No new settings: the website button uses `PUBLIC_LINK_BASE_URL`
(its script and config are served at `/l/w/…` like the 005–008 links), and codes use the existing
send queues.

```powershell
docker compose up -d          # Postgres, Redis, MinIO
npm run dev:mock-meta         # mock Graph API with the new template kinds, media upload and the test site
npm run dev                   # api, worker and web
```

## 2. Mock Meta

- **Templates:** mock-meta approves authentication, carousel and limited-time offer templates 30
  seconds after submission, as it does other templates. Invalid bodies get Meta-style errors.
- **Media upload:** `POST /{phone-number-id}/media` returns `media-<n>` ids for carousel cards.
- **Hold delivery:** `POST http://localhost:4010/mock/hold-delivery { "phoneNumberId": "<id>", "on": true }`
  stops `delivered` webhooks for a number, so time-to-live can be seen.
- **Test website:** `http://localhost:4010/mock/site/products/lamp?key=<button key>` is a plain page
  with the button snippet. Change the path to try page rules.
- **Inbound CLI:** `npm run mock:inbound -- --from +971501234567 --phone-number-id <id> --button-payload "wbm:c1:b0" --button-text "Tell me more"`
  sends a carousel quick reply.

## 3. Try each story

1. **US1 Codes:**
   - Templates → New → **One-time code**: tick the security note, a 10-minute validity, a copy-code
     button and a 5-minute time-to-live, then submit.
   - Settings → One-time codes: choose the template and number.
   - API keys: give a key the **Send one-time codes** permission.
   - `POST /api/v1/otp { "to": "+971501234567", "code": "482913" }` returns `202`; the message
     arrives first even while a campaign is sending.
   - `GET /api/v1/otp/<id>` shows `delivered`. The code shows as `••••` in the message log.
   - A sixth code within 15 minutes gets `429 TOO_MANY_CODES`.
2. **US2 Carousel:**
   - Templates → New → **Carousel**: 3 image cards, each with a card text and the buttons "Tell me
     more" (quick reply) and "Shop" (website). Submit.
   - Campaigns → New: choose the carousel, a different library image for card 2, and fill the
     variables. The preview shows the cards. Launch to three test contacts.
   - Reply with the inbound CLI (`wbm:c1:b0`): live chat shows "Card 2 · Tell me more".
3. **US3 Offer:**
   - Templates → New → **Limited-time offer**: an offer heading, show the end time, a code example
     and a website button.
   - Campaign: an end time two days ahead and the code from an upload column; one row without a
     code is skipped as "missing offer code".
4. **US4 Time-to-live and media by address:**
   - Give a utility template a 60-second time-to-live, hold delivery for the number, and send: after
     about 11 minutes the message shows "not delivered in time".
   - A document campaign with `invoice_url` per row: **Check media** lists a bad address; fix it and
     launch.
5. **US5 Replies, duplicates and reports:**
   - Two test contacts reply: results show replied 2 and the reply rate.
   - Upload a CSV with one number on three rows and **send to every row**: three messages.
   - Reports: the overview, team member and opt-in/opt-out reports for this month, each downloaded
     as CSV.
6. **US6 Samples:** Templates → **Samples** → Food → Order update → **Use this sample**: a draft with
   the sample's text and examples.
7. **US7 Help:**
   - Open **Guidelines** next to each editor section.
   - In a campaign with failures, each reason shows its meaning and what to do.
   - Marketing campaigns show the per-person limit note.
8. **US8 Website button:**
   - Website button → New: colour, text, corner, greeting, a rule "hide on `/checkout`" and a rule
     "on `/products/` ask about the product". Copy the snippet.
   - Open the mock test site on `/products/lamp`: the button and greeting match the preview.
   - **Start chat**: the chat arrives with the product message, and the counts show one open on
     `/products/lamp` and one chat for that rule. On `/checkout` there is no button.
   - **Link generator**: a number and message give a link and QR; **Save as chat link** opens the
     006 form filled in.

## 4. Tests

```powershell
npm run test -w @wbm/shared                         # unit: template kinds, samples, help, page rules, launch checks
npm run test:integration -w @wbm/api -- templates otp reports widgets   # integration (nock FakeGraph); needs Docker
npm run test:contract -w @wbm/api -- templates-growth otp               # responses match the 009 contracts
npm run test:e2e -w @wbm/web -- templates-us reports widget             # Playwright on mock-meta
```

Docker is not running on the development machine, so integration, contract and e2e tests run in CI.

## 5. Before going live (release checklist, written with the tasks)

- **Meta:**
  - an authentication template, a carousel and an offer template approved on the real account
  - a real code sent and received in under 10 seconds
  - the offer's end time shown correctly on a phone (the `expiration_time_ms` check, research R7)
- **One-tap (optional):** the company's Android app adds Meta's handshake, and the app's package name
  and signature hash are in the template.
- **Website:** the company's web team pastes the snippet, allows the link host in the site's Content
  Security Policy, and checks the button on desktop and phone.
- **Help:** the error meanings and guidelines re-checked against Meta's pages (their `checkedAt`
  dates).
