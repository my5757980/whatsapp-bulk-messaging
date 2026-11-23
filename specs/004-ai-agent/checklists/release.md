# Release Checklist: AI Agent

**Feature**: `004-ai-agent` | **Task**: T113 | **Last run**: 2026-11-23
**Environment**:
- Windows 10, 3.9 GB RAM, Node 26 (local: lint, typecheck, unit tests). Docker was not available,
  so every check that needs Postgres, Redis or MinIO ran in CI.
- GitHub Actions ubuntu-latest (draft PR #5): integration, contract, e2e, Docker images, the
  dependency audit, alert rules and the secret scan. AI replies in CI come from the fake model
  (mock-meta's `/anthropic`, with streamed replies for the team assistant), never from the real one.

**Status**: Ready for review. All automated gates pass in CI, and every quickstart row is covered by
integration tests and a Playwright e2e spec run against the fake model. Still open before release
(section 4): the company's Anthropic account and key, the data protection review, the zero data
retention decision, the model and prices, the quality eval with the real model, the SC-001 run on
staging hardware and the product owner's sign-off.

## 1. Automated gates (quickstart §4 + CI)

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | ✅ PASS | eslint over each changed area before every commit; CI `build-test` runs it over the whole repo |
| `npm run typecheck` | ✅ PASS | api (src and tests), web, shared, mock-meta, `tools/perf` and `tools/eval` |
| `npm test` (unit) | ✅ PASS | api 415/415 (46 files), shared 163/163 (17 files), web 6/6 (2 files) (2026-11-23, local) |
| `npm run test:integration` | ✅ PASS | 63 files in CI, 11 of them AI suites (`ai-agents-build-publish`, `ai-knowledge`, `ai-turns`, `ai-live-chat`, `ai-testing`, `ai-replies-memory`, `ai-skills`, `ai-flows`, `ai-usage`, `ai-starters`, `ai-assistant`), with Claude mocked by nock (streamed for the assistant), plus AI cases in `rbac`, `retention` and `contact-deletion` |
| `npm run test:contract` | ✅ PASS | `ai.contract-spec.ts`: cases for US1–US9 against `contracts/ai-api.openapi.yaml` |
| RBAC from all four contracts (T108) | ✅ PASS | `rbac.int-spec.ts` now reads the 001–004 contracts; the 38 AI operations (29 `ai.manage`, 3 `ai.usage`, 5 `assistant.use`, 1 `inbox.view`) match the code with no permission change |
| Audit coverage (T107) | ✅ PASS | all 17 AI actions are recorded, including `ai.limits_changed` and `ai.assistant_action_confirmed` (`audit-coverage.spec.ts`) |
| Log redaction (T106) | ✅ PASS | prompts, system text, knowledge and chunks, questions and answers, replies, hand-over summaries, remembered values and pending confirmations (`logging-redaction.spec.ts`) |
| Retention and erasure (T105) | ✅ PASS | AI conversations ended over 12 months ago go with their replies and unanswered asks, old asks and replies too, questions nobody asked for a year, and old assistant requests with their actions; question counts follow (`retention.int-spec.ts`). Deleting a contact clears AI conversation links, summaries and pending confirmations and removes their unanswered asks, keeping reply counts and sources (`contact-deletion.int-spec.ts`) |
| Metrics and alert (T104) | ✅ PASS | `wbm_ai_turns_total`, `wbm_ai_turn_duration_seconds`, `wbm_ai_tokens_total`, `wbm_ai_replies_total`, `wbm_ai_knowledge_jobs_total`, `wbm_ai_assistant_requests_total`; `promtool check rules` passes with 9 rules, including `WbmAiFailing` (`alerts.spec.ts`) |
| `npm audit --audit-level=high` | ✅ PASS | CI `build-test` step |
| gitleaks (history) | ✅ PASS | CI `secret-scan` |
| Docker images | ✅ PASS | CI `docker-images`: api, migration and web images build, and the 002 live event smoke test still passes |
| Playwright e2e | ✅ PASS | CI `e2e-smoke`: 33 specs, including `ai-us1-knowledge` … `ai-us9-assistant`. Each story ended green on all four jobs (table below) |
| Performance SC-001 | 🟡 NOT RUN | `npm run perf:ai` is ready (T109): it publishes an agent on the number, sends 3 rounds of 50 customer questions at once and matches each AI reply to its chat on the live event stream (limit 10 s at p95), against the fake model. It needs the api, the worker and the Docker services; run it on staging hardware |
| Quality eval SC-002/003/005/010 | 🟡 NOT RUN | `npm run eval:ai` is ready (T112) with the full sets: 100 answerable and 50 unanswerable questions, 200 rule-breaking attempts, 100 ways to ask for a person (50 English, 50 Arabic) and 50 hand-over conversations for the summary review. It uses the real model through the preview chat (500 calls), so it runs only by hand with `EVAL_CONFIRM=yes` after approval (section 4) |

CI per story (all four jobs: build-test, e2e-smoke, docker-images, secret-scan):

| Story | First push | Green at |
|---|---|---|
| Foundation, US1 | c05e7be (failure: a flows test depended on another file's keyword) | 6697953 |
| US2 | 985ed57, 3c1baed (failure: AI turns picked messages by time; the AI live chat controller lacked the inbox rules) | 5cb09e8 |
| US3 | 5cb09e8, 3b5f450 | 5cb09e8 |
| US4 | 5aa3271 | 5aa3271 |
| US5 | bd96667 (failure: an assertion matched a word inside other words) | da9a7dd |
| US6 | 0c7a694 (failure: an e2e click on canvas nodes timed out) | 1222dac |
| US7 | 1222dac, 95467cf | 95467cf |
| US8 | fa704b9 | fa704b9 |
| US9 | f9e1e37 (API), 399c239 (web and e2e) | 399c239 |
| Polish | 5ad94ad, bc305b4 | 5ad94ad |

## 2. Quickstart validation rows (§3)

| Story | Status | How it was validated | Still to do |
|---|---|---|---|
| US1 Answers from knowledge | ✅ | unit `prompt`, `knowledge-search`, `extract`, `crawler`, shared `chunking` and `reply`; `ai-agents-build-publish`, `ai-knowledge` (answers, websites, files, sizes, failures), `ai-turns` (introduction, labels, unanswered); contract US1; e2e `ai-us1-knowledge` | Declining a poem and "am I talking to a person?" depend on the real model: covered by the eval (SC-003, SC-005) |
| US2 Hand-over and rules | ✅ | unit `eligibility`; `ai-live-chat` (asks for a person with one closing reply, the alert and a summary note; hand-over topics; the second unanswered question and the reply cap; the only automatic message outside working hours; members taking, replying, sending a template or starting a flow stop the agent; answering again after a close; STOP and opt-outs in other words; blocked contacts; flow keywords first; the fallback on failures and the failure alert; the 24-hour expiry); contract US2; e2e `ai-us2-handover` | — |
| US3 Preview, test numbers, versions | ✅ | `ai-testing` (preview without changes and with "would do" items, the preview limit, test numbers get the draft, versions and restore); contract US3; e2e `ai-us3-testing` | — |
| US4 Rich replies and memory | ✅ | unit `reply-message`; `ai-replies-memory` (a shared file with the message as its caption, buttons and lists with taps coming back as answers, facts saved to allowed attributes with a journey entry by the agent, a card number masked before the AI service and never saved); e2e `ai-us4-rich-replies` | — |
| US5 API skills | ✅ | unit `skill-tools` (variables, place-aware encoding, secrets only in headers, mapped fields only, confirmation before calls that change data); `ai-skills` (secrets encrypted and shown by name only, http and private addresses refused at publish, ok: false and no invented status on a timeout or a 500, the skill test request, secrets in use cannot be deleted); contract US5; e2e `ai-us5-api-skill` | Call one real company endpoint from staging |
| US6 Flows | ✅ | shared `graph` and `validate`; unit `run-ai-step`; `ai-flows` (keyword flows first, Hand to AI agent with another agent, agent-started flows and continuing afterwards, publish refused for unpublished agents and flows); e2e `ai-us6-flows` | — |
| US7 Usage and limit | ✅ | `ai-usage` (replies 1–5 counted, alerts at 80% and 100% once, the 6th handed over with the limit note and no model call, one of two concurrent turns for the last reply, test replies shown apart, failures not counted, report totals equal the records, admins only, audited); contract US7; e2e `ai-us7-usage` | — |
| US8 Starters | ✅ | shared `starters`; `ai-starters` (flags for existing attributes, the draft and its example answers, publishing refused until they are replaced or removed); contract US8; e2e `ai-us8-starters` | — |
| US9 Assistant | ✅ | unit `assistant-tools` (permissions, the 003 flow checks, previews only, nothing sends or deletes), `claude-client` (a streamed tool turn); `ai-assistant` (template draft not submitted and replaced when submitted, flow draft passing the publish checks, campaign draft unscheduled, send preview with recipients and cost confirmed by the member only, cancel, expiry, permission checked again, a manager refused the AI limit and contact deletion, the monthly assistant limit, report figures equal the reports, failures not counted); contract US9; e2e `ai-us9-assistant` | How well the real model drafts: try the quickstart row once with the real key |

## 3. Gaps found and fixed during implementation

1. **Turns picked messages by time:** WhatsApp timestamps have one-second precision and can arrive
   out of order, so turns sometimes answered nothing or the wrong batch. Waiting messages now carry
   a pending flag that the turn clears.
2. **Clock-dependent tests:** welcome-message tests failed outside working hours; they now set
   working hours to always.
3. **API boot failure:** the AI live chat controller needed the 002 visibility rules; the AI API
   module imports them, and unit tests now compile the HTTP app, the worker and both together.
4. **STOP during an AI conversation:** the opt-out now ends the AI conversation before the flow
   router runs.
5. **Invalid step ids:** a camelCase step type produced `aiAgent-1`; new step ids are lower-case
   (`ai-agent-1`).
6. **Flow drafts from the assistant:** the publish rules require retry text on question steps; the
   guide the model gets now says so, and problems go back to the model to fix.
7. **Template drafts:** "Duplicate & edit" renamed a draft `…_copy`, so a reviewed draft could not
   replace itself. A local draft now opens under its own name ("Review template draft"), and
   submitting it replaces the draft.
8. **Fake model rules:** the assistant's workspace block was matched as the member's words; mock-meta
   now ignores it, and it streams replies when asked, as the assistant needs.
9. **Starter answer order:** rows written in one transaction share `now()`; example answers get
   creation times a millisecond apart.
10. **Crash damage on the development machine:** a crash zeroed `.git/index` once; it was recovered,
    and every session starts with a NUL-byte scan of changed files.

### Follow-ups (not blocking)

- More starter agents (returns, KYC, admissions) and ads in the assistant (AiSensy inventory 9.3, 9.5).
- A per-member rate limit on assistant requests, like the preview's 20 a minute.
- The 003 flow editor palette has no Hand over step entry, although the step exists (outside 004).

## 4. Before release

- [ ] **Anthropic account and key:** the company's own Anthropic account, its billing owner, and an
      API key stored as the `ANTHROPIC_API_KEY` secret of the api and the worker
      (`ANTHROPIC_BASE_URL` empty in production).
- [ ] **Data protection review:** customer chats, knowledge and contact attributes are processed by
      the AI service abroad. Record the review of the provider's terms and the company's privacy
      notice to customers.
- [ ] **Zero data retention decision:** the provider keeps API data for a limited time by default;
      decide whether to request zero data retention and record the decision here.
- [ ] **Model and prices:** confirm `claude-opus-5-5` and the prices on the AI usage page (default USD
      4 input, 20 output, 0.20 cache read and 5 cache write per million tokens); set the monthly reply
      limit, the assistant limit and the message at the limit.
- [ ] **Quality eval:** with approval, run `EVAL_CONFIRM=yes npm run eval:ai` against staging with
      the real key; record the SC-002, SC-003 and SC-005 scores here, and have two members grade
      `summary-review.csv` (SC-010, at least 45 of 50) and spot-check `rules-review.csv`.
- [ ] **Performance:** run `npm run perf:ai` on staging and record the SC-001 result in section 1.
- [ ] Apply the 004 migrations with the migration image before starting the new api and worker.
- [ ] Allow outbound HTTPS from the worker to the AI service, to the endpoints API skills call and to
      the websites read for knowledge. Private and reserved addresses are refused by design.
- [ ] Reload Prometheus so it picks up the `WbmAiFailing` rule in `ops/alerts.yml`.
- [ ] Product owner sign-off after a walk-through of quickstart §3 with the real model.
