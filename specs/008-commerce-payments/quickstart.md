# Quickstart: Commerce and Payments over WhatsApp

**Feature**: `008-commerce-payments` | **Date**: 2026-11-25

## 1. Run it locally

Everything from the 007 quickstart, plus:

```powershell
docker compose up -d          # Postgres, Redis, MinIO
npm run dev:mock-meta         # mock Graph API plus the mock Stripe gateway (src/stripe.ts, src/commerce.ts)
npm run dev                   # api, worker and web
```

Settings (`.env`):
- `STRIPE_API_BASE_URL=http://localhost:4010/stripe`. Leave it unset in production, where it
  defaults to `https://api.stripe.com`.
- `STRIPE_API_VERSION=2026-09-30.endive`. It is upgraded on purpose, like `META_GRAPH_API_VERSION`.
- `PUBLIC_LINK_BASE_URL`: pay links are `${PUBLIC_LINK_BASE_URL}/p/{code}`, as in 005–007.
- `APP_URL` (as before): Stripe posts notifications to `${APP_URL}/api/payments/stripe/webhook`,
  in the same way as the 006 store webhooks.
- `MOCK_STRIPE_WEBHOOK_URL=http://localhost:3001/api/payments/stripe/webhook`. This is for
  mock-meta only, when the endpoint is registered by hand.

Stripe keys are entered on **Payments → Gateway**, never in `.env`.

## 2. The mock gateway and mock Meta

- **Keys:**
  - `rk_test_mockOK1234` works with every permission
  - `rk_test_mockOKnoperm` cannot register endpoints or read events
  - `rk_test_mockXXnockout` is rejected
- **The fake payment page:** a pay link opens `http://localhost:4010/stripe/pay/<session>` with
  **Pay**, **Decline** and **Refund half**. Each one sends a signed notification to the api.
- **Control routes:**
  - `POST http://localhost:4010/mock/stripe/pay` `{ "sessionId": "cs_test_…" }` pays without the page
  - `POST http://localhost:4010/mock/stripe/withhold` `{ "on": true }` holds notifications back, so the
    reconciler can find them
- **Catalog:** `900000000000001` with 40 products (three out of stock, one rejected) for every mock
  WhatsApp account.
- **Inbound CLI:**
  - `npm run mock:inbound -- --from +971501234567 --phone-number-id <id> --order "shp-101:2,shp-102:1"`
    sends a cart
  - `--form-reply <flow_token> --answers '{"name":"Sara","email":"sara@example.com"}'` sends a form
    answer

## 3. Try each story

1. **US1:**
   - Payments → Gateway: paste `rk_test_mockOK1234` and choose "Register the endpoint for me".
   - Every check passes, and the screen shows **Test mode** and AED.
   - **Test notifications** turns to "Notifications working" within seconds.
2. **US2:**
   - In a live chat with a recent customer message, choose **Request payment** for AED 150 and
     "Order 1042".
   - The chat shows the request as Waiting. Open its link and press **Pay**: within a minute it
     shows Paid in the chat, on the contact's Payments tab and in the journey, and the agent is
     notified.
   - Try **Decline** for "Failed attempt", and an expiry of 30 minutes for Expired.
3. **US3:**
   - **Flow:** add a **Request payment** step (AED 99) to a flow and run it from the test panel.
     **Mark paid (test)** takes the paid branch.
   - **Campaign:** send a campaign with a payment template (URL button `…/p/{{1}}`) to three test
     contacts. Each gets its own link.
   - **API:** `POST /api/v1/payments` with an `Idempotency-Key` and a key with `payments.write`.
   - **Store order:** enable the store automation **Pay link** and send an unpaid mock store order.
4. **US4:**
   - Set a reminder "6 hours before expiry" on Payments → Settings.
   - Payments shows totals by day and source. Export the CSV.
   - Retarget the campaign's **Not paid** group.
5. **US5:**
   - Catalog: connect `900000000000001`, then **Copy products now**.
   - In live chat send one product, a list of products and the catalog.
6. **US6:**
   - Send a cart with the inbound CLI. A chat order appears.
   - In automatic mode the payment link arrives within a minute. In review mode, edit the order and
     send the link.
7. **US7:**
   - Forms: build a two-screen form (name, email, a choice, a date and opt-in), map name and email
     to attributes, add a tag, then publish.
   - Send it in live chat, and answer with the CLI using the flow token from the mock message log.
8. **US8:**
   - Build a flow with **Send product list** → **Request payment** (cart total) → **Send form**.
   - Run it in the test panel.

## 4. Tests

```powershell
npm run test -w @wbm/shared                      # unit: money, payments, signature, carts, catalog, forms, flow JSON, steps
npm run test:integration -w @wbm/api -- payments # integration (nock FakeStripe, FakeCommerceGraph); needs Docker
npm run test:contract -w @wbm/api -- commerce    # responses match contracts/commerce-api.openapi.yaml
npm run test:e2e -w @wbm/web -- payments catalog forms   # Playwright on mock-meta
```

Docker is not running on the development machine, so integration, contract and e2e tests run in CI.

## 5. Before going live (release checklist, written with the tasks)

- **Stripe:**
  - a UAE account, verified, with charges enabled
  - a restricted live key with the permissions in `contracts/stripe.md`
  - the endpoint registered (automatically or by hand)
  - "Notifications working" passed in live mode
- **Meta:**
  - the catalog connected to the WhatsApp account in WhatsApp Manager
  - the system user token with `catalog_management`
  - the cart enabled on the numbers
  - catalog, MPM and payment templates approved
  - business verification, if Meta asks for it to publish forms
- **Stores (optional fill):** the Shopify app scopes include `read_products` (and `write_orders` for
  marking orders paid).
