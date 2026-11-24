# Research: Integrations and Developer Platform

**Feature**: `006-integrations-platform` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

Sources are public documentation, read on 2026-11-24 and listed at the end. Nothing comes from
AiSensy's app (constitution Principle II).

## R1. Outbound webhook format and signature

- **Decision:**
  - Deliveries follow the open Standard Webhooks format.
  - Headers: `webhook-id` (the event id), `webhook-timestamp` (Unix seconds) and
    `webhook-signature`.
  - The signature is `v1,<base64 HMAC-SHA256>` over `{id}.{timestamp}.{raw body}`, keyed with the
    endpoint's secret.
  - Secrets are `whsec_` plus 32 random bytes in base64. They are shown once and stored encrypted
    with the 001 token encryption.
  - When a secret is renewed, both secrets sign for 24 hours: two space-separated `v1,` values, as
    the format allows.
  - Body: `{ "id", "type", "timestamp", "data" }`, with `type` such as `message.status` and an
    `api_version` of `2026-11`.
  - The guide tells receivers to accept timestamps within 5 minutes and to ignore repeated ids.
- **Rationale:** Zapier, Make, n8n and most languages already have code for this format, and it
  covers replay protection and key rotation. Our own scheme would need its own documentation and
  verification code for each receiver.
- **Alternatives considered:**
  - A GitHub-style `X-Signature` over the body only: rejected, because it gives no replay
    protection and no rotation.
  - mTLS: rejected, because no-code tools cannot use it.

## R2. Delivery pipeline

- **Decision:**
  - **Outbox:** a change that raises an event writes one `outbound_events` row and one
    `webhook_deliveries` row per subscribed endpoint, in the change's own transaction (the 005
    `drip_events` pattern). This happens only when an active endpoint subscribes to that type
    (a cached lookup refreshed when endpoints change).
  - **Queue:** after commit, the writer adds a BullMQ job per delivery to a new `webhooks-out`
    queue, with job id = delivery id. A 30-second sweep re-adds jobs for due deliveries that have
    none, so a crash between commit and enqueue loses nothing.
  - **Sending:**
    - the 003 safe client rules (`apps/api/src/modules/flows/steps/api-client.ts`): https only,
      the safe DNS lookup refusing private and reserved addresses, no redirects
    - a 10-second total timeout and reading at most 4 KB of the answer
    - only a 2xx answer counts as delivered
  - **Fairness:** at most 5 deliveries in flight per endpoint (a Redis counter), so one slow endpoint
    cannot hold the worker. Worker concurrency is 20.
  - **Retries:** waits of 10 s, 1 min, 5 min, 30 min, 1 h, 2 h, 4 h, 8 h and 8 h after the first
    attempt, about 23 h 46 min in all; after that the delivery is `FAILED`. When an endpoint
    succeeds after failures, its waiting deliveries are due at once, so an outage ends quickly
    (SC-001).
  - **Auto-pause:** an endpoint with no success for 24 hours and at least 10 failed attempts is
    paused (`FAILING`), and admins get a notification. Its deliveries are kept 3 days for resending.
- **Rationale:** the outbox gives at-least-once delivery without a new service. The BullMQ queue
  gives per-delivery retries and fast first attempts (well under 10 s), and the per-endpoint cap
  keeps endpoints apart (FR-008).
- **Alternatives considered:**
  - Svix or Hookdeck as a service: rejected, because it sends personal data to another processor
    and adds a vendor.
  - Sending inline in the triggering request: rejected, because it is not reliable and slows the
    request (constitution IV).
  - A tick like drips: rejected, because a 30-second tick misses the 10-second target.

## R3. Event catalog

- **Decision:** the types and where they come from:

| Type | Raised by |
|---|---|
| `message.status` (sent, delivered, read, failed with code) | 001 status handler, every origin |
| `message.received` (text, media kind, button reply; content optional per endpoint) | 002 inbound handler |
| `contact.created`, `contact.updated`, `contact.deleted` | contacts service, imports, public API, flows, AI memory, deletion |
| `contact.tags_changed` (added, removed) | contacts, bulk actions, imports, flows, API |
| `contact.opted_in`, `contact.opted_out` | consent service (every source) |
| `link.clicked` | 005 click recorder |
| `drip.joined`, `drip.finished`, `drip.left` | 005 enrolments, tick and leaving rules |
| `chat.assigned`, `chat.closed` | 002 chat state changes |
| `api_campaign.triggered` | US3 trigger endpoint |
| `store.notification_sent`, `store.cod_answered`, `store.cart_recovered` | US4–US6 |
| `test.ping` | the endpoint's test button |

  Payloads carry ids and the phone number in E.164 form, never secrets. Message text is left out
  for endpoints that chose so (FR-009). The full schemas are in
  [contracts/webhook-events.md](./contracts/webhook-events.md).
- **Rationale:** these are the events the spec lists (FR-002). A catalog keeps every source behind one
  `OutboundEvents.record(tx, type, data)` call, like `DripEvents` in 005.

## R4. API key permissions

- **Decision:**
  - `api_keys` gets `scopes text[]`, with `messages.send` as the default for existing keys, plus
    `contacts.read`, `contacts.write`, `campaigns.trigger` and `drips.enrol`.
  - The public API guard checks the route's scope and answers 403 `insufficient_scope`.
  - Admins (`apikeys.manage`) edit scopes; every change is audited.
- **Rationale:** least privilege (constitution III). Existing integrations keep working unchanged.

## R5. Contacts API

- **Decision:** under the existing `/api/v1` prefix (001 controllers use `@Controller('v1')`):
  - `POST /v1/contacts`: create or update by phone. The phone is normalised with the company's
    default country.
  - `GET /v1/contacts/{id}` and `GET /v1/contacts/lookup?phone=`.
  - `GET /v1/contacts?tag=&updatedSince=&cursor=`: a cursor page of 100, ordered by
    `(updated_at, id)`.
  - `PATCH /v1/contacts/{id}`.
  - `POST /v1/contacts/{id}/tags` and `DELETE /v1/contacts/{id}/tags/{tag}`.
  - `POST /v1/contacts/{id}/opt-in` (source note required) and `POST /v1/contacts/{id}/opt-out`.
  - `GET /v1/tags` and `GET /v1/attributes`.
  - `POST /v1/drips/{drip}/enrolments` and `DELETE /v1/drips/{drip}/enrolments/{contactId}`, where
    `{drip}` is an id or a name.
  - Every changing route accepts `Idempotency-Key` (the 001 service) and counts against the
    per-key rate limit (001 FR-037).
  - Writes reuse the dashboard services (contacts, consent, enrolments), so journeys, drip events
    and webhook events follow by themselves (FR-016). The actor is the API key.
- **Rationale:** one write path for the dashboard and the API keeps the rules identical.

## R6. API campaigns

- **Decision:**
  - A new `api_campaigns` table holds name, `api_name` (lower-case slug, unique), number,
    template, mapping, header media, tags, attributes, the new-contact rule, daily limit and state
    (`DRAFT`, `LIVE`, `PAUSED`, `STOPPED`).
  - **Trigger:** `POST /v1/api-campaigns/{apiName}/messages` with `{ phone, values, mediaUrl?,
    optIn? }`. It writes the message through the 001 public send path, with origin `API` and a new
    `messages.api_campaign_id`. Every call, sent or refused, is recorded in
    `api_campaign_triggers` with its outcome and reason, so the results count triggers.
  - **Daily limit:** counted in the company time zone.
  - **Self-pause:** the template status handler and number disconnection pause live API campaigns
    and notify managers, as drips do in 005.
  - **Values:** values in the call override nothing set as fixed text. A mapped call value that is
    missing gives 422 `missing_value`.
- **Rationale:** keeping origin `API` avoids touching every place that switches on message origin.
  The trigger table keeps refusals visible (FR-022).

## R7. Shopify access, events and actions

- **Decision:**
  - **Access:**
    - Since 2026-01-01, new custom apps can no longer be created in the Shopify admin. They are
      built in the Dev Dashboard.
    - An app in the same organization as the store gets Admin API tokens with the client
      credentials grant. The tokens last 24 hours (`expires_in`) and have no refresh token, so the
      worker requests a new one when less than 1 hour is left.
    - Stores with a legacy custom app made before 2026 can paste its static Admin API token
      instead.
    - Both kinds of secret are stored encrypted.
  - **Scopes:** `read_orders`, `write_orders` (tags, cancel) and `read_customers`, plus protected
    customer data (name, email, phone, address), which Shopify classes as protected with Level 1
    and 2 rules. The release checklist lists the declaration in the Dev Dashboard.
  - **API:** the GraphQL Admin API with a pinned version (`SHOPIFY_API_VERSION=2026-10`), upgraded
    on purpose like the Graph API.
  - **Webhooks:**
    - The platform creates its own subscriptions with `webhookSubscriptionCreate`, pointing to
      `${APP_URL}/api/integrations/shopify/{storeId}/webhooks`. The topics are `ORDERS_CREATE`,
      `ORDERS_UPDATED`, `ORDERS_CANCELLED`, `FULFILLMENTS_CREATE`, `FULFILLMENTS_UPDATE`,
      `CHECKOUTS_CREATE` and `CHECKOUTS_UPDATE`.
    - Each delivery is checked with `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body
      with the app's client secret) before anything else, and deduplicated on
      `X-Shopify-Webhook-Id`. The platform answers within Shopify's 5-second limit by saving and
      queueing.
    - Shopify retries 8 times over 4 hours and removes API-made subscriptions after repeated
      failures. So a 15-minute reconciler re-creates missing subscriptions and fetches orders
      updated since the last sync (up to 3 days back, FR-026).
  - **Order stages:**
    - confirmed = the order was created
    - shipped = a fulfillment was created, with its tracking number and URL
    - delivered = a fulfillment's `shipmentStatus` became `DELIVERED`. This depends on the carrier
      reporting tracking; without it, no delivered notification goes out.
    - cancelled = `cancelledAt` is set
  - **COD:**
    - Detected from the payment gateway names ("Cash on Delivery (COD)") on an order still
      pending payment.
    - Marked with `tagsAdd` (`whatsapp-cod-confirmed`, `whatsapp-cod-cancelled`,
      `whatsapp-cod-no-answer`) and a `whatsapp.cod_status` metafield.
    - Automatic cancel uses `orderCancel` (reason customer, restock, no refund, customer not
      notified).
  - **Carts:**
    - Checkout webhooks start a cart.
    - At each reminder time, the cart is fetched again through `abandonedCheckouts`. Webhook
      payloads can lack the customer's details, and the cart may be completed by then.
    - The reminder links to `abandonedCheckoutUrl` through a 005 tracked link.
- **Rationale:** this is the documented path for a store owner's own app since 2026. Signatures,
  deduplication and a reconciler cover Shopify's delivery behaviour.
- **Alternatives considered:**
  - A public App Store app with OAuth: rejected, because it is for other businesses' stores and
    needs Shopify's review.
  - Asking the admin to configure webhooks by hand: rejected, because it is error-prone and cannot
    repair itself.

## R8. WooCommerce access, events and actions

- **Decision:**
  - **Access:** REST API v3 keys (`ck_…`/`cs_…`, read/write) made in *WooCommerce → Settings →
    Advanced → REST API*. They are used over https only, with Basic auth, and stored encrypted.
  - **Webhooks:**
    - The platform creates webhooks through `POST /wp-json/wc/v3/webhooks` for `order.created`
      and `order.updated`, with its own random secret per store.
    - Deliveries are checked with `X-WC-Webhook-Signature` (base64 HMAC-SHA256 of the raw body).
      The activation ping carries no signature and is answered and ignored.
    - WooCommerce disables a webhook after more than 5 failures in a row and does not keep the
      missed events. So the reconciler checks the webhooks' status, sets them active again, and
      fetches orders with `modified_after` the last sync.
  - **Order stages:**
    - confirmed = created with status `processing` or `on-hold`
    - shipped = a chosen status (default `completed`)
    - delivered = a chosen status (none by default; stores that use a delivered status from a
      plugin pick it)
    - cancelled = `cancelled`
    - Tracking numbers come from the WooCommerce Shipment Tracking extension's order meta when
      present.
  - **COD:**
    - `payment_method = cod`.
    - Marked with a private order note and a `_whatsapp_cod_status` meta value.
    - Automatic cancel sets the status `cancelled`.
  - **Carts:** WooCommerce core has no abandoned cart event (plugins add one, and the block
    checkout's `checkout-draft` orders carry no reliable phone number). For WooCommerce, cart
    reminders therefore cover orders left in `pending` (payment not completed) with a billing phone,
    linking to the order's `payment_url`. Carts never submitted are out of scope for WooCommerce.
- **Rationale:** these are the documented core APIs, with no plugin to install. The spec's cart
  story holds for Shopify fully, and for WooCommerce as unpaid orders (spec Assumptions updated).

## R9. Store event handling

- **Decision:**
  - The public routes check the signature, save the raw event to `store_events` (unique by store
    and delivery id), answer 200, and queue a job on a new `stores` queue.
  - The processor upserts `store_orders` and `store_carts`, applies the stage rules, and writes
    notifications with a unique `(order_id, kind)`, so each notification is sent at most once
    (FR-030). Events older than 3 days are not sent.
  - **Phone order:** shipping phone, then billing phone, then the customer's phone, read with the
    store's default country (libphonenumber-js, as in 001).
  - Contacts are upserted with the store's tag. The store's marketing consent opts them in only when
    the store's consent setting is confirmed (FR-027), with source `STORE`.
  - Messages use a new origin `STORE`, shown as automatic in live chat (like `DRIP`, 005).
  - Store events are new drip starting events: `ORDER_PLACED` and `ORDER_DELIVERED` (005 outbox).
- **Rationale:** an unbroken chain of check, save and acknowledge, then idempotent processing,
  survives the duplicates and retries both platforms document.

## R10. COD confirmation

- **Decision:**
  - The confirmation template has two quick-reply buttons. Each message sets the buttons' payloads
    (`cod1:{orderId}:Y` / `:N`), which the Cloud API allows per message.
  - The 002 inbound handler routes `cod1:` payloads to the COD service before flows. The first
    answer wins (`cod_status` changes only from `ASKED`). A later tap gets the "already answered"
    reply, sent as free text inside the 24-hour window the tap opened.
  - Reminder and final times are stored on the order. A new 30-second `store-tick` on the `stores`
    queue claims due COD reminders and cart reminders with `FOR UPDATE SKIP LOCKED`, the 005 drip
    tick pattern.
  - Store updates (tag, note, cancel) are jobs with retries. A failure shows on the order and alerts
    admins.
- **Rationale:** per-message payloads tie each tap to its order without a lookup by text. The tick
  pattern is proven in 005.

## R11. Cart reminders and recovery

- **Decision:**
  - A cart becomes due at its first wait.
  - At each step the tick fetches the cart again (Shopify) or the order (WooCommerce), checks
    consent (marketing needs `OPTED_IN`, 001) and the stop rules, and writes the reminder.
  - **Stop rules:** an order for the same customer at the store, an opt-out, a block, or an
    inbound message on the store's number after the cart started (the 005 leaving pattern).
  - **Recovery:** an order within 7 days after a reminder, by the same contact at the same store,
    marks the cart recovered with its value.
  - The cart link is a 005 tracked link, so clicks count.
  - Reminder templates must be in the Marketing category: Meta treats cart reminders as marketing,
    and mixing order and promotional content makes a template marketing.
- **Rationale:** these are Meta's category rules (Sources), and the 001 consent rules apply.

## R12. Chat links and QR codes

- **Decision:**
  - The link is `${PUBLIC_LINK_BASE_URL}/c/{code}`, served by the api at `GET /l/c/:code`. The
    005 link rules apply: no-store caching, no referrer, previews and robots not counted, and the
    same rate limit. It answers 302 to `https://wa.me/{digits}?text={encoded message}`.
  - The message ends with ` (ref ABC123)`: 6 characters from an alphabet without look-alikes.
    The inbound handler matches the last `(ref XXXXXX)` in the first message of a chat, counts the
    chat as started, tags the contact and starts the link's flow, before keyword flows, unless a
    flow or a member's chat is active (003 rules).
  - QR codes are made with the `qrcode` package (1.5.4, MIT; SVG and PNG). The poster is a
    printable page in the web app (print CSS), so no PDF library is needed.
  - Openings are stored in `chat_link_opens`, and starts in `chat_link_starts`.
- **Rationale:** counting openings needs our own redirect. A reference is the only way the
  pre-filled text can say which link brought the chat.
- **Alternatives considered:**
  - Meta's QR code API (`message_qrdls`): rejected. It gives Meta-hosted links and images, but
    openings cannot be counted.
  - Our own QR encoder: rejected, because it is error-prone. A small, widely used library is
    justified in Complexity Tracking.

## R13. Number connection wizard

- **Decision:** the wizard uses the pinned Graph API version v27.0, which 001 already uses.
  - **Token:**
    - `GET /debug_token`, with the app token `{META_APP_ID}|{META_APP_SECRET}` when the app id is
      set (otherwise the pasted token itself).
    - Needed scopes: `whatsapp_business_management` and `whatsapp_business_messaging`.
    - `expires_at = 0` means it never expires; system user tokens are recommended.
  - **Accounts:** WABA ids come from `granular_scopes[].target_ids` for
    `whatsapp_business_management`. Then `GET /{waba-id}?fields=name,currency,timezone_id` and
    `/{waba-id}/phone_numbers`.
  - **Number fields:** `display_phone_number`, `verified_name`, `name_status`, `status`,
    `code_verification_status`, `quality_rating`, `platform_type`, `throughput` and
    `whatsapp_business_manager_messaging_limit`. `messaging_limit_tier` is deprecated; messaging
    limits belong to the business portfolio since 2025-10-07.
  - **Fixes, after the admin confirms:**
    - `POST /{phone-number-id}/register` with `{ messaging_product: "whatsapp", pin }`
    - `POST /{waba-id}/subscribed_apps`
  - **App webhook check:** `GET /{app-id}/subscriptions` with the app token, expecting
    `${APP_URL}/api/webhooks/meta` (the 001 route). When it is wrong, the wizard shows the value to
    enter in the app dashboard.
  - **Test:** an approved template to the admin's phone (the account's `hello_world` sample when
    present). Its `delivered` status webhook proves the webhook path works.
  - The existing manual form and `MetaGraphClient` stay. The wizard adds client methods, and mock-meta
    gains these routes.
- **Rationale:** each check maps to one documented field or call, so a failure can name its fix
  (FR-052).

## R14. Permissions, audit, retention, metrics and alerts

- **Permissions:**
  - A new `integrations.manage` permission (admins only) covers webhook endpoints and stores.
  - `apikeys.manage` covers key scopes, and `numbers.manage` covers the wizard.
  - API campaigns, store automations and chat links use `campaigns.manage` and `campaigns.launch`;
    results use `campaigns.view` (FR-056).
- **Audit:** the actions are listed in data-model.md, with the 005 coverage test pattern.
- **Retention (daily job):**
  - outbound events and deliveries after 30 days
  - store events after 30 days
  - store orders, carts and COD answers after 12 months
  - chat link opens and starts after 12 months
- **Metrics:**
  - `wbm_webhook_deliveries_total{result}`, `wbm_webhook_delivery_seconds` and
    `wbm_webhook_backlog`
  - `wbm_store_events_total{platform,result}`
  - `wbm_store_messages_total{kind,result}`
  - `wbm_api_campaign_triggers_total{result}`
  - `wbm_chat_link_opens_total{kind}`
- **Alerts:**
  - `WbmWebhookBacklog`: due deliveries waiting over 5 minutes for 15 minutes.
  - `WbmStoreEventsFailing`: over 20% of store events failing in 15 minutes.

## R15. Testing

- **mock-meta** gains:
  - Meta: `debug_token`, `subscribed_apps`, `register`, app `subscriptions` and the new phone
    fields
  - a mock Shopify Admin GraphQL endpoint (`/shopify/admin/api/2026-10/graphql.json`) with
    orders, fulfillments, checkouts, `tagsAdd`, `orderCancel` and `webhookSubscriptionCreate`,
    and a sender for signed Shopify webhooks
  - a mock WooCommerce REST API (`/woo/wp-json/wc/v3/…`) with orders, notes and webhooks, and
    signed deliveries
  - a request catcher (`/catch/{name}`) that records outbound webhooks for e2e checks
- **Integration tests** use nock for the stores and Meta, as in 001–005.

## Sources

- Shopify: [Legacy custom apps can't be created after January 1, 2026](https://shopify.dev/changelog/posts/legacy-custom-apps-can-t-be-created-after-january-1-2026.md); [Client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant); [Verify webhook deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries.md); [Ignore duplicates](https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates); [Troubleshoot webhooks](https://shopify.dev/docs/apps/build/webhooks/troubleshoot); [WebhookSubscriptionTopic (2026-10)](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic); [Protected customer data](https://shopify.dev/apps/store/data-protection/protected-customer-data); community reports on missing checkout customer data ([1](https://community.shopify.com/t/missing-customer-data-in-abandoned-checkout-webhook/381173)).
- WooCommerce: [REST API v3 webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/); [Webhooks best practices](https://developer.woocommerce.com/docs/best-practices/urls-and-routing/webhooks/); [Introducing checkout-draft](https://developer.woocommerce.com/2020/11/23/introducing-a-new-order-status-checkout-draft/); [Abandoned cart recovery emails](https://woocommerce.com/document/managing-orders/abandoned-cart-recovery-emails/); Hookdeck's [verification](https://hookdeck.com/webhooks/woocommerce/verify) and [auto-disable](https://hookdeck.com/webhooks/platforms/how-to-solve-woocommerce-5-delivery-failure-webhook-disabling) guides.
- Meta: [Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions); [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/); [Subscribed apps](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/subscribed-apps-api); [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits); [Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization).
- Webhooks: [Standard Webhooks specification](https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/main/spec/standard-webhooks.md); [OWASP Webhook Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html).
- QR: the `qrcode` package on npm (1.5.4, MIT, published 2024-08-05).
