# Contract: Stripe calls, notifications and the mock gateway

**Feature**: `008-commerce-payments` | research R1–R4 | Stripe API version `2026-09-30.endive`
(`STRIPE_API_VERSION`)

Every call goes from `StripeClient` to `${STRIPE_API_BASE_URL}` (default `https://api.stripe.com`;
mock-meta in e2e) with these headers:
- `Authorization: Bearer <key>`
- `Stripe-Version: ${STRIPE_API_VERSION}`
- `Content-Type: application/x-www-form-urlencoded` on POST, with bracketed keys
- `Idempotency-Key` on every POST

Timeouts and retries:
- the timeout is 10 seconds
- network errors, 429 and 5xx are retried 3 times (0.5 s, 2 s, 5 s) with the same idempotency key

Field names marked *(verify)* are checked against the live reference when the method is written.

## Calls

### 1. `GET /v1/account`: the account check (R4)

- **Reads:** `id`, `country`, `default_currency`, `charges_enabled`, `details_submitted`,
  `settings.dashboard.display_name` (fallback `business_profile.name`), `requirements.currently_due`.
- **Errors:**
  - 401 → `KEY_INVALID` (not saved)
  - 403 with a restricted key → check `ACCOUNT_READ` WARNING *(verify the permission name)*

### 2. `POST /v1/checkout/sessions`: a session for a request (R2)

```text
mode=payment
line_items[0][price_data][currency]=aed
line_items[0][price_data][unit_amount]=15000
line_items[0][price_data][product_data][name]=Order 1042
line_items[0][quantity]=1
client_reference_id=<payment request id>
metadata[wbm_payment_request]=<payment request id>
payment_intent_data[metadata][wbm_payment_request]=<payment request id>
payment_intent_data[description]=Order 1042 · REF-1042
expires_at=<unix seconds; clamp(request expiry, now+30m, now+24h)>
success_url=https://<PUBLIC_LINK_BASE_URL>/p/<code>?paid=1
locale=auto
```

- **Idempotency key:** `wbm-pr-<id>-s<sessionsCreated+1>`.
- **Reads:** `id`, `url`, `expires_at`, `status` (`open`), `livemode`.
- **The check session (R4):** amount 200 (AED 2.00), `metadata[wbm_check]=1`, idempotency key
  `wbm-check-<connectionId>-<n>`.
- **Errors:**
  - 400 `invalid_request_error` (for example an amount below the minimum) → `GATEWAY_REFUSED`, with
    Stripe's message in `details`
  - 401 → the connection turns `ERROR` and admins are notified (`PAYMENTS_CONNECTION_ERROR`)
  - network error or 5xx after retries → `GATEWAY_UNAVAILABLE`

### 3. `POST /v1/checkout/sessions/:id/expire`: before a new session, on cancel and on expiry

- **Idempotency key:** `wbm-pr-<id>-x<n>`.
- **Answers:**
  - `status: expired` → done
  - 400 because the session is already expired → treated as done
  - 400 because the session is `complete` → read it (call 4) and apply the payment
- **Retries:** at most 10 tries over later ticks (`sessionExpireAttempts`).

### 4. `GET /v1/checkout/sessions/:id`: settle an unclear state

- **Reads:** `status`, `payment_status`, `payment_intent`, `amount_total`, `metadata`.

### 5. `POST /v1/webhook_endpoints`: automatic registration (R4)

```text
url=${APP_URL}/api/payments/stripe/webhook
api_version=2026-09-30.endive
description=WhatsApp platform payments
enabled_events[]=checkout.session.completed
enabled_events[]=checkout.session.async_payment_succeeded
enabled_events[]=checkout.session.async_payment_failed
enabled_events[]=checkout.session.expired
enabled_events[]=payment_intent.payment_failed
enabled_events[]=charge.refunded
metadata[wbm]=1
```

- **Reads:** `id` and `secret` (returned only here; stored encrypted at once).
- **On 403:** check `WEBHOOK_ENDPOINT` FAILED with the fix: "give the key Webhook Endpoints write,
  or register the endpoint by hand and paste its signing secret".

### 6. `DELETE /v1/webhook_endpoints/:id`: on disconnect

Only for the endpoint we registered. A 404 is treated as done.

### 7. `GET /v1/events`: the reconciler (R3)

```text
types[]=checkout.session.completed&types[]=checkout.session.async_payment_succeeded&...
created[gt]=<cursor − 600>&limit=100&starting_after=<last id while has_more>
```

- Events go through the same apply path with source `RECONCILE`. The cursor advances to the newest
  `created` seen.
- On 403 (the key lacks Events read): the reconciler falls back to call 4 for requests whose session
  expired more than 15 minutes ago while still `WAITING` and opened at least once.

## Notifications: `POST /api/payments/stripe/webhook`

Verification (shared `verifyStripeSignature(rawBody, header, secrets, now)`):

1. Parse the header: split on `,`, then each part on the first `=`. Take `t` and every `v1`; ignore
   other keys (for example `v0`).
2. Fail when `t` or `v1` is missing, or when `|now − t| > 300` seconds.
3. For each secret (the current one, plus the previous one until `previousSecretUntil`), compute
   `expected = hex(HMAC-SHA256(secret, t + "." + rawBody))`, and accept on a constant-time match with
   any `v1`.
4. On failure: 400 `SIGNATURE_INVALID`, and a `payment_events` row with `signatureValid=false`, the
   headers and the first 2 KB of the body.

Applying an event (shared `applyPaymentEvent`):

| Event | Request found by | Change |
|---|---|---|
| `checkout.session.completed` | `data.object.metadata.wbm_payment_request` | `payment_status = paid` → PAID (paidAt = event `created`, `paidAmountMinor = amount_total`, `paymentIntentId`). `unpaid` → wait. A completed check session (`wbm_check`) is ignored. |
| `checkout.session.async_payment_succeeded` | same | PAID |
| `checkout.session.async_payment_failed` | same | failed attempt |
| `checkout.session.expired` | same | Clears the current session if it is this one. A check session's event passes the notification check. |
| `payment_intent.payment_failed` | `data.object.metadata.wbm_payment_request` | failed attempt; `lastFailureCode = last_payment_error.decline_code ?? last_payment_error.code` |
| `charge.refunded` | `data.object.payment_intent` → `paymentIntentId` | `refundedMinor = amount_refunded`; when it equals the paid amount → REFUNDED |
| anything else | n/a | IGNORED |

Rules:
- `livemode` must equal the connection mode, otherwise IGNORED.
- A request in a final state never moves back (ranks in data-model.md).
- A payment for an EXPIRED or CANCELLED request → PAID with `paidLate = true`, and managers get
  `PAYMENT_PAID_LATE`.
- A `charge.refunded` that arrives before the payment is known is stored PENDING and retried after
  the next applied event for that request, or by the reconciler.

## The restricted key Stripe needs

| Resource | Access | Used for |
|---|---|---|
| Checkout Sessions | Write | Calls 2–4 and the check session |
| Webhook Endpoints | Write | Calls 5–6 (only with automatic registration) |
| Events | Read | Call 7 (otherwise the call 4 fallback) |
| Account / Connected account details | Read *(verify the name)* | Call 1 (otherwise WARNING) |

## Mock gateway: `tools/mock-meta/src/stripe.ts`

The api uses it with `STRIPE_API_BASE_URL=http://mock-meta:4010/stripe` in e2e and local runs.

- **Keys:** a key matching `^(rk|sk)_test_mock[A-Za-z0-9]{6,}$` is accepted. Keys ending in `nockout`
  get 401, and keys ending in `noperm` get 403 for webhook endpoints and events.
- **API:** `/stripe/v1/account`, `checkout/sessions` (create, retrieve, expire), `webhook_endpoints`
  (create, delete) and `events`, keeping state in memory.
  - Sessions get `url = http://<mock>/stripe/pay/<sessionId>`.
  - The created endpoint's `secret` is `whsec_mock` plus 24 random characters.
- **The fake hosted page** `/stripe/pay/:sessionId` has three buttons:
  - **Pay:** `checkout.session.completed` with `payment_status=paid`, then a redirect to
    `success_url`
  - **Decline:** `payment_intent.payment_failed` with `decline_code=card_declined`
  - **Refund half:** `charge.refunded` with half the amount; only after a payment
- **Control routes for tests:**
  - `POST /mock/stripe/pay` `{sessionId}` pays without the page
  - `POST /mock/stripe/refund` `{sessionId, amount}`
  - `POST /mock/stripe/replay` `{eventId}` sends a duplicate
  - `POST /mock/stripe/withhold` `{on: true}` stores events without delivering them, so the
    reconciler can find them
- **Delivery:** every event is signed with the endpoint secret as in the verification steps above,
  and posted to the registered URL (or `MOCK_STRIPE_WEBHOOK_URL`).

## Integration tests: `apps/api/test/support/fake-stripe.ts`

`FakeStripe` is a nock catch-all on `STRIPE_API_BASE_URL` with the same state model as the mock
gateway, plus two helpers:
- `fake.event(type, object)` returns `{rawBody, header}` signed with the test secret
- `fake.deliver(app, event)` posts it to the webhook route

Tests never reach the network.
