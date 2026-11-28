# Release Checklist: More Template Types, Campaign Reports and the Website Chat Button

**Feature**: `009-templates-growth` | **Task**: T096 | **Last run**: 2026-11-28
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (PR #11): integration, contract, e2e, Docker images, the dependency
  audit, alert rules and the secret scan. Meta traffic in CI comes from mock-meta (`src/templates.ts`
  for template kinds, held delivery, the mock shop page and media files) and the nock
  `FakeTemplatesGraph`. No real WhatsApp account, template approval, phone or company website was used.

**Status**: CI for the fixes after 69e5d4b is running. US1–US7 passed in CI (b0244f6 for the MVP
batch; 700991c for US4–US7, where the only failure was the US1 e2e that found the settings page race
in section 3, item 8).

Still open before release (section 4):
- an authentication, a carousel and an offer template approved on the real account
- a real code received in under 10 seconds, and the offer end time checked on a phone
- one-tap (optional): the company's Android app does Meta's handshake
- the snippet on the company website, with the link host allowed by its Content Security Policy
- the help `checkedAt` dates re-checked against Meta's pages
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run lint:contracts` | ✅ PASS | redocly over every contract, now with `templates-growth-api.openapi.yaml` and `public-otp-v1.openapi.yaml` |
| `npm run typecheck` | ✅ PASS | api (src and tests, and `tsconfig.widget.json` for the browser script), web (with e2e), shared and mock-meta |
| `npm test` (unit) | ✅ PASS | api 596/596 (61 files), shared 403/403 (55 files), web 8/8 (2 files) (2026-11-28, local). New: template kinds, TTL ranges, launch checks, samples, help and guidelines, report ranges and page rules in shared; the payload builder for cards and offers, send expiry, the message parser's card replies, the widget script (jsdom) and its bundle, the code alerts |
| `npm run test:integration` | ⏳ 69e5d4b | 009 suites: `templates-auth`, `otp-api`, `otp-no-code-leak`, `templates-carousel`, `templates-offer`, `templates-ttl`, `campaign-media-urls`, `campaign-replies-duplicates`, `reports-growth`, `template-samples`, `help-reasons`, `chat-widgets`, `whatsapp-link-tool`, plus 009 cases in `rbac`, `retention`, `contact-deletion`, `campaign-send`, `templates-create` and `reports`. All but the last three suites of the list and the polish cases passed at 700991c |
| `npm run test:contract` | ⏳ 69e5d4b | `templates-growth.contract-spec.ts` (samples, code settings, media check, reports, website buttons, the generator, the public config) and `otp.contract-spec.ts`; the 001 `us3` and `us5` contracts carry the new template and campaign fields |
| RBAC from all nine contracts (T094) | ⏳ 69e5d4b | `rbac.int-spec.ts` now reads the 001–009 contracts; the website button script, config and image are public and skipped |
| Audit coverage (T093) | ✅ PASS | every 009 action is recorded (`otp_settings.changed`, `chat_widget.*`, `template_sample.copied`, `data.exported` with the report type); the pending list is empty |
| Retention and erasure (T091) | ⏳ 69e5d4b | `retention.int-spec.ts`: code messages after 30 days. `contact-deletion.int-spec.ts`: code messages sent to the phone lose it, every-row messages are cleared like other campaign messages |
| No code leak (T092, SC-002) | ⏳ 69e5d4b | `otp-no-code-leak.int-spec.ts`: a success, a failure, a retry (a 5xx, then success) and an idempotent repeat; messages, events, idempotency records, audit entries, outbound events, captured logs and the queue's Redis data hold no code, and a real worker leaves no job |
| Metrics and alerts (T090) | ✅ PASS | `wbm_otp_sends_total{result}`, `wbm_otp_send_seconds`, `wbm_messages_expired_total{reason}`, `wbm_widget_opens_total`, `wbm_reports_exported_total{type}` and `wbm_unknown_error_codes_total{code}`; `WbmOtpFailing` and `WbmOtpSlow` with cases in `alerts.spec.ts` (`promtool check rules` in CI) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step (700991c) |
| gitleaks (history) | ✅ PASS | CI `secret-scan` (700991c) |
| Docker images | ✅ PASS | CI `docker-images` (700991c): the api (with the bundled widget script), migration and web images build |
| Playwright e2e | ⏳ 69e5d4b | CI `e2e-smoke`: `templates-us1-codes` … `templates-us7-help`, `reports-us5` and `widget-us8` |

CI per batch (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Batch | Commits | Result |
|---|---|---|
| Setup, foundation, US1–US3 (MVP) | 9d65df2, opening PR #11 | lint, two 001 tests and the e2e Meta app id, fixed in b50c4fe, e5738ab and b0244f6; green at b0244f6 (section 3, items 1–3) |
| US4–US5 | a68923e | fake Graph ids, the public API's bad body status and the 001 export columns, fixed in 8a7462a; test phones, fixed in 05032a0 (section 3, items 4–6) |
| US6–US7, US8 api | 37d4b48 … 61f5f7f | the sample copy, fixed in 700991c (section 3, item 7) |
| US4–US7 confirmed | 700991c | build-test green; e2e 71 of 72, the US1 settings race (section 3, item 8) |
| US8 web and tests, polish, docs | 69e5d4b | the website button response schema and a settings regression test built on a wrong cause (section 3, items 8 and 10) |
| Fixes | next push | running |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Codes | ✅ | Shared kind rules. Integration `templates-auth` (Meta's fixed wording, copy-code and one-tap, refused content) and `otp-api` (202 at once, ahead of campaigns, the scope, blocked and opted-out recipients, the per-phone limit with Retry-After, idempotency, statuses and `otp.status` without the code, a stopped number, one settings row). Contract `otp`. E2e `templates-us1-codes` | Approve the template on the real account; a real code in under 10 seconds |
| US2 Carousel | ✅ | Unit card payloads. Integration `templates-carousel` (card rules, card media uploaded once per number, card replies in live chat and as flow triggers, tracked card links). E2e `templates-us2-carousel` | Approve a carousel on the real account |
| US3 Offer | ✅ | Unit offer payloads and send expiry. Integration `templates-offer` (end time checks, codes from one value, a column or an attribute, missing codes skipped, ended offers not sent). E2e `templates-us3-offer` | Check the end time on a phone (`expiration_time_ms`, research R7) |
| US4 Time-to-live and media by address | ✅ | Unit send expiry. Integration `templates-ttl` (Meta's TTL for codes and utility, ours for marketing, the sweep and a late webhook replacing the mark, retry rounds leaving them out) and `campaign-media-urls` (HEAD and ranged GET, redirects, the sample above 1,000, at most 50 problems, the public API refusing `http`). E2e `templates-us4-ttl-media` (held delivery, short sweep timings) | — |
| US5 Replies, every row and reports | ✅ | Shared report ranges. Integration `campaign-replies-duplicates` (replied and reply rate, every row with copy numbers, retarget counting people once) and `reports-growth` (overview, team and consent reports, CSV streams with masking and audit, ranges refused). E2e `reports-us5` | — |
| US6 Samples | ✅ | Shared sample rules (70 samples, 10 industries, every purpose and type, 10 Arabic). Integration `template-samples` (filters, copy to a draft, a taken name). E2e `templates-us6-samples` | — |
| US7 Help | ✅ | Shared guideline and meaning rules (every handled code has an entry). Integration `help-reasons` (meanings and actions on reasons, unknown codes counted). E2e `templates-us7-help` | Re-check the `checkedAt` dates before release |
| US8 Website button and generator | ⏳ 69e5d4b | Shared page rules. Unit script (jsdom) and bundle (under 30 KB, no cookies or storage). Integration `chat-widgets` (links per rule hidden from chat links, public config with CORS, ETag and no cookies, pause, a disconnected number hidden and its notice once, opens per page without previews, chats per rule with the rule's label, the rate limit, audit) and `whatsapp-link-tool`. E2e `widget-us8` (the designer and preview, the mock shop page, Start chat through the chat link, the inbound message counted for the rule, no button on checkout, the generator and the chat link form filled in) | Paste the snippet on the company site with its CSP allowing the link host; check on desktop and phone |

## 3. Gaps found and fixed during implementation

1. **Lint:** a computed property access after a newline in the fake Graph read as a call; it uses a
   named scope.
2. **001 tests:** campaign totals gained `expired: 0`, and a copied template keeps its kind and
   time-to-live.
3. **Card sample uploads in e2e:** Meta's resumable upload needs the app id; the e2e environment sets
   `META_APP_ID`.
4. **Fake Graph ids across files:** two test files made the same wamid in the shared database; each
   fake has its own tag.
5. **The public API's bad media address:** it answers 400 like other bad bodies, not 422.
6. **Test phones in the shared database:** random phones repeated across files and broke unique
   checks; they spread over the UAE mobile prefixes and never repeat in a file.
7. **Sample copies:** Prisma refuses `undefined` inside JSON arrays, so a sample with empty media
   handles failed to save; the copy drops them.
8. **The code settings page race:** the page filled its form from the saved settings whenever they
   arrived, so a slow answer could undo a template already chosen, and the save then stored none
   (found by the US1 e2e, where the settings call got slower as the shared database grew). The form
   takes the saved settings once and stays locked until they arrive. The table already holds one row
   (a unique index); a first-use race now reads the row the other request made instead of failing.
9. **The website button in browser tests:** a closed shadow root cannot be reached by Playwright or
   accessibility checkers; it is open (the site's styles still do not reach it), and the contract
   says so.
10. **The website button response schema:** it extended the input schema through `allOf`, and the
    input allows no other properties, so every response field beyond the input was refused. The
    response fields are listed in full, with the look as its own schema.

## 4. Before release (owner: the company's admin)

- [ ] **Meta:** an authentication, a carousel and a limited-time offer template approved on the real
      account; a real code sent and received in under 10 seconds; the offer's end time shown
      correctly on a phone
- [ ] **One-tap (optional):** the company's Android app does Meta's handshake, and its package name
      and signature hash are in the template
- [ ] **Website:** the web team pastes the snippet, allows the link host in the site's Content
      Security Policy (`script-src`, `connect-src`, `img-src`) and checks the button on desktop and
      phone
- [ ] **Help:** the error meanings and guidelines re-checked against Meta's pages (their `checkedAt`
      dates)
- [ ] **Sign-off:** the product owner
