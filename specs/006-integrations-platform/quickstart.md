# Quickstart: Integrations and Developer Platform

**Feature**: `006-integrations-platform` | **Plan**: [plan.md](./plan.md)

This builds on the 001–005 quickstarts: Docker services, `.env`, migrations, seed and `npm run dev`
(web :3000, api :4000, worker, mock-meta :4010). Connect a mock number and sync templates as 001
does.

## 1. Extra setup

```powershell
npm run db:migrate          # applies the 006 migration (webhooks, API campaigns, stores, chat links)
```

`.env` (see `.env.example`):

```dotenv
# Shopify Admin API version, upgraded on purpose (research R7)
SHOPIFY_API_VERSION=2026-10
# Local runs only: lets webhook endpoints and stores use http://localhost (refused in production)
OUTBOUND_ALLOW_LOCAL=true
# Chat links reuse the 005 link address
PUBLIC_LINK_BASE_URL=http://localhost:4000/l
```

mock-meta also serves:
- a test Shopify store at `http://localhost:4010/shopify/shops/demo`, connected with client id
  `mock-client` and client secret `mock-secret`
- a test WooCommerce store at `http://localhost:4010/woo/demo`, connected with `ck_mock` and
  `cs_mock`
- a request catcher at `http://localhost:4010/catch/{name}`. `GET /catch/{name}` lists what it
  received.

## 2. Simulate store events and customers

```powershell
# Place a Shopify test order (COD) with a UAE phone; mock-meta sends the signed webhooks
npm run mock:store -- shopify order --phone +971500000001 --cod
# Ship it, deliver it, or cancel it
npm run mock:store -- shopify fulfil --order 1001 --tracking 1Z999
npm run mock:store -- shopify deliver --order 1001
# Start an abandoned checkout
npm run mock:store -- shopify checkout --phone +971500000002 --value 249.00
# WooCommerce: an order left unpaid (a cart reminder candidate)
npm run mock:store -- woo order --phone +971500000003 --status pending
# The customer taps a COD button (the payload comes from the sent message)
npm run mock:inbound -- --from +971500000001 --button-payload "cod1:<orderId>:Y"
```

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Webhooks | In **Settings → Webhooks**, add `http://localhost:4010/catch/crm` with *Message status* and *Customer messages*, and copy the secret. Send **Test**. Send a template to 2 contacts and reply from one. Pause the endpoint for 2 minutes, send again, then resume. | The test arrives signed, and the answer shows. The catcher holds one signed event each for sent, delivered and read and for the reply, each with its own id, and the signatures check with the secret. Events sent during the pause arrive after resume. The delivery log shows every attempt. |
| US2 Contacts API | In **Settings → API keys**, give a key *Read contacts* and *Change contacts*. `POST /api/v1/contacts` with a new phone, two tags and `city`. Post again with a new name, `DELETE` one tag, `POST …/opt-out`, then `GET /lookup`. Try the same with a send-only key. | One contact with both changes; the journey shows "by API key …". The tag is gone and the contact is opted out. The send-only key gets 403 `insufficient_scope`. |
| US3 API campaigns | In **Campaigns → API campaigns**, create "Order feedback" with a 2-variable template mapped to values `order` and `product`, tag `feedback`, and set it live. Call `POST /api/v1/api-campaigns/order-feedback/messages` for a new phone, for an existing contact, and again with the first call's `Idempotency-Key`. Pause it and call once more. | Two messages are sent, and the new phone becomes a contact tagged `feedback`. The repeat returns the first answer. The paused call gets 409 `NOT_LIVE`. Results show 3 triggers: 2 sent and 1 not sent (paused). |
| US4 Order notifications | In **Integrations → Stores**, connect the mock Shopify store with number and country AE. Turn on *Order confirmed* with a utility template mapping the name, order number and total. Place an order, send its webhook twice, and place an order with no phone. | One message per order, within a minute. The repeat sends nothing. The order without a phone shows as skipped with "no phone". The customer is a contact with the store's tag. |
| US5 COD | Turn on *COD confirmation* (reminder after 1 minute for the test, final after 3). Place three COD orders. Tap Confirm on the first and Cancel on the second (with automatic cancel on), and leave the third. | Order 1 gets the confirmed tag, and the customer gets the thank-you reply. Order 2 gets the cancelled tag and is cancelled in the mock store. Order 3 gets the reminder, then the no-answer tag. The results count each. |
| US6 Carts | Confirm the store's consent covers WhatsApp. Turn on cart reminders with waits 30, 60 and 120 minutes (the test clock moves time). Start a checkout for an opted-in contact, then one for a contact with no opt-in. Order from the first after reminder 1. | The first gets reminder 1 with their own tracked cart link, then nothing more, and counts as recovered with its value. The second is skipped for consent. |
| US7 Chat links | In **Campaigns → Chat links**, create "Shop counter" with the flow "Welcome" and the tag `counter`. Download the QR (SVG and PNG) and open the poster. Open the short link twice (once as a WhatsApp preview), then send the pre-filled message from a new phone. | 1 opening (the preview is not counted), 1 chat started and 1 new contact. The flow replied, and the contact has `counter`. Editing the reference out of the message counts nothing. |
| US8 Number wizard | In **Numbers → Connect with wizard**, paste mock-meta's `mock-token-missing-scope`, then `mock-token-ok`. Pick the mock number, register it with PIN 123456, subscribe the app, and send the test message. | The first token fails "Missing permission: whatsapp_business_messaging", with the fix. The second lists the mock account and number. Each check passes after its fix, the test message shows as delivered, and the number is saved as connected. |

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit: signatures and retry waits, event catalog, scopes, API campaign values, store payload mapping, phone choice, COD and cart state rules, chat link references, wizard checks
npm run test:integration    # integrations-webhooks, integrations-contacts-api, integrations-api-campaigns, integrations-shopify, integrations-woocommerce, integrations-cod, integrations-carts, integrations-chat-links, integrations-number-wizard, plus retention, contact deletion, rbac and audit cases
npm run test:contract       # responses vs contracts/integrations-api.openapi.yaml and contracts/public-api-v1.openapi.yaml
npm run test:e2e            # Playwright: integrations-us1 … integrations-us8 with mock-meta
$env:PERF_NUMBER_ID="<number id>"; npm run perf:webhooks   # SC-001: 99% of events delivered within 10 s
$env:PERF_NUMBER_ID="<number id>"; npm run perf:stores     # SC-004: 95% of order notifications within 1 minute, no duplicates
```

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| An endpoint is "Failing" | It had no successful answer for 24 hours. Fix the receiver, then **Resume**. Waiting events go at once; the delivery log shows each error (TIMEOUT, HTTP_5XX…). |
| Signatures do not check | Sign `{webhook-id}.{webhook-timestamp}.{raw body}` with the secret without `whsec_`, base64-decoded. Use the raw body, not re-serialised JSON. |
| A store shows "Error" | Shopify: the app must be in the same Dev Dashboard organization as the store, with the order and customer scopes and protected customer data declared. WooCommerce: the keys need Read/Write, and the site must use https. **Sync** repairs webhooks and fetches missed orders. |
| No "delivered" notifications from Shopify | Delivery comes from the carrier's tracking. Without it, Shopify never reports delivery. |
| WooCommerce shipped or delivered not sent | Choose which order statuses mean shipped and delivered in the store's settings. |
| Cart reminders all skipped | The contacts have no WhatsApp marketing opt-in, and the store's consent is not confirmed to name WhatsApp. |
| A chat link counts no chats | The customer removed `(ref …)` from the message, or a flow or a member's chat was already active (it still counts, but does not start the flow). |
| Wizard: webhook callback check fails | Enter the shown callback URL and verify token in the Meta app dashboard (WhatsApp → Configuration). |
