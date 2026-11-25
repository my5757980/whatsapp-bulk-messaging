# Research: Commerce and Payments over WhatsApp

**Feature**: `008-commerce-payments` | **Date**: 2026-11-25 | **Plan**: [plan.md](./plan.md)

Public sources only: Stripe's and Meta's developer documentation, read 2026-11-25 (list at the end).
Field names marked *(verify)* appear in places that disagree or were not shown in full. They are
pinned in `contracts/stripe.md` and `contracts/meta-commerce-graph.md` and in the fakes, and checked
against the live reference when each client method is written (the tasks call this out). Nothing
here copies a competitor's design.

## R1. One thin Stripe client, no SDK

- **Decision:**
  - A new `StripeClient` uses Node's `fetch`, in the same style as `MetaAdsClient` and the 006 store
    clients. It covers seven calls:
    - `GET /v1/account`
    - `POST /v1/checkout/sessions`
    - `GET /v1/checkout/sessions/:id`
    - `POST /v1/checkout/sessions/:id/expire`
    - `POST /v1/webhook_endpoints`
    - `DELETE /v1/webhook_endpoints/:id`
    - `GET /v1/events`
  - **Requests:**
    - Bodies are `application/x-www-form-urlencoded` with bracketed keys (`line_items[0][price_data][currency]`). A small encoder lives in the client.
    - Each request sends `Authorization: Bearer <key>` and `Stripe-Version: ${STRIPE_API_VERSION}`. The version is pinned to `2026-09-30.endive`, the current release, and upgraded deliberately, like `META_GRAPH_API_VERSION`.
    - The timeout is 10 seconds.
  - **Idempotency:** every POST carries an `Idempotency-Key`. Stripe keeps v1 keys for at least 24 hours, so a retried call cannot create a second session.
    - Session keys are `wbm-pr-<requestId>-s<n>`, where `n` is the request's session counter.
    - Expire keys are `wbm-pr-<requestId>-x<n>`.
  - **Retries:** network errors, 429 and 5xx are retried 3 times with backoff and the same key. Other errors become `StripeApiError {status, type, code, declineCode, param, message}`.
  - **Keys:** a restricted key (`rk_live_…` / `rk_test_…`) is recommended. It needs:
    - Checkout Sessions: write
    - Webhook Endpoints: write (only for automatic registration)
    - Events: read (for the reconciler)

    A secret key (`sk_…`) is accepted with a warning that recommends a restricted key.
  - **Mode:** read from the key prefix (`_live_` / `_test_`) and cross-checked with `livemode` on every object Stripe returns.
- **Rationale:**
  - Seven calls and a 15-line signature check do not justify a dependency.
  - The official SDK ties its major releases to API versions, so an SDK upgrade would change the API version.
  - nock fakes work the same either way.
  - Restricted keys limit the damage if a key leaks (constitution III).
- **Alternatives considered:**
  - The official `stripe` npm SDK: rejected for the reasons above.
  - Stripe Connect or OAuth: rejected because one company uses its own account.

## R2. Payment links: our link in front of a Stripe Checkout Session

- **Decision:**
  - **The link we send:** every payment request gets a code (the 005 `makeLinkCode`). The message carries **our** link, `${PUBLIC_LINK_BASE_URL}/p/{code}`, served by the api at `/l/p/:code`. Opening it:
    - **Request waiting:** 302 to the request's open Checkout Session. If there is none, or it has expired, a new session is made first, under a row lock on the request.
    - **Request paid:** a "Payment received" page with a button back to the WhatsApp chat (`https://wa.me/<number>`).
    - **Request expired or cancelled:** a page that says so and points back to the chat.
    - **Gateway disconnected or failing:** "Payments are paused, please try again later".
  - **When the first session is made:**
    - **Eagerly** for single requests (live chat, flow, API, chat order, store order). Stripe checks the amount and currency at once, and a down gateway stops the send before anything reaches the customer (US2 scenario 6).
    - **Lazily, on first open,** for campaign requests. A 50,000-recipient campaign must not make 50,000 sessions that would mostly expire unused, and Stripe's rate limits apply.
  - **Session parameters** *(verify names against the 2026-09-30 reference)*:
    - `mode=payment`
    - `line_items[0][price_data][currency]=aed` (the connection currency, lower case)
    - `line_items[0][price_data][unit_amount]=<minor units>`
    - `line_items[0][price_data][product_data][name]=<description, at most 250 characters>`
    - `line_items[0][quantity]=1`
    - `client_reference_id=<request id>` and `metadata[wbm_payment_request]=<request id>`
    - `payment_intent_data[metadata][wbm_payment_request]=<request id>`
    - `payment_intent_data[description]=<description · reference>`
    - `expires_at`
    - `success_url=${PUBLIC_LINK_BASE_URL}/p/{code}?paid=1`
    - `locale=auto`
    - Payment methods are left to the Stripe Dashboard settings. In the UAE these are cards, Apple Pay, Google Pay and Link.
  - **Expiry:**
    - A Checkout Session lives 30 minutes to 24 hours. Its `expires_at` is clamped to that range: `min(request expiry, now + 24 h)`, and at least `now + 30 min`.
    - The request's own expiry (30 minutes to 30 days; at most 23 hours in flows) is ours. A session that outlives the request is expired by the expiry job (R6). A payment that still lands is marked **Paid late** (spec FR-012).
  - **One payable session at a time:** before a new session is made, the previous one is expired with `POST /v1/checkout/sessions/:id/expire`. If that returns `complete`, the request is treated as paid. Cancelling a request expires its open session (FR-014).
  - **Card data:** card and wallet details are entered only on Stripe's hosted page. The platform stores ids, amounts, statuses and Stripe's failure codes (`decline_code`), never card brand, last digits or holder names (SC-004).
- **Rationale:**
  - Stripe's links cannot carry our expiry rules. Template URL buttons need a fixed base URL plus a short suffix (`…/p/{{1}}`), which our code provides.
  - Clicks are counted like 005 tracked links.
  - The customer always sees a clear page for expired, cancelled or paid requests.
- **Alternatives considered:**
  - **Stripe Payment Links API**, with `restrictions[completed_sessions][limit]=1` and `active=false` at expiry:
    - every request would need its own Price and Product (two extra objects, clutter in the Dashboard)
    - links never expire on their own, so a deactivation job is needed
    - the per-customer amount is fixed at creation either way

    Rejected.
  - **Sending Stripe's Checkout URL directly:** it expires within 24 hours and is too long for a template button suffix. Rejected.

## R3. Notifications from Stripe: verified, stored, applied once

- **Decision:**
  - **Route:** `POST /api/payments/stripe/webhook`. It uses Nest's raw body, as the 006 store webhooks do.
  - **Verification**, following Stripe's documented manual steps:
    1. Split `Stripe-Signature` on `,` and `=`, and take `t` and every `v1`. Ignore other schemes.
    2. Compute HMAC-SHA256 with the endpoint secret over `${t}.${rawBody}`.
    3. Compare in constant time against each `v1`.
    4. Accept a timestamp within 300 seconds, Stripe's library default.

    During a secret roll, the previous secret is also tried until its `previousSecretUntil`.
  - **Rejected requests:** these return 400 and are recorded in `payment_events` with `signatureValid=false` (headers and the first 2 KB only). They change nothing (FR-004).
  - **Valid requests:**
    - The row is inserted with a unique `stripe_event_id`. A repeat is answered 200 and ignored (SC-003).
    - A `payment-event` job goes on the `payments` queue.
    - The response is 200 within milliseconds.
  - **Events handled** (the webhook endpoint subscribes to exactly these):

    | Event | Effect |
    |---|---|
    | `checkout.session.completed` | `payment_status = paid` → **PAID**. `unpaid` (a delayed method) → wait for the async events. Stores `payment_intent`. |
    | `checkout.session.async_payment_succeeded` | **PAID** |
    | `checkout.session.async_payment_failed` | failed attempt (the request stays payable until it expires) |
    | `checkout.session.expired` | the session ends; the request is unchanged (a new session is made on the next open) |
    | `payment_intent.payment_failed` | failed attempt with `last_payment_error.decline_code` or `code` |
    | `charge.refunded` | `amount_refunded` (cumulative) → partly refunded or **REFUNDED** |

  - **Matching events to requests:**
    - By `metadata.wbm_payment_request` on sessions and payment intents.
    - Refunds match by the stored `payment_intent` id.
    - An event with no match (for example a payment made in the Stripe Dashboard), or whose `livemode` differs from the connection, is stored with result `IGNORED`.
  - **Order:** the shared `applyPaymentEvent(state, event)` ranks statuses (WAITING < EXPIRED/CANCELLED < PAID < REFUNDED). A later status never goes back, and a refund before its "paid" event is held until the payment is known.
  - **Reconciler:** `payments-reconcile` runs every 15 minutes. It reads `GET /v1/events?types[]=…&created[gt]=<cursor − 10 min>` (Stripe keeps events for 30 days) and feeds the same apply path with source `RECONCILE`. Any event found there that the webhook missed raises `wbm_payment_events_total{source="reconcile"}` and the "notifications missing" alert (FR-045).
  - **Stripe's own retries:** Stripe retries failed deliveries for up to 3 days in live mode. Raw bodies are kept 30 days (FR-044).
- **Rationale:** storing before processing is the 001 webhook pattern. Event ids give exactly-once effects, and the reconciler covers an outage of our endpoint.
- **Alternatives considered:**
  - Polling sessions only: slower than SC-002's one minute, and costs calls. Rejected.
  - Stripe thin events (v2): not needed for these v1 objects. Rejected.

## R4. Connecting Stripe and proving notifications work

- **Decision:**
  - **Saving keys:** `PUT /payments/gateway` takes the key, plus the signing secret when the admin registers the endpoint by hand. Checks run, each PASSED / FAILED / WARNING with a fix (shared `gatewayChecks`):
    - **Key:** the format and mode. A test key in production shows **Test mode** everywhere (FR-005).
    - **Account:** `GET /v1/account` gives the display name, `country` (AE expected; others warn), `default_currency` (the connection currency, AED expected), `charges_enabled` (false fails, with Stripe's `requirements` named) and `details_submitted`. If a restricted key cannot read the account, this is a WARNING *(verify the permission)*.
    - **Checkout access:** a create-and-expire of an AED 2.00 session marked `metadata[wbm_check]=1` proves the key may create sessions, and fails with the missing permission otherwise. AED 2.00 is Stripe's minimum charge for AED.
    - **Notifications:**
      - Automatic: `POST /v1/webhook_endpoints` with our URL, the six events and `api_version=${STRIPE_API_VERSION}`. The returned `secret` is stored encrypted, and the endpoint id is kept for disconnecting.
      - Manual: the admin adds the endpoint in the Dashboard and pastes `whsec_…`.
  - **The notification check:** the `checkout.session.expired` event from the check session must arrive and verify within 2 minutes. The screen polls and shows "Notifications working" (US1 scenario 3) or the fix: the URL, the events list, and a wrong secret.
  - **Storage:**
    - Keys and secrets use the 001 `TokenCipher`, are never returned, and are redacted in logs (the pino redaction paths gain `secretKey`, `webhookSecret`, `stripe-signature`).
    - Replacing keys reruns the checks.
    - Disconnecting deletes the endpoint we created. Open sessions stay payable at Stripe until they expire; our link stops making new ones.
- **Rationale:** a real event through the real endpoint is the only proof that notifications work. The check session costs nothing because nobody pays it.
- **Alternatives considered:**
  - The Stripe CLI's `trigger`: a developer tool. Rejected.
  - Trusting the pasted secret without a test: misconfiguration would surface only on the first real payment. Rejected.

## R5. Payment requests: rules, sources and sending

- **Decision:**
  - **Money:**
    - Integer minor units in the connection currency; AED has 2 decimals.
    - The shared `money.ts` holds the currency exponent table and formatting. It moves `formatMinor` out of `ads/budgets.ts`, re-exported for 007.
    - Limits:
      - minimum AED 2.00 (Stripe's minimum for AED; other currencies use Stripe's table *(verify)*)
      - maximum: the admin's per-request limit (default AED 10,000)
  - **Expiry:** 30 minutes to 30 days, default 24 hours. Flow steps allow at most 1,380 minutes, the 003 timeout ceiling, so a flow never waits past the 24-hour window.
  - **Sources:** `INBOX`, `FLOW`, `CAMPAIGN`, `API`, `STORE_ORDER`, `CHAT_ORDER`, each with its link (user, flow session, campaign recipient, API key, store order, chat order).
  - **Inside the 24-hour window:** an interactive `cta_url` message.
    - The body is built from the settings' text with `{amount}`, `{description}`, `{reference}` and `{expires}` placeholders.
    - The button is "Pay now" (`display_text` at most 20 characters *(verify)*) with our link.
    - The new chat content type is `PAYMENT_REQUEST`. It goes through the 002 per-number priority send jobs.
  - **Outside the window:** the payment template chosen in the settings.
    - It must be an approved template with a URL button whose base is `${PUBLIC_LINK_BASE_URL}/p/` and suffix `{{1}}`. The template validator checks this.
    - Body variables map to amount, description, reference and expiry through the 001 variable mapping, with the new `payment` source.
    - It goes through the 001 send queue with the new `MessageOrigin.PAYMENTS`.
  - **Campaigns:**
    - The campaign has an optional `paymentConfig`:
      - the amount, fixed or from a numeric attribute
      - a description with variables
      - the expiry
      - a tag and flow to apply on payment
    - At dispatch, the planner creates one payment request per recipient in the same transaction as the recipient's message row (no Stripe call yet) and puts its code in the button suffix.
    - A recipient whose amount is missing or invalid is held back with reason `PAYMENT_AMOUNT_MISSING` (the 001 held-back path).
  - **API:** `POST /api/v1/payments` (the new `payments.write` scope). It:
    - requires `Idempotency-Key` (the 006 idempotency service)
    - finds or creates the contact by phone (006 contacts rules)
    - sends in the window or with the payment template
    - is read back with `GET /api/v1/payments/:id` and `GET /api/v1/payments?reference=` (`payments.read`), and cancelled with `POST /api/v1/payments/:id/cancel`
  - **Store orders:** the new store automation `PAY_LINK`.
    - **When it sends:** for `UNPAID` orders, and, when the admin enables it, for `COD` orders as "pay online instead".
    - **What it sends:** the order total in the order currency (it must equal the connection currency, or no link is sent and the automation log says why), with the automation's approved template and the pay link button.
    - **When the payment lands:**
      - the order shows paid
      - COD confirmation stops (`codStatus = CLOSED`)
      - the order is marked paid in the store: Shopify `orderMarkAsPaid` (needs `write_orders`, which 006 already uses for `tagsAdd` and `orderCancel` *(verify)*), WooCommerce `PUT /orders/:id {"set_paid": true}`
      - if the store refuses, the order still shows paid and the store connection gets a warning
  - **When paid (FR-013), in one transaction plus after-commit effects:**
    - the tag is added
    - the flow starts, by the 006 chat-link rule: never over a running flow or a member-assigned chat
    - the agent who asked is notified (`PAYMENT_RECEIVED`)
    - journey `PAYMENT_PAID`
    - outbound event `payment.paid`
    - a waiting flow step resumes
    - a chat order is marked paid
  - **Delivery problems:** a link made but whose message failed shows the message status ("not delivered") from the linked chat item or message. It offers **Send again** (a new message, the same request) or **Cancel**.
- **Rationale:** the same request record and link serve every source, so statuses, reminders, totals and retargeting work the same everywhere.
- **Alternatives considered:**
  - A separate model per source: duplicated rules. Rejected.
  - Making Stripe sessions for every campaign recipient at dispatch: rate limits and waste. Rejected.

## R6. Expiry and reminders from due times in Postgres

- **Decision:**
  - A new `payments` BullMQ queue with a repeatable `payments-tick` every 60 seconds (the 005 drip-tick pattern, `FOR UPDATE SKIP LOCKED`, batches of 500). Each tick:
    1. **Expires** `WAITING` requests past `expires_at`. The status is set at once. Then a best-effort `expire` of the open session, retried by later ticks until Stripe confirms, at most 10 times. Then journey `PAYMENT_EXPIRED`, event `payment.expired`, and a waiting flow step resumes on its not-paid branch.
    2. **Sends due reminders** (`next_reminder_at <= now()`). Up to two are allowed, each "N minutes before expiry" with its own approved template. A reminder is sent only if the request is still `WAITING` and was delivered. A marketing-category template is never sent to an opted-out contact (001 send checks). `reminders_sent` is incremented and the next due time is computed by the shared `nextReminderAt`, so each reminder goes at most once (SC-008).
  - Reminders are utility templates where Meta accepts them as such (spec assumption). The settings screen shows each template's category.
- **Rationale:**
  - Due times in Postgres survive Redis loss and are easy to audit (005 R-drips).
  - One tick covers thousands of requests.
- **Alternatives considered:**
  - One delayed BullMQ job per reminder: lost or duplicated on edits and cancels. Rejected.

## R7. The payments page, history and retargeting

- **Decision:**
  - **Totals:** `GET /payments/summary` aggregates requested, paid, waiting, expired and refunded amounts by day (the company time zone from settings) and by source for a period, in minor units. Test-mode requests are excluded (FR-005, FR-019). Filters: status, source, agent.
  - **Indexes:** `(created_at)`, `(status, expires_at)`, `(source, created_at)`, `(contact_id, created_at)`, `(campaign_id, status)`.
  - **Contact history:** `GET /contacts/:id/payments` lists requests and chat orders, newest first (FR-016). Journey entries: `PAYMENT_REQUESTED`, `PAYMENT_PAID`, `PAYMENT_EXPIRED`, `PAYMENT_REFUNDED`, `CHAT_ORDER_RECEIVED`, `FORM_SUBMITTED`.
  - **Retargeting:** the 005 `RETARGET_GROUPS` gain `PAID` and `NOT_PAID` for campaigns with a payment config. `NOT_PAID` covers requests still `WAITING`, plus `EXPIRED` and `CANCELLED` (FR-018).
  - **Export:** `GET /payments/export.csv` streams requests with their chat orders.
    - Needs `data.export`.
    - Phones are masked without `phones.full`.
    - Audit `payments.exported` (FR-020).
- **Alternatives considered:**
  - A materialised totals table: not needed at hundreds of requests a day. Rejected.

## R8. The Meta catalog: connect, copy and keep current

- **Decision:**
  - **Connecting:**
    - **Catalog check:** `GET /{WABA_ID}/product_catalogs` (fields `id,name` *(verify)*) shows the catalog connected to each WhatsApp account. Meta allows one catalog per WABA, and one catalog may serve several numbers.
    - **No catalog yet:** connecting a catalog to a WABA has no documented API call; it is done in WhatsApp Manager or Commerce Manager. The screen gives that fix.
    - **One catalog per platform:** the admin connects one catalog. Each number shows whether its WABA has it; numbers without it cannot send product messages, and the picker says why.
  - **Commerce settings:** each number's commerce settings are shown and editable: `GET` and `POST /{PHONE_NUMBER_ID}/whatsapp_commerce_settings` with `is_cart_enabled` and `is_catalog_visible`. The cart is on by default, and carts need it on.
  - **The copy:**
    - Read with `GET /{CATALOG_ID}/products?fields=id,retailer_id,name,description,price,currency,image_url,url,availability,visibility,review_status&limit=100` *(verify field names)*, paged. It runs every hour on the `catalog` queue, and on demand.
    - Products missing from a full read get `removed_at`.
    - Prices are read with the shared `parseCatalogPrice(text, currency)`, which accepts "AED 1,234.50", "1,234.50 AED" and similar; tests cover the formats. The copy's price is only for display and for cart warnings: WhatsApp shows the catalog's own price in messages.
  - **Sendable:** the shared `isSendableProduct` requires:
    - `availability` "in stock" (or "available for order")
    - not removed
    - not `review_status = rejected`
    - not `visibility = staging` *(verify)*
  - **Search:** a trigram index on `name` and `retailer_id`, answering in under 2 seconds (SC-006).
  - **Token:** the system user token used for messages (001) also needs `catalog_management` (release checklist).
- **Rationale:** a local copy makes the picker and cart checks fast, with no Graph call per keystroke.
- **Alternatives considered:**
  - Reading the catalog live on each search: slow and rate-limited. Rejected.

## R9. Filling the catalog from a 006 store

- **Decision:** optional (FR-022), per connected store.
  - **Reading:** a `catalog-fill` job, hourly when enabled plus "Fill now", reads the store's products:
    - Shopify: GraphQL `products` with variants, `read_products` scope *(verify the app's scopes; release checklist)*
    - WooCommerce: `GET /wp-json/wc/v3/products` and variations
  - **Mapping:** one catalog item per variant: `retailer_id` `shp-<variantId>` or `woo-<productId>-<variationId>`, with title, description, `availability`, `condition: new`, price `"150.00 AED"` (cost, a space, then the ISO code, per Meta's batch reference *(verify)*), link and image.
  - **Sending:**
    - Only changed items are sent, found by a content hash per item, with `POST /{CATALOG_ID}/items_batch`: `item_type=PRODUCT_ITEM`, `requests=[{method: CREATE|UPDATE|DELETE, data}]`, in chunks of 500 *(verify the maximum)*.
    - Each returned handle is checked with `GET /{CATALOG_ID}/check_batch_request_status?handle=…&load_ids_of_invalid_requests=true` until `finished` or `error`.
    - Per-item errors are shown on the catalog screen.
  - **Rate limit:** error 80009 ("too many calls to this catalog") backs off.
- **Rationale:** the store stays the source of truth. Hourly diffs keep prices and stock in step (FR-022) without writing every product each hour.
- **Alternatives considered:**
  - A Meta data feed file: needs a public feed URL and Meta's schedule. Rejected.
  - Store product webhooks: more subscriptions, and the hourly diff meets the need. Rejected.

## R10. Product messages and catalog templates

- **Decision:**
  - **In the 24-hour window**, from live chat and flows (FR-023):
    - **Single product:** interactive `product`. Optional body and footer; `action {catalog_id, product_retailer_id}`.
    - **Multi-product:** interactive `product_list`.
      - A text header and a body are required; the footer is optional.
      - `action {catalog_id, sections:[{title, product_items:[{product_retailer_id}]}]}`: 1–10 sections, at most 30 items in total, at least 1 per section.
      - A section title (at most 24 characters) is required when there is more than one section.
    - **Catalog:** interactive `catalog_message`. Body required, footer optional; `action {name: "catalog_message", parameters: {thumbnail_product_retailer_id}}`.
    - New chat content types: `PRODUCT`, `PRODUCT_LIST`, `CATALOG`.
  - **Templates** (FR-024): the 001 template builder and sync learn three new button types, `CATALOG`, `MPM` and `FLOW` (R12).
    - **CATALOG:** sent with `{type: "button", sub_type: "CATALOG", index: 0, parameters: [{type: "action", action: {thumbnail_product_retailer_id}}]}`.
    - **MPM:** sent with `sub_type: "mpm"` and `action {thumbnail_product_retailer_id, sections}` *(verify; the MPM template page was not shown in full)*.
    - Both are marketing templates, so opt-in is required (001 rules).
    - **Product choices:** the campaign stores them (thumbnail, sections) in its variable mapping under `products`, and the payload builder emits them.
- **Rationale:** these are the documented Cloud API message types. The limits live in shared `COMMERCE_LIMITS`.
- **Alternatives considered:**
  - Product carousel templates: Meta offers them, but the spec names catalog and multi-product templates. Later.

## R11. Carts become chat orders

- **Decision:**
  - **Parsing:** the 002 parser learns inbound `type: "order"`: `order {catalog_id, text, product_items:[{product_retailer_id, quantity, item_price, currency}]}`. The new chat content type is `ORDER`.
  - **Where the cart goes:**
    - If a flow session waits at a product or catalog step, the cart goes to the flow (the chat order is recorded with mode `FLOW`, with no automatic link).
    - Otherwise `ChatOrderService.onOrder` records the order:
      - items with names from the copy
      - the total in minor units (`item_price` is a decimal in major units *(verify)*, converted with the currency exponent)
      - warnings from the shared `cartWarnings`: product not in the copy, a currency other than the connection's, mixed currencies, or a price that differs from the copy (FR-029)
  - **Modes:**
    - **Automatic:** with no warnings, a `CHAT_ORDER` payment request for the total is made and sent as `cta_url` at once. The customer has just written, so the window is open (SC-005).
    - **Review:** the agent sees the order waiting and can change quantities, remove items or cancel, then sends the link.
  - **Status:** the order status mirrors its request (`RECEIVED`, `LINK_SENT`, `PAID`, `EXPIRED`, `CANCELLED`, `REFUNDED`). On payment: the order tag, events `chat_order.received` and `chat_order.paid`, and journey `CHAT_ORDER_RECEIVED`.
- **Rationale:** the cart's own prices are used, as the spec says. Warnings stop automatic links when something does not match.

## R12. WhatsApp Forms (Meta WhatsApp Flows), static

- **Decision:**
  - **Our model:** a form is screens of fields, built in our own builder. Field types:
    - short text, long text, email, phone, number
    - single choice, multiple choice, dropdown
    - date
    - opt-in

    Each field has a key (`^[a-z][a-z0-9_]{0,39}$`), a label, required, and options. A final screen holds the submit button.
  - **Compiling:** the shared pure `compileFlowJson(form)` produces Flow JSON version **7.3** (the recommended publishing version in Meta's changelog; pinned as `FLOW_JSON_VERSION`).
    - Each screen becomes `layout: SingleColumnLayout`, with:
      - `TextHeading` / `TextBody` for texts
      - `TextInput` (`input-type`: text, email, phone, number), `TextArea`
      - `RadioButtonsGroup`, `CheckboxGroup`, `Dropdown`, `DatePicker`, `OptIn`
      - a `Footer`
    - Non-final footers `navigate` to the next screen. The final screen is `terminal: true`, and its footer `complete`s with a payload of every field, referenced as `${screen.<SCREEN>.form.<field>}` *(verify the global reference syntax; fallback: carry answers forward in navigate payloads)*.
    - Screen ids are generated (`S1`…`S10`).
    - There is no `data_api_version` or `routing_model`: a static form needs no endpoint, keys or encryption.
  - **Checks before publishing** (FR-031, shared `formChecks`):
    - every screen is reachable
    - field keys are unique
    - required fields are valid
    - options are present
    - texts fit `FORM_LIMITS` *(verify each limit against the component reference)*

    Meta's `validation_errors` are mapped back to screen and field.
  - **Publishing:**
    - Each version is published to each WABA that has numbers, in one call: `POST /{WABA_ID}/flows` with `name` ("<form> v<n>"), `categories` (from the form's category: `SIGN_UP`, `APPOINTMENT_BOOKING`, `LEAD_GENERATION`, `CONTACT_US`, `CUSTOMER_SUPPORT`, `SURVEY`, `OTHER`), `flow_json` and `publish=true`. The response has `id`, `success` and `validation_errors`.
    - A published Meta flow cannot be changed, so a change makes a new version and a new Meta flow (FR-032).
    - Old versions stay published so older templates keep working. Archiving a form deprecates its flows (`POST /{FLOW_ID}/deprecate`).
  - **Sending** (FR-033):
    - **Interactive flow message:** `flow_message_version: "3"`, `flow_id`, `flow_cta` (at most 30 characters), `flow_token`, `flow_action: "navigate"`, `flow_action_payload: {screen: "S1"}`.
    - **Template FLOW button:**
      - created with `{type: "FLOW", text (at most 25), flow_id, navigate_screen: "S1", flow_action: "navigate"}`
      - sent with `{type: "button", sub_type: "flow", index, parameters:[{type: "action", action: {flow_token}}]}`
    - New chat content type `FORM`.
  - **flow_token:** a compact signed token, `wf1.<base64url(versionId|contactId|refKind|refId)>.<HMAC-SHA256/16 bytes>`, keyed with `TOKEN_ENCRYPTION_KEY`.
    - It names the version, the contact and where it was sent (chat item, message, flow session, campaign recipient).
    - It holds no personal data and is verified on every answer (Meta advises verifying the token).
  - **Answers:**
    - **Parsing:** `interactive.type = "nfm_reply"` with `nfm_reply.response_json` (a JSON string holding `flow_token` and the payload fields). This is parsed today as `FORM_REPLY` (002).
    - **Valid token:** `FormAnswerService`:
      - validates the values against the version's fields
      - saves `form_answers`
      - applies the attribute mapping by the 001 attribute types. Values that fail stay in the answer, are listed as problems, and the agent sees them.
      - adds the form's tags
      - opts the contact in only when the opt-in field is true (new `ConsentSource.FORM`, FR-035)
      - writes the journey entry `FORM_SUBMITTED` and sends event `form.submitted`
      - resumes a flow waiting at a form step
    - **Invalid or unknown token:** the reply stays a plain `FORM_REPLY` chat item and a warning is logged.
- **Rationale:**
  - Managers build forms without writing Flow JSON.
  - Static flows avoid an endpoint, its RSA key pair and its uptime.
  - Signed tokens bind answers to the right contact and version.
- **Alternatives considered:**
  - Editing raw Flow JSON: not usable by managers. Rejected.
  - Endpoint (data exchange) flows: the spec excludes live lookups. Rejected.

## R13. Commerce steps in the flow builder

- **Decision:**
  - **Schema:** the shared `FlowStepSchema` gains four steps:
    - **`product`:** `mode: single | list`, items or sections, header, body and footer, `timeoutMinutes`, `next` (cart received), `onTimeout`, and an optional `answerName` for the cart total and items.
    - **`catalog`:** body, footer, thumbnail, `timeoutMinutes`, `next`, `onTimeout`.
    - **`payment`:** `amount: {source: static | answer | attribute | cartTotal, …}`, description, `expiryMinutes` (at most 1,380), `next` (paid), `onNotPaid`.
    - **`form`:** `formId`, body, `cta`, `timeoutMinutes`, `answerPrefix`, `next` (answered), `onTimeout`. Answers are saved as `${answerPrefix}${fieldKey}`.
  - **Engine:** the pure engine gains three inputs:
    - `order` (an order message while waiting at product or catalog)
    - `form` (a verified answer while waiting at form)
    - `payment` (`paid` or `notPaid`, through `resume`)
  - **Publish checks** (FR-040): the shared `validate.ts` receives facts (gateway connected, catalog connected, each form published) and reports a missing one on the step.
  - **Test panel** (FR-041): commerce steps run with the 003 test numbers. Payment requests from test sessions are marked `is_test` (left out of totals), and the panel offers **Mark paid (test)** and **Mark not paid (test)** to drive the branches without paying.
- **Rationale:** the steps reuse the waiting and timeout pattern of question steps (003), and payment and form results arrive the way API results do.

## R14. Roles, audit, retention, monitoring and fakes

- **Decision:**
  - **Permissions:**
    - new: `payments.view` (admin, manager), `payments.manage` (admin: limits, reminders, templates, chat order mode), `forms.manage` (admin, manager)
    - existing: the gateway and catalog connections use `integrations.manage` (admin)
  - **Who may request payments:** the settings' `requestRoles` (default: admin, manager, agent) together with `inbox.reply` on that chat (FR-008, FR-042). Agents see the payments of chats they can see.
  - **API key scopes:** `payments.read`, `payments.write`.
  - **Outbound events** (006):
    - `payment.requested`, `payment.paid`, `payment.failed`, `payment.expired`, `payment.refunded`, `payment.cancelled` (group `payments`)
    - `chat_order.received`, `chat_order.paid` (group `commerce`)
    - `form.submitted` (group `forms`)

    None carries keys or card data.
  - **Audit actions:**
    - `payments.gateway_connected`, `payments.gateway_keys_replaced`, `payments.gateway_disconnected`, `payments.settings_changed`
    - `payment_request.cancelled`
    - `catalog.connected`, `catalog.disconnected`, `catalog.fill_changed`, `catalog.commerce_settings_changed`
    - `form.published`, `form.archived`
    - `payments.exported`, `form_answers.exported`
  - **Retention** (the 001 retention processor):
    - `payment_requests` and `chat_orders`: 5 years
    - `payment_events`: 30 days
    - `form_answers`: 12 months
    - removed catalog products: 90 days
  - **Erasure:** deleting a contact:
    - cancels their `WAITING` requests, expiring their sessions
    - keeps requests and orders with the contact, phone and name cleared
    - deletes their form answers
  - **Metrics:**
    - `wbm_payment_links_total{result}`
    - `wbm_payment_events_total{type,result,source}`
    - `wbm_payments_total{status}`
    - `wbm_chat_orders_total{mode}`
    - `wbm_form_answers_total{result}`
    - `wbm_catalog_sync_total{job,result}`
  - **Alerts:**
    - `WbmPaymentLinksFailing`: more than 50% of link attempts failed over 15 minutes
    - `WbmPaymentNotificationsMissing`: the reconciler found missed events, or no signed event in 24 hours while requests were opened
  - **Fakes:**
    - **Unit and integration:** nock fakes `FakeStripe` (a stateful session and event store that signs webhooks with the test secret) and `FakeCommerceGraph` (catalogs, products, items_batch, commerce settings, flows).
    - **e2e:** `tools/mock-meta` gains `src/stripe.ts`. It serves `/stripe/v1/…` (selected by `STRIPE_API_BASE_URL`), a fake hosted page `/stripe/pay/:session` with **Pay**, **Decline** and **Refund half**, and signed webhooks to the api. `src/commerce.ts` serves the catalog and Flows routes. The inbound CLI gets `--order` and `--form-reply`.
- **Rationale:** the same shape as 005–007, so CI runs everything without Stripe or Meta.

## Sources

- **Stripe:**
  - [Checkout Session create (expires_at, line_items)](https://docs.stripe.com/api/checkout/sessions/create)
  - [Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object)
  - [How Checkout works](https://docs.stripe.com/payments/checkout/how-checkout-works)
  - [Fulfill orders (async events, idempotent fulfilment)](https://docs.stripe.com/checkout/fulfillment)
  - [Manage limited inventory (expire endpoint, checkout.session.expired)](https://docs.stripe.com/payments/checkout/managing-limited-inventory)
  - [Receive events and verify signatures manually](https://docs.stripe.com/webhooks)
  - [Webhook signatures](https://docs.stripe.com/webhooks/signature)
  - [Event types](https://docs.stripe.com/api/events/types)
  - [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
  - [Authentication and restricted keys](https://docs.stripe.com/api/authentication)
  - [Supported currencies and minimums](https://docs.stripe.com/currencies)
  - [UAE payment methods](https://support.stripe.com/questions/which-payments-methods-and-products-are-available-in-the-uae)
  - [Payment Links object (restrictions, active)](https://docs.stripe.com/api/payment-link/object)
  - [Customize Payment Links](https://docs.stripe.com/payment-links/customize?dashboard-or-api=api)
  - [API versioning](https://docs.stripe.com/api-versions)
  - [Changelog: Endive](https://docs.stripe.com/changelog/endive)
- **Meta, catalog and messages:**
  - [Catalogs overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview.md)
  - [Upload inventory (one catalog per WABA)](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/upload-inventory.md)
  - [Set commerce settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/set-commerce-settings)
  - [Catalog messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalog-messages)
  - [Catalog templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalog-template-messages)
  - [Single-product templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/spm-template-messages)
  - [Marketing templates (MPM)](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates)
  - [Messages reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/)
  - [Order messages webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order/)
  - [Interactive CTA URL messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-cta-url-messages/)
  - [WhatsApp Business Account reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account)
  - [Catalog Batch API](https://developers.facebook.com/documentation/ads-commerce/commerce-platform/catalog/batch-api)
  - [items_batch](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/product-catalog/items_batch)
  - [check_batch_request_status](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/product-catalog/check_batch_request_status)
  - [Catalog reference (fields)](https://developers.facebook.com/documentation/ads-commerce/catalog/reference)
- **Meta, WhatsApp Flows:**
  - [Flows API](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowsapi)
  - [Flow JSON](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowjson)
  - [Send a Flow message](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/sendingaflow)
  - [Flows changelog (versions 7.3, message version 3)](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/changelogs)
  - [Flow endpoints (token verification advice)](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/implementingyourflowendpoint/)
