---
id: 138
title: Templates Growth Batches 2-3 and Polish
stage: green
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 009-templates-growth
branch: 009-templates-growth
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "test-first", "ttl", "media-urls", "reports", "samples", "help", "website-button", "polish"]
links:
  spec: specs/009-templates-growth/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/11
files:
 - apps/api/src/modules/sending/expired-sweep.processor.ts
 - apps/api/src/modules/sending/send.processor.ts
 - apps/api/src/modules/campaigns/media-check.service.ts
 - apps/api/src/modules/reports/ (replied.sql.ts, overview, team and consent reports, reports-v2.controller.ts)
 - apps/api/src/modules/templates/template-samples.controller.ts
 - apps/api/src/modules/integrations/chat-widgets/ (service, controller, public controller, check processor)
 - apps/api/src/modules/integrations/chat-links/chat-link-redirect.service.ts
 - apps/api/src/modules/tools/whatsapp-link.controller.ts
 - apps/api/src/widget/chat-button.ts
 - apps/api/scripts/build-widget.mjs
 - apps/api/src/modules/otp/otp.service.ts
 - apps/api/src/modules/maintenance/retention.processor.ts
 - apps/api/src/modules/contacts/contact-deletion.service.ts
 - apps/api/src/common/metrics/metrics.service.ts
 - ops/alerts.yml
 - packages/shared/src/templates/samples.ts
 - packages/shared/src/help/template-guidelines.ts
 - packages/shared/src/growth/page-rules.ts
 - apps/web/src/app/(dashboard)/website-button/page.tsx
 - apps/web/src/app/(dashboard)/website-button/[id]/page.tsx
 - apps/web/src/app/(dashboard)/website-button/widget-types.ts
 - apps/web/src/app/(dashboard)/tools/whatsapp-link/page.tsx
 - apps/web/src/app/(dashboard)/campaigns/chat-links/page.tsx
 - apps/web/src/app/(dashboard)/layout.tsx
 - apps/web/src/app/(dashboard)/templates/samples/page.tsx
 - apps/web/src/app/(dashboard)/settings/one-time-codes/page.tsx
 - specs/009-templates-growth/contracts/templates-growth-api.openapi.yaml
 - specs/009-templates-growth/checklists/release.md
 - specs/009-templates-growth/contracts/website-button.md
 - specs/009-templates-growth/quickstart.md
 - specs/009-templates-growth/tasks.md
 - README.md
 - docs/research/aisensy/feature-inventory-2026-11-19.md
tests:
 - apps/api/test/integration/chat-widgets.int-spec.ts, whatsapp-link-tool.int-spec.ts (CI)
 - apps/api/test/integration/otp-no-code-leak.int-spec.ts (CI)
 - apps/api/test/integration/retention.int-spec.ts, contact-deletion.int-spec.ts, rbac.int-spec.ts: 009 cases (CI)
 - apps/api/test/contract/templates-growth.contract-spec.ts: US8 cases (CI)
 - apps/web/e2e/widget-us8.spec.ts (CI)
 - apps/api/test/unit/widget/chat-button.spec.ts, widget-bundle.spec.ts (pass)
 - apps/api/test/unit/alerts.spec.ts, audit-coverage.spec.ts (pass)
 - api unit suite 596/596 pass; api (both tsconfigs) and web typecheck pass; eslint pass
---

## Prompt

continue

(After /model and /effort at the session start: continue /sp.implement for 009.)

[Request interrupted by user for tool use] continue

(After the user rejected a tool call that ran a long `node -e` string with escaped template literals.)

continue

(After /model and /effort again, and once more while work was running: continue the batches.)

continue

(After /model and /effort once more, while the fixes for the 69e5d4b CI run were being made.)

## Response snapshot

- Batch 2 (US4–US5) pushed and fixed in CI: the public API answers a bad media address with 400, unique fake wamids, the 001 export columns, spread test phones. CI at 700991c passed build-test and every 009 e2e spec except US1, so T048–T078 (US4–US7) are marked done.
- US6 samples and US7 help pushed; the sample copy drops empty media handles (Prisma refuses undefined in JSON arrays).
- US8: the website button api, the public script, config and image routes, the disconnection check, the link generator, then the designer (preview at desktop and phone sizes, page rules in order, snippet, setup guide, counts), the button list, the generator page, the chat link form filled in from the generator, and the nav items. The script now uses an open shadow root so browser tests and accessibility checkers can reach it (contract updated).
- Polish: the 009 metrics and the WbmOtpFailing and WbmOtpSlow alerts; code messages deleted after 30 days and their phone cleared on erasure; a code leak scan through success, failure, retry and an idempotent repeat that ends with a real worker deleting the jobs; the audit pending list emptied; RBAC reads the 009 contract; README, quickstart and the AiSensy inventory updated.
- Fix from the e2e failure, first attempt: I blamed two settings rows and moved the settings to a fixed id. CI at 69e5d4b showed the table already holds one row (unique index `otp_settings_one_row`), so the regression test failed; the same run refused the website button responses (the ChatWidget schema extended the closed input schema through allOf).
- The real cause: the settings page filled its form whenever the saved settings arrived, so a slow answer undid the template already chosen and the save stored none. The form now takes the saved settings once and stays locked until then; the service is back to findFirst, with a first-use race reading the other request's row. The ChatWidget schema lists its fields in full (checked locally with the contract validator).
- Pushed the fixes after 69e5d4b; CI is running.

## Outcome

- ✅ Impact: every 009 story and the polish tasks are written; US8 and polish wait for CI before being marked done.
- 🧪 Tests: unit, typecheck and lint pass locally; integration, contract and e2e run in CI.
- 📁 Files: see the list above.
- 🔁 Next prompts: read CI for 69e5d4b, fix any failure, mark T079–T095, write the release checklist (T096), then ask about merging PR #11.
- 🧠 Reflection: check the schema and migration before naming a database cause; a form filled from a query on every change can undo the user's edits when the answer is slow.

## Evaluation notes (flywheel)

- Failure modes observed: a settings form reset by a late query answer; a wrong first diagnosis (two rows) that the one-row index ruled out; allOf over a schema with additionalProperties false.
- Graders run and results (PASS/FAIL): api unit PASS (596); tsc PASS (api, widget, web); eslint PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
