# Release Checklist: Chatbot Flow Builder

**Feature**: `003-chatbot-flow-builder` | **Task**: T089 | **Last run**: 2026-11-20
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests)
- GitHub Actions ubuntu-latest (draft PR #4): integration, contract, e2e, Docker images, the
  dependency audit, alert rules and the secret scan. Docker was not available on the development
  machine, so every check that needs Postgres, Redis or MinIO ran in CI.

**Status**: Ready for review. All automated gates pass in CI, and every quickstart row is covered by
integration tests and a Playwright e2e spec. Still open: the SC-001 performance run on staging
hardware, an API step against a real company endpoint, and the product owner's sign-off (section 4).

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web, shared and `tools/perf` |
| `npm test` (unit) | ✅ PASS | api 320/320 (35 files), shared 114/114 (11 files), web 3/3 (2026-11-20, local) |
| `npm run test:integration` | ✅ PASS | 52 files in CI, 8 of them flow suites (`flows-*.int-spec.ts`), plus flow cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `flows.contract-spec.ts`: cases for US1, US3, US5, US7, US8 and US9 against `contracts/flows-api.openapi.yaml` |
| RBAC from all three contracts (T086) | ✅ PASS | `rbac.int-spec.ts` now reads the 001, 002 and 003 contracts and checks every `x-permission` for each role; it passed with no code change |
| Audit coverage (T085) | ✅ PASS | the 9 flow actions of research R15, with secrets audited by name only (`audit-coverage.spec.ts`, `flows-api-step.int-spec.ts`) |
| Log redaction (T084) | ✅ PASS | flow answers, mapped API reply fields and stored secret values (`logging-redaction.spec.ts`) |
| Retention and erasure (T083) | ✅ PASS | sessions that ended over 12 months ago go with their step records (`retention.int-spec.ts`); deleting a contact clears its session answers and the contact link (`contact-deletion.int-spec.ts`) |
| Metrics and alert (T082) | ✅ PASS | `wbm_flow_sessions_total`, `wbm_flow_steps_total`, `wbm_flow_api_calls_total` and `wbm_flow_api_duration_seconds`; `promtool check rules` passes with 8 rules, including the new `WbmFlowApiFailing` (`alerts.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step: no high or critical advisories |
| gitleaks (history) | ✅ PASS | CI `secret-scan` |
| Docker images | ✅ PASS | CI `docker-images`: api, migration and web images build, and the 002 live event smoke test still passes |
| Playwright e2e | ✅ PASS | CI `e2e-smoke`: 24 specs, including `flows-us1-keyword-buttons` … `flows-us9-starters`. Every story commit was green on all four jobs (US1 c78db58 … US9 c3ecda2), and so was the polish commit 2ce6989 |
| Performance SC-001 | 🟡 NOT RUN | `npm run perf:flows` is ready (T087): it publishes a one-step flow, sends 5 rounds of 20 customer messages at once and times each reply on the live event stream (limit 3 s at p95). It needs the api, the worker and the Docker services; run it on staging hardware |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Keyword flow with buttons | ✅ | unit `run-buttons`, shared `validate` and `triggers`; `flows-build-publish` (draft conflicts, refused broken drafts, keyword start, button tap, live chat label, published version kept until the next publish); contract US1; e2e `flows-us1-keyword-buttons` | — |
| US2 Questions and attributes | ✅ | unit `run-questions`, shared `answers`; `flows-questions` ("Book a visit" with two wrong dates, answers saved with journey entries, timeout branch, an older timer ignored, 24-hour expiry); e2e `flows-us2-questions` | — |
| US3 Hand-over and live chat | ✅ | `flows-live-chat` (hand-over with the 002 alert and note; take, reply and template stop the flow; STOP ends it with nothing sent; blocking; no welcome message; **Start a flow** refused after 24 hours); contract US3; e2e `flows-us3-live-chat` | — |
| US4 Logic | ✅ | unit `run-logic`, shared `conditions`; `flows-logic` (tags and attributes with journey entries, working hours, delay timer, jump, loops of jumps refused); e2e `flows-us4-logic` | — |
| US5 API step | ✅ | unit `api-client` (blocked addresses, IPv4-mapped IPv6, no redirects, size and time limits); `flows-api-step` (encrypted secrets, mapping, failed branch on timeout and 500, test request); contract US5; e2e `flows-us5-api-step` | Call one real company endpoint from staging |
| US6 Triggers | ✅ | unit `pattern-match`, shared `triggers`; `flows-triggers` (template quick-reply button, pattern answer, unsafe patterns refused, first-message tag, exact before contains, can-interrupt); e2e `flows-us6-triggers` | — |
| US7 Test numbers and versions | ✅ | `flows-testing` (draft for test numbers, never-published flows, sessions finish on their version, 20 autosaves, restore); contract US7; e2e `flows-us7-testing` | — |
| US8 Analytics | ✅ | `flows-analytics` (totals and steps for 7 days without test runs; today, 30 days and custom ranges in the company time zone; dropped-contacts CSV); contract US8; e2e `flows-us8-analytics` (badges and totals equal the API) | — |
| US9 Starters | ✅ | shared `starters` (every starter parses, passes the publish checks and has our own text); contract US9; e2e `flows-us9-starters` (Lead capture with the missing attributes created, published and run) | — |

## 3. Gaps found and fixed during implementation

1. **Every IPv4 address was blocked:** Node's `BlockList` matched IPv4 addresses against the
   IPv4-mapped IPv6 rule `::ffff:0:0/96`. IPv4 and IPv6 now use separate lists, and an
   IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
2. **Hand-over rolled back:** the 002 database check allowed notes from members only, so the
   automatic hand-over note failed. Migration `20261126000000_flow_notes` also allows automatic notes.
3. **Flaky pattern timeout:** a 25 ms limit timed out under CI load. Patterns now run in one shared
   compiled script with a 50 ms limit and one retry at 100 ms (research R3 updated).
4. **Queue job ids:** BullMQ refuses `:` in custom job ids, so timer and API job ids use `-`.
5. **First-message rules:** their trigger candidates lacked the "can interrupt" flag; it is now
   always false for them.
6. **e2e collisions:** a role locator matched two buttons, and an attribute name clashed with a 001
   e2e label. New specs use exact locators and their own names.
7. **Crash damage on the development machine:** a crash zeroed git refs and one source file. Both
   were restored from the reflog and the last commit; every commit is now preceded by a scan for
   NUL bytes.

### Follow-ups (not blocking)

- Run `npm run perf:flows` on staging and record the numbers here.
- The test panel does not show the trail of the last test session yet (T072); test runs show in
  live chat, marked "test".
- QR-code and click-to-WhatsApp-ad triggers and an AI flow generator are planned for later features
  (see the AiSensy inventory roadmap).

## 4. Before release

- [ ] Apply the 003 migrations with the migration image before starting the new api and worker.
- [ ] Allow outbound HTTPS from the worker to the endpoints that API steps call. Private and
      reserved addresses are refused by design.
- [ ] Reload Prometheus so it picks up the `WbmFlowApiFailing` rule in `ops/alerts.yml`.
- [ ] Run the SC-001 performance check on staging and record the result in section 1.
- [ ] Product owner sign-off after a walk-through of quickstart §3.
