# Release Checklist: Commerce and Payments over WhatsApp

**Feature**: `008-commerce-payments` | **Task**: T097 | **Last run**: 2026-11-27
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (PR #10): integration, contract, e2e, Docker images, the dependency
  audit, alert rules and the secret scan. Stripe traffic in CI comes from the mock gateway in
  mock-meta (`src/stripe.ts`, with its fake payment page) and the stateful nock `FakeStripe`; Meta
  catalog and Flows traffic comes from mock-meta (`src/commerce.ts`) and `FakeCommerceGraph`. No real
  Stripe account, catalog, form or phone was used.

**Status**: Ready for review. All automated gates pass in CI (db48537, and 965456a after the last
changes), and every quickstart row is covered by integration tests and a Playwright e2e spec.

Still open before release (section 4):
- a verified UAE Stripe account with charges enabled, a restricted live key and the endpoint
- "Notifications working" in live mode
- the catalog linked to the WhatsApp account, `catalog_management` on the token and the cart enabled
- catalog, multi-product and payment templates approved
- business verification, if Meta asks for it before forms can be published
- the Shopify scopes `read_products` and `write_orders` (only for the catalog fill and marking orders paid)
- one small live payment (AED 2–5), refunded afterwards
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run lint:contracts` | ✅ PASS | redocly over every contract, now with `commerce-api.openapi.yaml` and `public-payments-v1.openapi.yaml` |
| `npm run typecheck` | ✅ PASS | api (src and tests), web (with e2e), shared and mock-meta |
| `npm test` (unit) | ✅ PASS | api 564/564 (55 files), shared 349/349 (47 files), web 8/8 (2 files) (2026-11-27, local). New: money, payments, Stripe signature, reminders, gateway checks, catalog, carts, forms, flow JSON and form token rules in shared; the payment and commerce flow steps (`run-commerce.spec.ts`), commerce payloads, the `order` case of the message parser, the payment alerts |
| `npm run test:integration` | ✅ PASS | 101 files in CI (db48537 and 965456a), 14 of them 008 suites (`payments-gateway`, `payments-requests`, `payments-lifecycle`, `pay-link`, `payments-sources`, `public-payments-api`, `payments-store-orders`, `payments-reports`, `catalog`, `catalog-fill`, `chat-orders`, `forms`, `flows-commerce`, `payments-no-card-data`), plus 008 cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `commerce.contract-spec.ts` (US1–US7 routes) against `contracts/commerce-api.openapi.yaml` and `public-payments-v1.contract-spec.ts` against `contracts/public-payments-v1.openapi.yaml`; the 005 contract lists the Paid and Not paid groups, the 006 contract the Pay link automation and the payments, commerce and forms event groups |
| RBAC from all eight contracts (T095) | ✅ PASS | `rbac.int-spec.ts` now reads the 001–008 contracts. The 41 commerce operations: 11 `integrations.manage`, 8 `inbox.reply`, 7 `forms.manage`, 5 `inbox.view`, 5 `payments.view`, 2 `data.export`, 1 `payments.manage`, 1 `flows.manage` and 1 `contacts.view`. The pay link `/l/p/{code}` and Stripe's webhook are public and skipped |
| Audit coverage (T094) | ✅ PASS | every 008 action is recorded (gateway, settings, requests, catalog, forms and exports); the pending list is empty |
| Retention and erasure (T092) | ✅ PASS | `retention.int-spec.ts`: Stripe notifications after 30 days, form answers after 12 months, removed products 90 days after removal, payment requests and chat orders after 5 years. `contact-deletion.int-spec.ts`: waiting links cancelled with their Stripe sessions queued for expiry, requests and orders kept without contact, phone, name or cart note, form answers deleted |
| No card data (T093, SC-004) | ✅ PASS | `payments-no-card-data.int-spec.ts`: a payment, a half refund and a failed attempt whose events carry a card number, last4, brand, CVC checks and billing, customer and shipping addresses; afterwards the payment, order and event tables, chat items, journey, notifications, audit entries, captured logs and outbound events hold none of it |
| Metrics and alerts (T091) | ✅ PASS | `wbm_payment_links_total{result}`, `wbm_payment_events_total{type,result,source}`, `wbm_payments_total{status}`, `wbm_chat_orders_total{mode}`, `wbm_form_answers_total{result}` and `wbm_catalog_sync_total{job,result}`; `WbmPaymentLinksFailing` and `WbmPaymentNotificationsMissing` with cases in `alerts.spec.ts` (`promtool check rules` in CI) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step |
| gitleaks (history) | ✅ PASS | CI `secret-scan`, with the mock Stripe keys and test signing secrets allowlisted by path |
| Docker images | ✅ PASS | CI `docker-images`: the api, migration and web images build |
| Playwright e2e | ✅ PASS | CI `e2e-smoke` (db48537 and 965456a), including `payments-us1-gateway` … `payments-us4-reports` and `commerce-us5-catalog` … `commerce-us8-flow-steps` |

CI per batch (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Batch | First push | Result |
|---|---|---|
| Setup, foundation, US1–US4 | the first run once PR #10 was opened | the secret scan, lint, contract descriptions, a test helper's type, the store limit and the retarget groups, fixed in 972cb0b, 02c8a22, 5d0e285, cd20ecb and d1b6b7d (section 3, items 1–3) |
| US5, US6 fixes | 3152ce7 | build-test green; e2e 58 of 62 (section 3, items 4–5) |
| US6–US8 | dd4753f | one contract failure (section 3, item 6) |
| Polish (T091–T095) | db48537 | green (25 minutes, all four jobs) |
| US8 draft rules, test session case, editor finder, docs | 965456a | green (all four jobs) |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Stripe connection | ✅ | Shared gateway check rules. Integration `payments-gateway` (nock `FakeStripe`): checks with fixes (rejected key, missing permissions, charges off, other currency), the key and signing secret stored encrypted and never returned, automatic and manual endpoint registration, the notification check, disconnect, audit entries without keys. Contract US1. E2e `payments-us1-gateway` | A restricted live key and "Notifications working" in live mode |
| US2 Payment requests in live chat | ✅ | Integration `payments-requests`, `payments-lifecycle` and `pay-link`: limits and roles, the session text and button, paid once whatever the order, failed attempts, expiry by the tick with the session expired at Stripe, paid late, cancel and resend, the other mode ignored, the reconciler, the pay link with a new session after 24 hours. Contract US2. E2e `payments-us2-live-chat` | One small live payment, refunded |
| US3 Flows, campaigns, the API and store orders | ✅ | Unit cases for the payment step. Integration `payments-sources` (flow step with paid and not paid branches, test sessions, campaign links per recipient, missing amounts held back) and `public-payments-api` (idempotency, scopes, the public error shape), `payments-store-orders` (the Pay link automation, the order marked paid in Shopify). Contract `public-payments-v1`. E2e `payments-us3-sources` | Approve a payment template with the pay link button |
| US4 Reminders, totals and retargeting | ✅ | Integration `payments-reports`: reminder slots claimed once and sent only after delivery, totals by status, day and source without test requests, filters, the CSV export with `data.export` and an audit entry, Paid and Not paid groups. Contract US4. E2e `payments-us4-reports` (live-mode mock key) | Approve the reminder template |
| US5 Catalog and product messages | ✅ | Shared catalog rules. Integration `catalog` (connect, the hourly copy and Copy products now, commerce settings per number, not sendable reasons, product messages in the window) and `catalog-fill` (Shopify and WooCommerce items through `items_batch`, batch status). Contract US5. E2e `commerce-us5-catalog` | Link the real catalog and enable the cart |
| US6 Carts and chat orders | ✅ | Unit `order` parsing. Integration `chat-orders`: warnings, automatic and review modes, edit and send link, cancel, payments mirrored on the order, a flow waiting for a cart. Contract US6. E2e `commerce-us6-chat-orders` | A real cart from a phone |
| US7 WhatsApp Forms | ✅ | Shared form, Flow JSON and token rules. Integration `forms`: build, check, publish numbered versions to each account, archive and delete rules, send with a signed token, answers checked by type into attributes, tags and consent, the journey and `form.submitted`, answers export. Contract US7. E2e `commerce-us7-forms` | Publish a real form (business verification if Meta asks) |
| US8 Commerce flow steps | ✅ | Shared step schemas, the cart total and publish facts; engine cases in `run-commerce.spec.ts`. Integration `flows-commerce`: a product list, the cart into the flow (mode `FLOW`, no automatic link), the cart total charged and the paid branch, a test session marked paid, form answers in a later message, publishing refused without the catalog or a published form. E2e `commerce-us8-flow-steps` | Run the flow on a real number |

## 3. Gaps found and fixed during implementation

1. **Secret scan:** the mock Stripe keys and test signing secrets matched gitleaks rules; they are
   allowlisted by path (mocks and tests only) in `.gitleaks.toml`.
2. **Contract descriptions:** descriptions with commas or colons broke redocly's struct checks; they
   are quoted.
3. **The shared test database's store limit:** payment store tests left stores connected and later
   suites hit the limit of five; each test now disconnects its stores.
4. **The retarget dialog:** with the two payment groups it grew taller than the viewport and its
   button could not be clicked; it scrolls, and Paid and Not paid show only for campaigns that asked
   for payment.
5. **Two alerts on the page:** Next's route announcer also has `role="alert"`; the gateway e2e
   picks the message by its text.
6. **A new form's draft:** it had no screens, which the contract refuses (`minItems: 1`); a new form
   starts with one screen, as the builder shows it.
7. **An empty Send products step:** the schema required a product, so a step just added from the
   palette could not be saved as a draft; choosing products is a publish check, with the product
   list limits (30 products, none twice).
8. **Products without a price:** they showed "0.00 AED"; they show no price.
9. **Publishing a form again after Meta refused it:** Meta's flow name had to be unique; each try
   gets a unique suffix.

## 4. Before release (owner: the company's admin)

- [ ] **Stripe:** the UAE account verified with charges enabled; a restricted live key with the
      permissions in `contracts/stripe.md`; the endpoint registered (automatically or by hand); "Notifications
      working" passed in live mode
- [ ] **Meta:** the catalog connected to the WhatsApp account in WhatsApp Manager; `catalog_management`
      on the system user token; the cart enabled on the numbers; catalog, multi-product and payment
      templates approved; business verification if Meta asks for it before forms can be published
- [ ] **Shopify (optional):** the app scopes `read_products` (catalog fill) and `write_orders` (orders
      marked paid)
- [ ] **A real test:** one small live payment (AED 2–5) through a pay link, seen as Paid in the chat,
      then refunded in Stripe and seen as Refunded
- [ ] **Sign-off:** the product owner
