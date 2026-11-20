# Release Checklist: Live Chat (Shared Team Inbox)

**Feature**: `002-team-inbox` | **Task**: T104 | **Last run**: 2026-11-20
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests)
- GitHub Actions ubuntu-latest (draft PR #2): integration, contract, e2e, Docker images and the
  live event smoke test. Docker was not available on the development machine, so every check that
  needs Postgres, Redis or MinIO ran in CI.

**Status**: Ready for review. All automated gates pass in CI, and every quickstart row is covered by
an integration test and a Playwright e2e spec. Still open: the SC-006/SC-001 performance run on
staging hardware, a real browser push test over HTTPS, and the product owner's sign-off (section 4).

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over apps, packages and tools, run per changed area before each commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web, shared and `tools/perf` |
| `npm test` (unit) | ✅ PASS | api 253/253 (28 files), shared 47/47 (5 files), web 3/3 (2026-11-20, local) |
| `npm run test:integration` | ✅ PASS | 44 files in CI, 12 of them live chat suites (`inbox-*.int-spec.ts`), plus live chat cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `inbox.contract-spec.ts`: one case per story (US1–US8) against `contracts/inbox-api.openapi.yaml` |
| RBAC from both contracts (T097) | ✅ PASS | `rbac.int-spec.ts` checks every `x-permission` of the 001 and 002 contracts for each role; a static check matched all 41 live chat operations with the controllers |
| Audit coverage (T098) | ✅ PASS | 11 new actions recorded with no message content (`audit-coverage.spec.ts`, `inbox-audit.int-spec.ts`) |
| Log redaction (T100) | ✅ PASS | captions, notes, previews, automatic message content and push subscriptions (`logging-redaction.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | 0 vulnerabilities after overriding `effect` to 3.22.5 (GHSA-7589-6fvf-x4pw via `@prisma/config`) |
| `promtool check rules ops/alerts.yml` | ✅ PASS | 7 rules, including the new `WbmInboundMediaFailing` |
| gitleaks (history) | ✅ PASS | `.gitleaks.toml` keeps the default rules and allows only the two public example Web Push keys used by tests |
| Docker images + live event smoke (T102) | ✅ PASS | CI `docker-images` (commit 2210817): api, migration and web images build; with the api in production mode and the standalone web server, a sign-in through the web `/api` proxy gets `: ping` on `/api/inbox/events` within 20 s (step took 37 s in total) |
| Playwright e2e | ✅ PASS | CI `e2e-smoke`: 15 specs, the 7 of feature 001 and `inbox-us1-live-chat` … `inbox-us8-team-view` (green through commit fe02624; re-run on each push) |
| Performance SC-006 / SC-001 | 🟡 NOT RUN | `npm run perf:inbox-seed` and `npm run perf:inbox` are ready (T101). They need the api, the worker and Docker services; run them on staging hardware |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Live chat | ✅ | `inbox-realtime`, `inbox-receive-reply`, `inbox-send-priority`, `inbox-visibility` integration tests; contract US1; e2e `inbox-us1-live-chat` (live update, take, reply ticks, close, image) | — |
| US2 Window and History | ✅ | `inbox-window-history` integration test; contract US2; e2e `inbox-us2-window-history` (locked reply box, template from Past chats, chat live again) | — |
| US3 Routing | ✅ | `inbox-routing` integration test (keyword, transfer, auto-close, agent rules); contract US3; e2e `inbox-us3-routing` | — |
| US4 Saved replies and media | ✅ | `inbox-canned-media` integration test; contract US4; e2e `inbox-us4-saved-replies` (variables filled, media library, size limits) | — |
| US5 Profile and blocking | ✅ | `inbox-profile-block` integration test; contract US5; e2e `inbox-us5-profile` (source, journey entry, block hides the chat, unblock) | — |
| US6 Automatic messages | ✅ | unit `working-hours`, `auto-replies`; `inbox-auto-replies` integration test (once per opening, once per 12 h, never for keywords, blocked or opted-out); e2e `inbox-us6-auto-replies` | — |
| US7 Alerts | ✅ | `inbox-notifications` integration test with a fake push sender (presence, paused devices, 410 cleanup, masking); contract US7; e2e `inbox-us7-alerts` (sound setting, device list) | Real push delivery needs VAPID keys and HTTPS; headless CI browsers have no push service |
| US8 Notes and team view | ✅ | `inbox-notes-metrics` integration test (mentions, openings, medians checked by hand for today/7d/30d, 403 for agents); contract US8; e2e `inbox-us8-team-view` (mention alert, 7-day view equals the API) | — |

## 3. Gaps found and fixed during implementation

1. **Chat view crash in Chrome:** an effect returned the Promise of `scrollIntoView`, and React
   called it as a cleanup ("destroy is not a function"). All effects now use block bodies.
2. **Read ticks arrived late:** a number's send worker started on a 30 s sync. Connecting a number
   or queueing a chat reply now requests an immediate sync.
3. **Keyword not recognised:** the worker cached live chat settings for 15 s, so a new "talk to a
   person" keyword was missed. Settings are now read fresh for every webhook.
4. **Flaky integration test:** a static message id in a nock reply broke the unique
   `wa_message_id`; each send now gets its own interceptor.
5. **Secret scan false positive:** the public example Web Push keys in tests were flagged; a narrow
   allowlist was added.
6. **New high advisory in a dependency:** `effect` (used only by Prisma's config loader) was
   overridden to the fixed 3.22.5; `prisma validate` still passes.
7. **Contract validation:** `allOf` with `additionalProperties: false` rejected valid responses;
   the schemas were written out explicitly.
8. **Advisory locks:** Prisma could not read the `void` result of `pg_advisory_xact_lock` through
   `$queryRaw`; `$executeRaw` is used instead.

### Follow-ups (not blocking)

- Run the SC-006/SC-001 performance scripts on staging and record the numbers here.
- Test real browser push on the company domain (HTTPS) in Chrome, Edge and Firefox.
- First-message tags are set by hand; automatic phrase matching is planned for feature 003.

## 4. Before release

- [ ] Meta: the app's webhook is subscribed to the `messages` field (it carries customer messages
      as well as statuses), and each number's token can download media.
- [ ] Production `.env`: the three `WEB_PUSH_*` variables (or none), `DATABASE_POOL_MAX` sized for
      the team.
- [ ] Reverse proxy: no buffering and long timeouts for `/api/inbox/events`.
- [ ] Apply the 002 migrations with the migration image before starting the new api and worker.
- [ ] Turn off welcome and off-hours messages before running the performance seed on staging.
- [ ] Product owner sign-off after a walk-through of quickstart §3.
