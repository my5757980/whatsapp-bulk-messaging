# Release Checklist: Click-to-WhatsApp Ads and the Ads Manager

**Feature**: `007-ads-manager` | **Task**: T072 | **Last run**: 2026-11-25
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (draft PR #9): integration, contract, e2e, Docker images, the
  dependency audit, alert rules and the secret scan. Meta traffic in CI comes from mock-meta (the ads
  routes, the lead webhook sender and the fake model) and from a small stateful Graph fake on nock,
  never from a real ad account, page or phone.

**Status**: Ready for review. All automated gates pass in CI (5a460f0), and every quickstart row is
covered by integration tests and a Playwright e2e spec. Still open before release (section 4):
- the Meta app's ads and lead permissions (App Review for `leads_retrieval` where Meta asks)
- the system user token for the company's ad account and page
- the page linked to the WhatsApp numbers, and the lead and audience terms accepted
- a payment method on the ad account and a monthly cap
- a small real campaign with a real chat and a real lead
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web (with e2e), shared, mock-meta and `tools/perf` |
| `npm test` (unit) | ✅ PASS | api 513/513 (51 files), shared 266/266 (37 files), web 8/8 (2 files) (2026-11-25, local). New: the seven shared ads rule files, `meta-ads-client.spec.ts`, the referral case of the message parser, ads redaction keys, the alert rule |
| `npm run test:integration` | ✅ PASS | 87 files in CI (5a460f0), 8 of them ads suites (`ads-connection`, `-launch`, `-chats`, `-results`, `-manage`, `-audiences`, `-leads`, `-website-ai`), plus 007 cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `ads.contract-spec.ts`: US1, US2–US3, US4–US6 and US7–US8 against `contracts/ads-api.openapi.yaml`; the 006 contract lists the two new event types and the 002 chat detail documents `adChat` |
| RBAC from all seven contracts (T070) | ✅ PASS | `rbac.int-spec.ts` now reads the 001–007 contracts. The 39 ads operations match the code: 11 `campaigns.view`, 5 `integrations.manage`, 15 `campaigns.manage`, 6 `campaigns.launch` and 2 `data.export`. `/l/a/{code}` is public and skipped |
| Audit coverage (T069) | ✅ PASS | all 15 ads actions are recorded; the pending list is empty |
| Retention and erasure (T068) | ✅ PASS | `retention.int-spec.ts`: Meta's daily numbers after 25 months; leads, chats from ads and website visits after 12 months. `contact-deletion.int-spec.ts`: leads lose answers, phone and email; chats from ads keep their rows without the person; audience hashes stay until the sync queued at deletion removes them at Meta |
| Metrics and alerts (T067) | ✅ PASS | `wbm_ads_sync_total{job,result}`, `wbm_ad_chat_starts_total{matched}`, `wbm_ad_leads_total{result}` and `wbm_ads_spend_cap_pauses_total`. `promtool check rules` passes with `WbmAdsSyncFailing` (`alerts.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step |
| gitleaks (history) | ✅ PASS | CI `secret-scan` |
| Docker images | ✅ PASS | CI `docker-images`: the api, migration and web images build |
| Playwright e2e | ✅ PASS | CI `e2e-smoke` (5a460f0), including `ads-us1-connection` … `ads-us8-website-ai` |

CI per batch (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Batch | First push | Green at |
|---|---|---|
| Setup, foundation, US1–US3 | 3b4bc39 (failure: the e2e mock token had 17 characters, below the 20-character token rule) | 5cfe771 for ads; the 001 broadcast e2e failed there on a template sync race (section 3) |
| US4–US6 | f50ccf2 | f50ccf2 |
| Template sync race fix | 267c4c6 | 267c4c6 |
| US7, US8, polish | 5a460f0 | 5a460f0 (16 minutes, all four jobs) |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Connection | ✅ | Shared check rules. Integration `ads-connection` (nock Graph): the token session encrypted in Redis, checks with fixes (missing permissions, disabled account, no payment method, page without ads access or linked numbers, terms), one saved row with both tokens encrypted and never returned, checks again with ERROR and admin alerts, the cap, disconnect, expired and other admins' sessions, audit entries without tokens. Contract US1. E2e `ads-us1-connection` | Connect the real ad account and page (section 4) |
| US2 Launch | ✅ | Shared targeting, budget, state and limit rules. Integration `ads-launch` (stateful Graph fake): drafts per goal with 1–5 versions, search and estimates with the minimum, the launch order and payloads (welcome message sequence, creatives, campaign, ad set with `destination_type: WHATSAPP`, ads), rollback and a clean retry, the status job (approved, rejected with the reason, edited and resubmitted, paused in Meta's tools), the ERROR connection, permissions. Contract US2. E2e `ads-us2-launch` | A first real ad through Meta's review |
| US3 Ad chats | ✅ | Integration `ads-chats`: the referral on the chat item, the start once per contact per ad per day, Other ads, the journey, the tag, the `ad.chat_started` event, the campaign flow before keyword flows and never over a running flow or a member's chat, the free window from the first business reply, the chats list with masked phones. Contract US3. E2e `ads-us3-ad-chats` (with `mock:inbound --referral-ad`) | A real chat from a real ad |
| US4 Results | ✅ | Integration `ads-results`: hourly rows per version and day plus the campaign's reach rows, conversations and leads from `actions`, the 28-day refresh, totals, days and versions with the platform's counts and costs, the CSV export with `data.export` and an audit entry, the list's spend and chats. Contract US4. E2e `ads-us4-results` (the first numbers are read 30 seconds after a campaign becomes active) | Compare a day with Meta Ads Manager |
| US5 Manage and cap | ✅ | Integration `ads-manage`: pause, resume and end at Meta, one version at a time, budget and end date on the ad set, duplicates, the cap on submit, resume and budget increases (409 with the amount left), the pause once a month at the cap with alerts, payment problems alerting admins and the maker. Contract US5. E2e `ads-us5-manage` | Set the real monthly cap |
| US6 Audiences | ✅ | Shared hashing rules. Integration `ads-audiences`: tag, filter and campaign group sources with opted-out and blocked contacts left out, `PHONE_SHA256` hashes, daily differences (adds, removals, deleted contacts), too small under 100, lookalikes, deletes refused while used, the terms, sync now. Contract US6. E2e `ads-us6-audiences` | Accept the custom audience terms on the real account |
| US7 Leads | ✅ | Integration `ads-leads`: the form at Meta with the page token and the consent checkbox, the page subscribed to `leadgen`, signed page webhooks through the 001 receiver, contacts with the tag, opt-in only from the ticked box (`LEAD_FORM`), the welcome template once and never to opted-out contacts, repeats once, the catch-up, no phone and invalid phone, the leads list and export, the `ad.lead_received` event without answers, a lead ad using the form. Contract US7. E2e `ads-us7-leads` (with `POST /mock/ads/lead`) | `leads_retrieval` approval and a real test lead |
| US8 Website and AI | ✅ | Integration `ads-website-ai`: a website ad with its counted link, the 302 with utm values, previews, robots and HEAD requests not counted, the rate limit, the ended page, visits in the results, AI texts within limits through the 004 service, counted against the monthly limit (429 when reached), never submitted. Contract US8. E2e `ads-us8-website-ai` (mock-meta's fake model) | Check the AI texts' quality on real offers |

## 3. Gaps found and fixed during implementation

1. **Token length in the e2e mock:** the mock's full-access token had 17 characters and the token
   rule needs 20; it is now `mock-ads-token-ok-full`.
2. **Template sync race in older e2e specs:** "Sync from Meta" reads every connected account one by
   one; with more accounts in the suite, an older account's template row could appear before the
   test's own account was synced, and the 001 broadcast spec timed out choosing its template. The
   four specs that sync templates now wait for the sync to finish.
3. **A filter on a column that does not exist:** the campaign service filtered lead forms on
   `deletedAt`, which lead forms do not have; Prisma's types did not catch it. Fixed before any
   test reached it.
4. **Money in messages:** `Intl` puts a non-breaking space between the currency code and the amount;
   messages now use a plain space so they read and compare cleanly.
5. **First numbers sooner:** Meta's numbers are read hourly; a campaign that becomes active now gets
   one read 30 seconds later, so results show without waiting for the next hour.

## 4. Before release

- [ ] The company's Meta app has `ads_management`, `ads_read`, `business_management`,
  `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `pages_manage_metadata`,
  `leads_retrieval` and `whatsapp_business_management` (App Review or advanced access where Meta asks)
- [ ] A system user with the ad account and the page, and a token that never expires, connected in
  *Ads → Ad account* with every check passing
- [ ] The page is linked to the company's WhatsApp numbers (Page settings → Linked accounts)
- [ ] The custom audience terms and the lead ads terms are accepted
- [ ] The ad account has a payment method; a monthly spending cap is set
- [ ] The app is subscribed to the page's `leadgen` field (making the first lead form does this) and
  page webhooks reach `/api/webhooks/meta` on the production address
- [ ] `PUBLIC_LINK_BASE_URL` is set for website ad links
- [ ] A small real chat ad: Meta's review, a real chat with the ad card, the flow and the tag, and the
  free window shown after the first reply
- [ ] A real lead ad: a real lead with consent becomes an opted-in contact and gets the welcome template
- [ ] The *(verify)* fields in contracts/meta-ads-graph.md are checked against Meta's reference on the
  pinned Graph version (special ad categories, budget sharing, the welcome message sequence in the
  creative, the review feedback field, the lead form disclaimer)
- [ ] The product owner's sign-off
