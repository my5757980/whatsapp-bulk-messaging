# Release Checklist: Integrations and the Developer Platform

**Feature**: `006-integrations-platform` | **Task**: T091 | **Last run**: 2026-11-25
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (draft PR #7): integration, contract, e2e, Docker images, the
  dependency audit, alert rules and the secret scan. Store, Meta and webhook traffic in CI comes
  from mock-meta (the mock Shopify and WooCommerce stores, the request catcher and the wizard
  routes) and from nock, never from real stores, accounts or phones.

**Status**: Ready for review. All automated gates pass in CI (f07ac55), and every quickstart row is
covered by integration tests and a Playwright e2e spec. Still open before release (section 4):
- the Shopify app and the WooCommerce keys of the real stores, with test orders
- the Meta app's webhook address, checked by the wizard
- Meta approval of the order, COD and cart templates
- the public link address for chat links
- the perf runs on staging
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web (with e2e), shared, mock-meta and `tools/perf` |
| `npm test` (unit) | ✅ PASS | api 488/488 (50 files), shared 247/247 (31 files), web 8/8 (2 files) (2026-11-25, local) |
| `npm run test:integration` | ✅ PASS | 79 files in CI (f07ac55), 9 of them integrations suites (`integrations-webhooks`, `-contacts-api`, `-api-campaigns`, `-shopify`, `-woocommerce`, `-cod`, `-carts`, `-chat-links`, `-number-wizard`), plus 006 cases in `rbac`, `public-api-scopes`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `integrations.contract-spec.ts`: US1, US3, US4 (with the carts list), US7 and US8 against `contracts/integrations-api.openapi.yaml`; `public-api-v1.contract-spec.ts`: the contacts API and API campaign calls |
| RBAC from all six contracts (T088) | ✅ PASS | `rbac.int-spec.ts` now reads the 001–006 contracts. The 49 integrations operations match the code: 16 `integrations.manage`, 14 `campaigns.view`, 7 `campaigns.manage`, 3 `campaigns.launch`, 6 `numbers.manage`, 2 `data.export` and 1 `apikeys.manage`. The two store receivers and `/l/c/{code}` are public and skipped |
| Key permissions (T088) | ✅ PASS | `public-api-scopes.int-spec.ts`: each of the 14 public API v1 operations answers 403 `insufficient_scope` to a key without its `x-scope`, and gets past the check with only that permission |
| Audit coverage (T087) | ✅ PASS | all 25 integration actions are recorded, including `chat_link.contacts_tagged` (added in US7); the pending list is empty |
| Retention and erasure (T086) | ✅ PASS | `retention.int-spec.ts`: outbound events (with their deliveries) and store events after 30 days; API campaign calls, orders with their messages, carts with their reminders, chat link openings and starts and wizard checks after 12 months. `contact-deletion.int-spec.ts`: carts stop (`deleted`), COD questions close, calls, orders and chat starts keep their rows without the person, and waiting deliveries that name them are cancelled |
| Metrics and alerts (T085) | ✅ PASS | `wbm_webhook_deliveries_total`, `wbm_webhook_delivery_seconds`, `wbm_webhook_backlog` (filled at scrape time), `wbm_store_events_total`, `wbm_store_messages_total`, `wbm_api_campaign_triggers_total` and `wbm_chat_link_opens_total`. `promtool check rules` passes with `WbmWebhookBacklog` and `WbmStoreEventsFailing` (`alerts.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step |
| gitleaks (history) | ✅ PASS | CI `secret-scan`, with the narrow allowlist of test placeholders in `.gitleaks.toml` |
| Docker images | ✅ PASS | CI `docker-images`: the api, migration and web images build, and the 002 live event smoke test still passes |
| Playwright e2e | ✅ PASS | CI `e2e-smoke` (f07ac55): 47/47 specs in 11.2 minutes, including `integrations-us1-webhooks` … `integrations-us8-number-wizard` |
| Performance SC-001 (webhooks) | 🟡 NOT RUN | `npm run perf:webhooks` is ready (T089): an endpoint on the mock catcher for `contact.created`, 500 contacts made in parallel, each event's time from happening to arriving (limit 10 seconds at p99), and a check that none arrives twice. It needs the api and worker with `OUTBOUND_ALLOW_LOCAL=true`; run it on staging hardware |
| Performance SC-004 (stores) | 🟡 NOT RUN | `PERF_NUMBER_ID=<id> npm run perf:stores` is ready (T089): a mock Shopify store, 400 signed `orders/create` events and 100 repeats (half the same delivery, half a new delivery for the same order), exactly one confirmation per order, 95% within a minute |

CI per story (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Story | First push | Green at |
|---|---|---|
| Setup, foundation, US1 | earlier pushes (failures: a transaction waiting for a second pool connection; other tests' endpoints; the secret scan) | 094f01e |
| US2, US3 | earlier pushes (failures: a seeded contact already opted in; drips left active by another test) | 094f01e |
| US4 | earlier pushes (failure: nock 15 reply functions take one Fetch `Request`) | 094f01e |
| US5 | cb6a864 | cb6a864 |
| US6 | 083d5fa (failure: a cart link had no owner for the 005 one-owner check) | 459d62d |
| US7 | 94a7e60 (failures: an audit action missing from the data model; new contacts never counted; the test quiz flow could not be published) | 459d62d |
| US8 | 71e853f (server), d781927 (web; failure: the numbers list was cached from before the wizard) | f07ac55 |
| Polish | a41f0dc, 6c1507f, ab6d1d9 (failure: the scope test expected 15 public operations, there are 14) | f07ac55 |
| US1 e2e under a busier worker | f23cb6b (failure: no status event in 150 seconds; see section 3) | 459d62d |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Webhooks | ✅ | Shared signature and retry rules. Integration `integrations-webhooks`: signed deliveries, the test event, retries with growing waits, pause and resume (events sent while paused arrive on resume), automatic pause with an alert, the delivery log and resend, secret renewal with both secrets for 24 hours, the event catalog. Contract US1. E2e `integrations-us1-webhooks` | Point one real receiver (for example n8n) at staging and check the signature |
| US2 Contacts API | ✅ | Shared scopes. Integration `integrations-contacts-api`: find, create, update, tags, attributes, opt-in and opt-out with the key in the journey, idempotent writes, drip enrolment, 403 `insufficient_scope`. Contract `public-api-v1`. Key permission test over every operation. E2e `integrations-us2-contacts-api` | — |
| US3 API campaigns | ✅ | Shared API campaign values. Integration `integrations-api-campaigns`: drafts, going live with checks, calls with values, tags and attributes, contacts made on first call, the daily limit, self-pause when the template or number changes, results per day and the export. Contract US3 and `public-api-v1`. E2e `integrations-us3-api-campaigns` | — |
| US4 Order notifications | ✅ | Shared store payload mapping and phone choice. Integration `integrations-shopify` and `integrations-woocommerce`: signed receivers, deduplication, order stages, the reconciler, consent from the checkout, the store's error state. Contract US4. E2e `integrations-us4-store-orders` | Connect the real Shopify and WooCommerce stores (section 4) |
| US5 COD | ✅ | Shared COD rules. Integration `integrations-cod`: the question with quick-reply buttons, the first answer wins, reminders and no answer on the tick, store tags and automatic cancel as retried jobs, orders closed by the store first, results and alerts. E2e `integrations-us5-cod` | A COD template with two quick-reply buttons approved by Meta |
| US6 Carts | ✅ | Shared cart rules. Integration `integrations-carts`: reminders at their times with a tracked cart link, once per step, recovery after an order, consent required, stops on a reply, opt-out or block, expiry after 7 days, WooCommerce unpaid orders with their payment link. Contract (carts list). E2e `integrations-us6-carts` | A marketing cart template approved by Meta; the checkout text names WhatsApp |
| US7 Chat links | ✅ | Shared chat link references. Integration `integrations-chat-links`: links with a code and reference, the redirect with previews, robots and the rate limit, the "no longer in use" page, chat starts that tag the contact and start the link's flow before keyword flows, never over a running flow or a member's chat, new contacts, results, contacts, tagging, the export and QR images. Contract US7. E2e `integrations-us7-chat-links` | Scan a printed code with a phone on mobile data on staging |
| US8 Number wizard | ✅ | Unit wizard check rules and Graph calls. Integration `integrations-number-wizard` (nock Graph): a session from a token, the accounts list, checks, fixes only when asked, the test message with its delivered status, connecting through the 001 service with the token encrypted, the health check changing nothing, expired and other admins' sessions, audit entries without the token or PIN. Contract US8. E2e `integrations-us8-number-wizard` on mock-meta | Run the wizard once against the real Meta app (section 4) |

## 3. Gaps found and fixed during implementation

1. **nock 15:** a reply function gets one Fetch `Request`; a two-parameter function is treated as a
   callback and never answers. All store, Graph and wizard fakes use the one-argument form.
2. **Pool starvation:** the outbound event subscribers are read on the caller's transaction, so a
   transaction never waits for a second pool connection.
3. **Endpoint changes across processes:** endpoints change in the api while the worker writes most
   events. The worker kept its subscriptions for 15 seconds, so events right after a new endpoint
   were never recorded for it (the US1 e2e saw no status events). The cache is now checked against
   the endpoints table (count and newest change) at most once a second.
4. **Cart reminder links:** the 005 check gives each tracked link target exactly one owner. Cart
   links now have the store cart as their owner (`tracked_link_targets.store_cart_id`), and the
   check counts three owners. The data model says so.
5. **New contacts for chat links:** the 001 inbound handler creates unknown senders before live chat
   runs, so it now flags the messages that created their contact, and the matcher reads the flag.
6. **When a chat start counts:** research R12 said "the first message of a chat". The spec (FR-048)
   counts the pre-filled message whenever it arrives, and the data model counts a contact once a
   day per link, so a returning customer who scans a code again counts again on another day.
7. **Wizard tokens:** the contract asks for tokens of at least 20 characters, so the mock-meta
   wizard tokens are `mock-token-ok-wizard`, `mock-token-missing-scope-wizard` and
   `mock-token-expiring-wizard`; the quickstart row says so.
8. **WooCommerce carts:** WooCommerce core has no abandoned cart event, so cart reminders cover
   orders left unpaid, with their payment link (spec Assumptions, research R8).
9. **Secret scan:** test placeholders (example keys and secrets) are allowlisted by exact text.

## 4. Before release (open)

- [ ] **Shopify:** the store's app in the Dev Dashboard with `read_orders`, `write_orders` and
      `read_customers`, and protected customer data (name, email, phone and address) declared.
      Connect the store, place a test order and a COD order, and start a checkout.
- [ ] **WooCommerce:** the store on https with Read/Write REST API keys. After connecting, check that
      the platform's webhooks are active, and place a test order.
- [ ] **Meta app:** the callback URL `${APP_URL}/api/webhooks/meta` with the messages field. Set
      `META_APP_ID` and run *Run checks* on a connected number: *Webhook address* must pass.
- [ ] **Checkout consent:** the store's checkout text names WhatsApp before an admin confirms that
      the store's marketing consent counts (FR-040).
- [ ] **Templates:** Meta approval of the order update templates (utility), a COD template with two
      quick-reply buttons, and the cart reminder templates (marketing).
- [ ] **Chat links:** `PUBLIC_LINK_BASE_URL` on the company's domain, with `/c/<code>` reaching the
      api's `/l/c/<code>`.
- [ ] **Performance:** `npm run perf:webhooks` and `npm run perf:stores` on staging hardware.
- [ ] **Sign-off:** the product owner accepts the eight quickstart rows on staging.
