# Release Checklist: Campaign Growth

**Feature**: `005-campaign-growth` | **Task**: T067 | **Last run**: 2026-11-24
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (draft PR #6): integration, contract, e2e, Docker images, the
  dependency audit, alert rules and the secret scan. Clicks, replies and Meta statuses in CI come
  from mock-meta and test requests, never from real phones.

**Status**: Waiting for the last browser test run (a10eabe). Every other automated gate passes in
CI, and every quickstart row is covered by integration tests and a Playwright e2e spec. Still open
before release (section 4):
- the public link address on the company's domain
- Meta approval of a tracked link template
- confirming the reply window and drip limits
- the SC-005 run on staging
- the product owner's sign-off

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web (with e2e), shared, mock-meta and `tools/perf` |
| `npm test` (unit) | ✅ PASS | api 444/444 (48 files), shared 200/200 (22 files), web 8/8 (2 files) (2026-11-24, local) |
| `npm run test:integration` | ✅ PASS | 69 files in CI (2c3356e), 6 of them growth suites (`growth-clicks`, `growth-retarget`, `growth-retries`, `growth-drips`, `growth-drip-events`, `growth-drip-results`), plus growth cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `growth.contract-spec.ts`: cases for US1–US6 against `contracts/growth-api.openapi.yaml`; the 001 and 002 contracts list the new retarget groups and chat fields |
| RBAC from all five contracts (T064) | ✅ PASS | `rbac.int-spec.ts` now reads the 001–005 contracts. The 31 growth operations match the code with no permission change: 12 `campaigns.view`, 8 `campaigns.manage`, 8 `campaigns.launch`, 2 `data.export` and 1 `templates.view`. The public `/l/{code}` route is skipped |
| Audit coverage (T063) | ✅ PASS | all 12 growth actions are recorded; the pending list is empty (`audit-coverage.spec.ts`) |
| Log redaction (T062) | ✅ PASS | link codes are hidden in logged paths (`/l/[REDACTED]`), and link code and destination fields are redacted. Meta error codes stay readable (`logging-redaction.spec.ts`) |
| Retention and erasure (T061) | ✅ PASS | `retention.int-spec.ts`: clicks are purged after 12 months, enrolments 12 months after they end, and starting events left over a day; tracked links and their clicks go with purged messages. `contact-deletion.int-spec.ts`: deleting a contact ends their drips and clears them from clicks, enrolments and tracked links, and drops pending starting events |
| Metrics and alert (T060) | ✅ PASS | the metrics are `wbm_link_clicks_total`, `wbm_link_redirect_seconds`, `wbm_campaign_retry_messages_total`, `wbm_drip_steps_total`, `wbm_drip_enrolments_total` and `wbm_drip_due_lag_seconds`. `promtool check rules` passes with 10 rules, including `WbmDripLagging` (`alerts.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step |
| gitleaks (history) | ✅ PASS | CI `secret-scan` (after the narrow allowlist in section 3) |
| Docker images | ✅ PASS | CI `docker-images`: the api, migration and web images build, and the 002 live event smoke test still passes |
| Playwright e2e | 🟡 PENDING | CI `e2e-smoke`: 39 specs, including `growth-us1-clicks` … `growth-us6-drip-results`. US1–US5 passed on all four jobs. The US6 spec failed once on a race (section 3); the fix (a10eabe) is running |
| Performance SC-005 | 🟡 NOT RUN | `npm run perf:drips` is ready (T065). It imports 10,000 opted-in contacts with their own tag, builds a one-step drip with no wait and enrols them all at once, so every step falls due at the same moment. It then reads each contact's time from joining to being queued (limit 5 minutes at p95). It needs the api, the worker and the Docker services; run it on staging hardware |

CI per story (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Story | First push | Green at |
|---|---|---|
| Foundation, US1 | df213aa (failures: the e2e picked the wrong template category; the secret scan flagged a test helper line) | c4e1807 (e2e fixed in ac991f8, secret scan in def6bf2) |
| US2 | 12ec7d6 (failure: the 001 contract's retarget groups) | c4e1807 |
| US3 | c4e1807 | c4e1807 |
| US4 | 7731922 (with the tests-first commit b9a364b) | 7731922 |
| US5 | 7b001fb | 7b001fb |
| US6 | 2087234 (failure: the e2e read the template list before its account's sync) | pending: a10eabe |
| Polish | 2c3356e (build-test, docker-images and secret-scan passed) | pending: a10eabe |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Clicks | ✅ | Unit `link-redirect`: redirect, previews, robots and HEAD requests, unknown codes, the rate limit and metrics. Shared `links` and `bots`. Integration `growth-clicks`: the template address, variables that can be tracked, a code per recipient at launch, real clicks only, clickers and click rate with masked phones for agents, journey and chat timeline, destination changes audited. Contract US1. E2e `growth-us1-clicks` | Open one real link from a phone on mobile data on staging |
| US2 Retarget | ✅ | Integration `growth-retarget`: group sizes first, the 001 groups unchanged, campaigns with purged messages refused, permissions. Contract US2. E2e `growth-us2-retarget`; `us5-reports` uses the new dialog | — |
| US3 Retries | ✅ | Unit `retryable`; shared `retries`. Integration `growth-retries`: plans of up to 3 rounds within 24 hours; only failures that may pass are re-sent, never twice; rounds held while paused; one or all rounds cancelled, and rounds cancelled with the campaign; skipped past 24 hours or with a paused template. Contract US3. E2e `growth-us3-retries` | — |
| US4 Drip | ✅ | Shared `quiet-hours` and `drips`. Integration `growth-drips`: building, enrolling by hand, steps sent when due and after quiet hours; leaving at once on a reply, opt-out, block, deletion or removal; marketing steps without an opt-in skipped; pausing itself with an alert; edits, pause, archive and rejoining; the 21st active drip refused; drip messages in live chat and the journey. Contract US4. E2e `growth-us4-drips` | — |
| US5 Starting events | ✅ | Integration `growth-drip-events`: tags from members, bulk actions and imports; opt-ins; new contacts from imports and the API; campaign clicks; nothing for draft or paused drips; stop tags, drip clicks and rolled-back changes. E2e `growth-us5-starting-events` | — |
| US6 Results | 🟡 | Integration `growth-drip-results`: counts equal the records, the contacts behind each count with masked phones, and the export (`data.export`, audited). Contract US6. E2e `growth-us6-drip-results` is waiting for the fixed run | — |

## 3. Gaps found and fixed during implementation

1. **Queue for retry rounds:** the campaign dispatch queue has a single processor, so retry rounds
   became `campaign-retry-round` jobs on the `maintenance` queue. Research, plan, tasks and
   CLAUDE.md say so.
2. **Public link route:** the `api` prefix is set in `app.setup.ts`, not `main.ts`; `/l/:code` is
   excluded there, so links stay outside `/api`.
3. **Secret scan false positive:** gitleaks' generic-api-key rule matched a test helper line naming
   the `005-campaign-growth` folder. A narrow allowlist covers that exact line.
4. **Old contract, new values:** the 001 dashboard contract listed only the 001 retarget groups, so
   its contract test failed once the API returned the new ones. The 001 contract now lists them.
5. **E2e template lookups:**
   - The template editor defaults to Marketing, so the US1 spec now picks the template it creates.
   - The US6 spec read the template list before its own account's copy was synced. It now waits
     for its own account.
6. **Drip self-pause:** a disconnected number returned before the drip was paused; the drip now
   pauses first. Removed steps kept a shifted position; they now get their old one back.
7. **Retention cascades:** purging messages deletes their tracked links and clicks through foreign
   keys. Without an index on `link_clicks.tracked_link_id`, each deleted link would scan every
   click. A new migration adds that index and one on `drip_enrolments.ended_at`.
8. **Codes in request logs:** request logs showed `/l/<code>` paths. Codes are now hidden, and
   destinations are redacted.
9. **Quickstart wording:** it said codes are listed in a campaign's Messages tab, but the dashboard
   never shows codes. The quickstart was corrected.
10. **Low memory on the development machine:** a background wait for CI was stopped by the
    memory reaper. Results were then read once by hand.

## 4. Before release

- [ ] **Public link address:** set `PUBLIC_LINK_BASE_URL` to https on the company's own domain,
      reachable from phones. When it has no `/l` path, the reverse proxy sends `/<code>` to the
      api's `/l/<code>`. Open one link from a phone on mobile data.
- [ ] **Meta approval:** submit a template with a tracked link button (its address
      `<address>/{{1}}` on the company domain) and record the approval here. Send it to a test
      phone and check the click is counted once, and the WhatsApp preview not at all.
- [ ] **Reply window and limits:** confirm with the product owner:
      - Replied means a message within 3 days of delivery.
      - Retries run only within 24 hours of launch, and held-back (131049) messages are never retried.
      - Drips allow 10 steps, waits of 10 minutes to 30 days, 20 active drips and 100,000 contacts
        in each.
      - Quiet hours follow the company time zone.
- [ ] **Performance:** run `PERF_NUMBER_ID=<id> npm run perf:drips` on staging and record the
      SC-005 result in section 1.
- [ ] Apply the 005 migrations (`20261128000000_campaign_growth` and
      `20261129000000_growth_retention_indexes`) with the migration image before starting the new
      api and worker.
- [ ] Check that the worker runs the `drips` tick every 30 seconds (its job scheduler
      `drip-tick`) and the retry rounds on the `maintenance` queue.
- [ ] Reload Prometheus so it picks up the `WbmDripLagging` rule in `ops/alerts.yml`.
- [ ] Product owner sign-off after a walk-through of quickstart §3 on staging.
