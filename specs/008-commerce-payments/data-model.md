# Data Model: Commerce and Payments over WhatsApp

**Feature**: `008-commerce-payments` | **Date**: 2026-11-25 | **Plan**: [plan.md](./plan.md)

Migration `20261203000000_commerce_payments` (Prisma, PostgreSQL 16).
- **Columns:** ids are `uuid(7)`, money is integer minor units (`bigint`) with a `char(3)` lower-case
  ISO currency, and times are `timestamptz`.
- **Names:** Prisma models are PascalCase, tables snake_case.
- **Why fields exist:** "FR-" references point to spec.md and "R" references to research.md.

## Enum changes (existing enums)

| Enum | New values | Why |
|---|---|---|
| `ChatContentType` | `PAYMENT_REQUEST`, `PRODUCT`, `PRODUCT_LIST`, `CATALOG`, `ORDER`, `FORM` | Outbound cta_url, product and flow messages; inbound carts (R5, R10–R12). `FORM_REPLY` already exists (002). |
| `MessageOrigin` | `PAYMENTS` | Payment templates, reminders and store pay links sent through the 001 queue |
| `JourneyEventType` | `PAYMENT_REQUESTED`, `PAYMENT_PAID`, `PAYMENT_EXPIRED`, `PAYMENT_REFUNDED`, `CHAT_ORDER_RECEIVED`, `FORM_SUBMITTED` | FR-013, FR-016, FR-026, FR-034 |
| `NotificationType` | `PAYMENT_RECEIVED`, `PAYMENT_PAID_LATE`, `PAYMENTS_CONNECTION_ERROR`, `CATALOG_SYNC_FAILED` | FR-012, FR-013 |
| `ConsentSource` | `FORM` | A form's opt-in field (FR-035) |
| `StoreAutomationKind` | `PAY_LINK` | Pay now links for store orders (R5) |

New enums: `PaymentProvider` (`STRIPE`), `GatewayMode` (`LIVE`, `TEST`), `GatewayStatus` (`CONNECTED`,
`ERROR`), `PaymentStatus`, `PaymentSource`, `PaymentEventSource`, `PaymentEventResult`,
`ChatOrderMode`, `ChatOrderStatus`, `FormStatus`, `FormVersionStatus`, `FormCategory`.

Code-only lists (no schema change):
- permissions `payments.view`, `payments.manage`, `forms.manage`
- API key scopes `payments.read`, `payments.write`
- outbound event types (R14)
- retarget groups `PAID`, `NOT_PAID`
- template button types `CATALOG`, `MPM`, `FLOW`
- flow step types `product`, `catalog`, `payment`, `form`

## PaymentGateway → `payment_gateways`

One row at most (single tenant). FR-001–FR-005, R1, R4.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| provider | PaymentProvider | `STRIPE` |
| mode | GatewayMode | From the key prefix, checked against `livemode` |
| accountId | varchar(64) | Stripe `acct_…` |
| accountName | varchar(200) | Display name from the account check |
| country | char(2) | `AE` expected |
| currency | char(3) | Connection currency, e.g. `aed`; one per connection |
| secretKeyEnc | text | `TokenCipher`; never returned |
| keyKind | varchar(10) | `restricted` or `secret` (a secret key shows a warning) |
| webhookSecretEnc | text? | `whsec_…`, encrypted |
| previousWebhookSecretEnc | text? | Kept during a secret roll |
| previousSecretUntil | timestamptz? | |
| webhookEndpointId | varchar(64)? | Set when we registered the endpoint (deleted on disconnect) |
| status | GatewayStatus | `ERROR` blocks new requests and makes the pay link show "paused" |
| checks | jsonb | `[{key, status: PASSED/FAILED/WARNING, detail, fix}]` |
| notificationCheck | jsonb | `{status: PENDING/PASSED/FAILED, sessionId, startedAt, passedAt}` |
| lastCheckedAt | timestamptz? | |
| lastEventAt | timestamptz? | Last verified notification (alerting) |
| eventsCursor | timestamptz? | Reconciler cursor |
| connectedById | uuid? → users | |
| createdAt / updatedAt | timestamptz | |

## PaymentSettings → `payment_settings`

One row, created with defaults. FR-006–FR-008, FR-017, FR-027.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| maxAmountMinor | bigint | Default 1,000,000 (AED 10,000) |
| defaultExpiryMinutes | int | Default 1,440; 30–43,200 |
| requestRoles | text[] | Default `{ADMIN,MANAGER,AGENT}` |
| sessionText | varchar(1024) | cta_url body with `{amount}`, `{description}`, `{reference}`, `{expires}` |
| buttonText | varchar(20) | Default "Pay now" |
| templateId | uuid? → templates | Payment template for outside the window (pay link URL button) |
| templateMapping | jsonb | 001 `VariableMappingSchema` with the `payment` source |
| reminders | jsonb | Up to 2: `[{beforeMinutes, templateId, mapping}]` |
| chatOrderMode | ChatOrderMode | `AUTO` or `REVIEW` (default `REVIEW`) |
| chatOrderExpiryMinutes | int | Default 1,440 |
| chatOrderTagId | uuid? → tags | Added when a chat order is paid |
| updatedById | uuid? → users | |
| updatedAt | timestamptz | |

## PaymentRequest → `payment_requests`

FR-006–FR-016, R2, R5, R6.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Also the Stripe `client_reference_id` and metadata value |
| code | varchar(16) unique | Pay link code (005 `makeLinkCode`) |
| contactId | uuid? → contacts | `SET NULL` on erasure |
| conversationId | uuid? → conversations | |
| phoneE164 | varchar(16)? | Cleared on erasure |
| customerName | varchar(120)? | Snapshot for exports; cleared on erasure |
| amountMinor | bigint | ≥ the currency minimum, ≤ `maxAmountMinor` |
| currency | char(3) | The connection currency at creation |
| description | varchar(250) | |
| reference | varchar(80)? | Optional order number etc.; not unique |
| expiresAt | timestamptz | 30 min – 30 days after creation (flows ≤ 1,380 min) |
| status | PaymentStatus | `WAITING`, `PAID`, `EXPIRED`, `CANCELLED`, `REFUNDED` |
| source | PaymentSource | `INBOX`, `FLOW`, `CAMPAIGN`, `API`, `STORE_ORDER`, `CHAT_ORDER` |
| createdById | uuid? → users | INBOX, or the member who sent a chat order link |
| apiKeyId | uuid? → api_keys | API |
| flowSessionId | uuid? → flow_sessions | FLOW (`SET NULL`) |
| campaignId | uuid? → campaigns | CAMPAIGN |
| messageId | uuid? → messages | The template message that carried it |
| chatItemId | uuid? → chat_items | The cta_url session message |
| storeOrderId | uuid? → store_orders | STORE_ORDER |
| chatOrderId | uuid? → chat_orders | CHAT_ORDER |
| tagId | uuid? → tags | Added when paid |
| flowId | uuid? → flows | Started when paid (006 chat-link rule) |
| isTest | boolean | Test-mode connection or a flow test session; excluded from totals |
| sessionId | varchar(80)? | The current Stripe Checkout Session |
| sessionUrl | text? | Its hosted URL (the redirect target) |
| sessionExpiresAt | timestamptz? | |
| sessionsCreated | int | Idempotency counter `s<n>` |
| sessionExpirePending | boolean | Our expiry or cancel still has to expire the session at Stripe |
| sessionExpireAttempts | int | At most 10 |
| paymentIntentId | varchar(80)? | Set on completion; refunds match by it |
| paidAt | timestamptz? | |
| paidAmountMinor | bigint? | `amount_total` from Stripe |
| paidLate | boolean | Paid after `expiresAt` or cancellation (FR-012) |
| failedAttempts | int | |
| lastFailureCode | varchar(60)? | Stripe `decline_code` or `code`; never card details |
| lastFailedAt | timestamptz? | |
| refundedMinor | bigint | Cumulative `amount_refunded`; 0 < x < paid → partly refunded |
| refundedAt | timestamptz? | |
| cancelledAt | timestamptz? | |
| cancelledById | uuid? → users | |
| expiredAt | timestamptz? | |
| remindersSent | int | 0–2 |
| nextReminderAt | timestamptz? | Null when no reminder is due |
| opens | int | Pay link opens (previews and robots not counted) |
| firstOpenedAt | timestamptz? | |
| createdAt / updatedAt | timestamptz | |

**Indexes:**
- unique `code`
- `(status, expires_at)`, partial `WHERE status = 'WAITING'` (tick)
- `(next_reminder_at)`, partial `WHERE next_reminder_at IS NOT NULL` (tick)
- `(contact_id, created_at)`
- `(campaign_id, status)`
- `(source, created_at)`
- `(created_at)`
- `(payment_intent_id)`
- `(reference)`
- `(chat_order_id)`
- `(store_order_id)`

**State transitions** (shared `applyPaymentEvent`, ranks WAITING 0 < EXPIRED/CANCELLED 1 < PAID 2 <
REFUNDED 3):

```text
WAITING ──paid──────────────▶ PAID ──refund (full)──▶ REFUNDED
   │                           │  └─refund (part): stays PAID, refundedMinor > 0
   ├──expiry (tick)──▶ EXPIRED ─paid (late)─▶ PAID (paidLate = true)
   └──cancel─────────▶ CANCELLED ─paid (race)─▶ PAID (paidLate = true)
failed attempt: stays WAITING, failedAttempts + 1, lastFailureCode
```

**Display states** (shared): Waiting, Failed attempt (WAITING and failedAttempts > 0), Paid, Paid
late, Partly refunded, Refunded, Expired, Cancelled. The delivery problem "Not delivered" comes from
the linked message's or chat item's status.

## PaymentEvent → `payment_events`

Every Stripe notification as received; 30-day retention. FR-004, R3.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| stripeEventId | varchar(80)? unique | Null for rejected requests |
| type | varchar(80) | e.g. `checkout.session.completed` |
| livemode | boolean? | |
| signatureValid | boolean | |
| source | PaymentEventSource | `WEBHOOK`, `RECONCILE`, `CHECK` |
| result | PaymentEventResult | `PENDING`, `APPLIED`, `IGNORED`, `DUPLICATE`, `REJECTED`, `FAILED` |
| paymentRequestId | uuid? → payment_requests | `SET NULL` |
| body | jsonb? | The event with card and customer details removed by `redactStripeEvent` (`payment_method_details`, `billing_details`, `customer_details`, `shipping_details`, `last_payment_error.payment_method`). Rejected requests keep only the headers and the first 2 KB. |
| error | varchar(500)? | |
| stripeCreatedAt | timestamptz? | Event `created` |
| receivedAt | timestamptz | |
| processedAt | timestamptz? | |

**Indexes:** unique `stripe_event_id`; `(received_at)`; `(payment_request_id)`.

## CatalogConnection → `catalog_connections`

One row at most. FR-021, FR-022, R8, R9.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| catalogId | varchar(40) | Meta catalog id |
| name | varchar(200) | |
| wabaChecks | jsonb | `[{wabaId, connected: boolean}]`; numbers inherit their WABA's result |
| syncStatus | varchar(20) | `IDLE`, `RUNNING`, `FAILED` |
| lastSyncedAt | timestamptz? | |
| productCount | int | |
| lastSyncError | varchar(500)? | |
| fillStoreId | uuid? → store_connections | Fill from this 006 store (`SET NULL`) |
| fillEnabled | boolean | |
| lastFilledAt | timestamptz? | |
| fillErrors | jsonb | Last batch errors `[{retailerId, message}]` (max 200) |
| connectedById | uuid? → users | |
| createdAt / updatedAt | timestamptz | |

## CatalogProduct → `catalog_products`

The platform's copy of the catalog. FR-021, FR-025, R8.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| retailerId | varchar(100) unique | Meta `retailer_id` (Content ID) |
| metaProductId | varchar(40)? | |
| name | varchar(200) | |
| description | text? | |
| priceMinor | bigint? | Parsed from Meta's price text; null if unparsable |
| salePriceMinor | bigint? | |
| currency | char(3)? | |
| imageUrl | text? | |
| url | text? | |
| availability | varchar(30) | e.g. `in stock` |
| visibility | varchar(20)? | e.g. `published`, `staging` *(verify)* |
| reviewStatus | varchar(20)? | e.g. `approved`, `rejected` |
| removedAt | timestamptz? | Missing from the last full read; purged after 90 days |
| fillHash | char(64)? | Content hash of the last item sent by the store fill |
| storeRef | varchar(80)? | Store product or variant id when filled from a store |
| syncedAt | timestamptz | |

**Indexes:** unique `retailer_id`; trigram GIN on `name` and on `retailer_id` (`pg_trgm`, already
enabled in 002 *(verify; otherwise the migration enables it)*); `(removed_at)`.

## ChatOrder → `chat_orders`

A cart a customer sent in chat. FR-026–FR-029, R11.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| contactId | uuid? → contacts | `SET NULL` on erasure |
| conversationId | uuid? → conversations | |
| chatItemId | uuid? → chat_items | The inbound `ORDER` item |
| catalogId | varchar(40) | From the order message |
| customerText | varchar(1000)? | The note the customer added |
| items | jsonb | `[{retailerId, name, quantity, itemPriceMinor, currency}]` |
| currency | char(3) | |
| totalMinor | bigint | Σ quantity × itemPriceMinor (the cart's prices) |
| warnings | jsonb | `[{kind: NOT_IN_CATALOG / CURRENCY / MIXED_CURRENCY / PRICE_CHANGED, retailerId?, detail}]` |
| mode | ChatOrderMode | `AUTO`, `REVIEW`, `FLOW` |
| status | ChatOrderStatus | `RECEIVED`, `LINK_SENT`, `PAID`, `EXPIRED`, `CANCELLED`, `REFUNDED` |
| paymentRequestId | uuid? | The request for its total (also `payment_requests.chat_order_id`) |
| editedById | uuid? → users | Changed in review |
| cancelledById | uuid? → users | |
| createdAt / updatedAt | timestamptz | |

**Indexes:** `(status, created_at)`; `(contact_id, created_at)`; `(created_at)`.

**Transitions:**
- `RECEIVED → LINK_SENT` (automatic, or the agent sends the link)
- `LINK_SENT` mirrors the request: `PAID`, `EXPIRED`, `REFUNDED`
- `RECEIVED` or `LINK_SENT` → `CANCELLED` (a member; this also cancels the request)

## Form → `forms`

FR-030–FR-035, R12.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | varchar(80) | Unique among non-archived forms |
| category | FormCategory | `SIGN_UP`, `APPOINTMENT_BOOKING`, `LEAD_GENERATION`, `CONTACT_US`, `CUSTOMER_SUPPORT`, `SURVEY`, `OTHER` |
| status | FormStatus | `DRAFT`, `PUBLISHED` (has a live version), `ARCHIVED` |
| draft | jsonb | Shared `FormModelSchema`: `{screens:[{title, texts, fields:[{key, type, label, required, options, …}], button}]}` |
| mapping | jsonb | `[{fieldKey, attributeKey}]` (001 attribute definitions) |
| tagIds | uuid[] | Added on every answer |
| changedSincePublish | boolean | The draft differs from the current version |
| currentVersionId | uuid? → form_versions | |
| createdById / updatedById | uuid? → users | |
| createdAt / updatedAt | timestamptz | |

## FormVersion → `form_versions`

| Field | Type | Notes |
|---|---|---|
| id | uuid | Part of the signed `flow_token` |
| formId | uuid → forms | Cascade |
| number | int | 1, 2, … unique per form |
| model | jsonb | The draft as published |
| mapping | jsonb | Mapping and tags as published |
| tagIds | uuid[] | |
| flowJson | jsonb | Compiled Flow JSON 7.3 |
| metaFlows | jsonb | `[{wabaId, flowId, status: PUBLISHED/DEPRECATED, errors}]` |
| status | FormVersionStatus | `PUBLISHED`, `FAILED`, `DEPRECATED` |
| publishedById | uuid? → users | |
| publishedAt | timestamptz | |

**Indexes:** unique `(form_id, number)`.

## FormAnswer → `form_answers`

One submission; 12-month retention; deleted on contact erasure. FR-034, R12.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| formId | uuid → forms | |
| formVersionId | uuid → form_versions | |
| contactId | uuid → contacts | Cascade on erasure |
| conversationId | uuid? → conversations | |
| chatItemId | uuid? → chat_items | The inbound `FORM_REPLY` |
| source | varchar(20) | `INBOX`, `FLOW`, `TEMPLATE`, `CAMPAIGN` (from the token) |
| flowSessionId | uuid? → flow_sessions | |
| answers | jsonb | `{fieldKey: value}` checked against the version |
| saved | jsonb | `{attributes: {...}, tags: [...], consent: boolean}` |
| problems | jsonb | `[{fieldKey, attributeKey, reason}]`, shown to agents |
| submittedAt | timestamptz | |

**Indexes:** `(form_id, submitted_at)`; `(contact_id, submitted_at)`; `(submitted_at)`.

## Changes to existing tables

| Table | Change | Why |
|---|---|---|
| `campaigns` | `payment_config jsonb NULL`: `{amount: {source: static/attribute, minor?, attributeKey?}, description, expiryMinutes, tagId?, flowId?}` | Campaign payment requests (R5) |
| `campaigns` | Variable mapping gains `products: {thumbnailRetailerId?, sections?}` (inside the existing JSON) | CATALOG and MPM templates (R10) |
| `store_automations` | Kind `PAY_LINK`; settings `{includeCod: boolean, expiryMinutes}` | R5 |
| `store_orders` | `payment_request_id uuid NULL` (→ payment_requests, `SET NULL`), `paid_via_link_at timestamptz NULL` | Order shows paid; COD closes |

## Validation rules (shared, unit-tested)

- **Amounts:**
  - integers ≥ `minimumMinor(currency)` (AED 200) and ≤ `maxAmountMinor`
  - the currency must equal the connection currency
- **Expiry:** 30 min ≤ expiry ≤ 30 days (flow step ≤ 1,380 min). The session's `expires_at` is clamped to [now + 30 min, now + 24 h].
- **Texts:** description ≤ 250, reference ≤ 80, session text ≤ 1,024 after filling, button text ≤ 20.
- **Product lists:** 1–10 sections, ≤ 30 items, ≥ 1 per section, section titles ≤ 24 when more than one section. Only sendable products.
- **Carts:** quantity ≥ 1; total recomputed from items; warnings as listed.
- **Forms:**
  - 1–10 screens; field keys unique and matching `^[a-z][a-z0-9_]{0,39}$`
  - every non-final screen leads on; the last screen submits
  - choices have 1–20 options (dropdown ≤ 200)
  - texts within `FORM_LIMITS` *(verify)*
- **Flow tokens:** an HMAC mismatch, an unknown version, or a different contact means the answer is not applied.

## Retention and erasure (001 retention processor)

| Data | Kept | Erasure of a contact |
|---|---|---|
| payment_requests | 5 years | `WAITING` → cancelled (sessions expired); contact, phone and name cleared |
| chat_orders | 5 years | contact cleared |
| payment_events | 30 days | body kept (no personal fields beyond Stripe's) until purge |
| form_answers | 12 months | deleted |
| catalog_products (removed) | 90 days after removal | n/a |
