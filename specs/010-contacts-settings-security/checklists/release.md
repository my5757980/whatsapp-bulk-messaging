# Release Checklist: Contacts, Settings and Security

**Feature**: `010-contacts-settings-security` | **Task**: T089 | **Last run**: 2026-11-28
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (PR #12): integration, contract, e2e, Docker images, the dependency
  audit, alert rules, the secret scan and the segment perf check. Meta traffic comes from mock-meta
  (`src/business-profile.ts` for the profile and name status) and the nock `FakeBusinessGraph`. No
  real WhatsApp account, phone, template approval or authenticator app was used.

**Status**: PENDING the last CI run (batch 3, 8322b20).

Still open before release (section 4):
- 2FA required for the admins, and the operator reset in the runbook
- the real business profile changed once and seen on a phone; picture limits confirmed
- the birthday and keyword reply templates approved on the real account
- the guides and the blue tick checklist re-checked against Meta's pages (`checkedAt`)
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run lint:contracts` | ✅ PASS | redocly over every contract, now with `contacts-settings-api.openapi.yaml` |
| `npm run typecheck` | ✅ PASS | api (src and tests), web (with e2e), shared and mock-meta |
| `npm test` (unit) | ✅ PASS | api 663/663 (70 files, local 2026-11-28). New: the segment SQL builder, the contacts export line, `{global:key}` in replies and flows, the global variable source, keyword replies and the opt-out confirmation pre-send rule, due conditions (parity with the shared `dueOn` over three years), the automation tick rules, RFC 6238 and RFC 4226 vectors, recovery codes, image sizes, the two new alerts |
| `npm run test:integration` | ✅ PASS (batches 1–2) | 010 suites: `segments`, `campaign-segment-audience`, `drip-segment-enrol`, `bulk-tags` (12,000 contacts), `auto-tags`, `lead-source`, `contacts-export`, `global-attributes`, `keyword-replies`, `date-automations`, `two-factor`, `business-profile`, plus 010 cases in `rbac`, `retention` and `contact-deletion`; the 002 lead source expectations were updated |
| `npm run test:contract` | ✅ PASS (batches 1–2) | `contacts-settings.contract-spec.ts` (US1–US7); the 001 login contract answers `{ next }` and the 005 enrolment takes a segment |
| RBAC from all ten contracts (T086) | PENDING (batch 3) | `rbac.int-spec.ts` reads the 001–010 contracts; self-service 2FA and the sign-in steps have no `x-permission` |
| Audit coverage (T085) | ✅ PASS (local unit) | every 010 action is recorded; the pending list is empty |
| Retention and erasure (T084) | PENDING (batch 3) | bulk actions after 90 days; occurrences after 12 months (their messages go with the 001 step for messages without a campaign); erasure deletes occurrences and clears automation messages; exports leave deleted contacts out |
| Metrics and alerts (T083) | PENDING (batch 3) | `wbm_segment_query_seconds`, `wbm_bulk_actions_total{kind,result}`, `wbm_contacts_exported_total`, `wbm_keyword_replies_total{kind,result}`, `wbm_date_automation_messages_total{result}`, `wbm_date_automation_behind`, `wbm_login_second_step_total{result}`; `WbmDateAutomationBehind` and `WbmSecondStepFailures` with cases in `alerts.spec.ts` |
| Segment perf (T087, SC-001) | PENDING (batch 3) | `segments-perf.int-spec.ts` in `build-test` seeds 200,000 contacts and counts a 10-rule segment; the timing is a CI notice annotation |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` |
| gitleaks (history) | ✅ PASS (65fde42) | the made-up 2FA test passwords are allowlisted by exact line |
| Docker images | ✅ PASS | CI `docker-images` |
| Playwright e2e | PENDING (batch 3) | 65fde42: 77 of 79 (the US6 alert locator and the US4 STOP filter, fixed in 8322b20) |

CI per batch (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Batch | Commits | Result |
|---|---|---|
| Setup, foundation, US1–US2 (MVP) | b2ce366 | a circular import hid the segment builder from Nest, and the 002 lead source expectations; fixed in 0f0c53b |
| MVP fixes, US3 | 0f0c53b, 57d6c9c | random phones collided in the shared database, then a 5,000-contact tag transaction timed out; fixed in 57d6c9c and 4a84a6a |
| US4 | 4a84a6a | build-test green; e2e: the bulk dialog's Close button, the keyword STOP filter, the payments retarget race; fixed in 65fde42 |
| US5–US6 | 92e7918 | build-test green; secret scan (test passwords) fixed in 65fde42; e2e: the 2FA alert locator and the growth retarget race, fixed in 8322b20 |
| Fixes | 65fde42 | build-test, secret scan and images green; e2e 77 of 79 |
| US7–US8, polish | 666c47d, 8322b20 | PENDING |

## 2. Quickstart rows (§3)

| Row | Covered by | Result |
|---|---|---|
| US1 Segments | `segments`, `campaign-segment-audience`, `drip-segment-enrol`, contract, `contacts-us1-segments` | ✅ |
| US2 Bulk tags, automatic tags, lead source, export | `bulk-tags`, `auto-tags`, `lead-source`, `contacts-export`, contract, `contacts-us2-tags-export` | ✅ |
| US3 Global attributes | `global-attributes`, unit render and resolver cases, contract, `settings-us3-global-attributes` | ✅ |
| US4 Keyword replies | `keyword-replies`, contract, `settings-us4-keywords` | integration ✅, e2e PENDING |
| US5 Date automations | `date-automations` (fake clock), due-query unit, contract, `automations-us5-dates` | ✅ |
| US6 2FA | `two-factor`, TOTP unit, contract, `security-us6-2fa` | integration ✅, e2e PENDING |
| US7 Business profile and checklist | `business-profile`, contract, `numbers-us7-profile` | PENDING |
| US8 Guides | `numbers-us8-guides` | PENDING |

## 3. Notes on how the tasks were built

1. **Keyword replies (T053)** are sent from the live chat inbound handler, right after the 001
   consent handler, because a text reply must show in the chat and the chat exists only then. A
   `$keywordReply` marker lets a utility opt-out confirmation pass the pre-send consent rule.
2. **Segment perf (T004, T087)** is an opt-in integration spec (`segments-perf.int-spec.ts`,
   `npm run perf:segments -w @wbm/api`) instead of a `tools/perf` script, so CI seeds 200,000 rows in
   the build-test database and reports the timing without a running stack.
3. **Pages (T080, T082)** live at `/numbers/{id}/profile` and `/numbers/guides/{guide}`, linked from
   Settings → WhatsApp numbers; removing a number now asks for the number to be typed.
4. **Due dates (T059)** compare strings instead of casting stored values, so one bad attribute value
   can never stop a run; the unit test checks them against the shared `dueOn` for every day of three
   years.

## 4. Before going live

| Item | Owner | Done |
|---|---|---|
| Require 2FA for every admin; keep the operator reset (`npm run auth:reset-2fa -w @wbm/api -- --email <email>`) in the runbook | Admin | ☐ |
| Change the real business profile once and check it on a phone; confirm the picture limits (square, 192 px, 5 MB) on the real account | Admin | ☐ |
| Get the birthday template and the keyword reply template approved (utility for keyword replies) | Admin | ☐ |
| Re-check the guides and the blue tick checklist against Meta's pages and update `checkedAt` | Product | ☐ |
| Product owner's sign-off | Product | ☐ |
