---
id: 118
title: Implement Ads Remaining Stories Polish
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 007-ads-manager
branch: 007-ads-manager
user: Muhammad Yaseen
command: /sp.implement (continued)
labels: ["implement", "ads", "results", "spending-cap", "audiences", "lead-forms", "website-ads", "ai-texts", "polish"]
links:
  spec: specs/007-ads-manager/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/9
files:
 - apps/api/src/modules/ads/sync/ads-insights.processor.ts
 - apps/api/src/modules/ads/sync/ads-cap.ts
 - apps/api/src/modules/ads/results/ad-results.service.ts
 - apps/api/src/modules/ads/results/ad-results.controller.ts
 - apps/api/src/modules/ads/campaigns/ad-campaigns.service.ts
 - apps/api/src/modules/ads/campaigns/ad-campaigns.controller.ts
 - apps/api/src/modules/ads/campaigns/ad-ai-text.service.ts
 - apps/api/src/modules/ads/audiences/ad-audiences.service.ts
 - apps/api/src/modules/ads/audiences/ad-audiences.controller.ts
 - apps/api/src/modules/ads/audiences/ads-audiences.processor.ts
 - apps/api/src/modules/ads/leads/ad-lead-forms.service.ts
 - apps/api/src/modules/ads/leads/ad-lead-forms.controller.ts
 - apps/api/src/modules/ads/leads/leadgen.handler.ts
 - apps/api/src/modules/ads/leads/ad-leads.processor.ts
 - apps/api/src/modules/ads/links/ad-link-redirect.controller.ts
 - apps/api/src/modules/webhooks/webhook-router.ts
 - apps/api/src/modules/maintenance/retention.processor.ts
 - apps/api/src/modules/contacts/contact-deletion.service.ts
 - apps/api/src/common/metrics/metrics.service.ts
 - ops/alerts.yml
 - apps/web/src/app/(dashboard)/ads/audiences/page.tsx
 - apps/web/src/app/(dashboard)/ads/lead-forms/page.tsx
 - apps/web/src/app/(dashboard)/ads/lead-forms/[id]/page.tsx
 - apps/web/src/components/ads/ad-results.tsx
 - apps/web/src/components/ads/ad-manage.tsx
 - apps/web/src/components/ads/welcome-mapping.tsx
 - tools/mock-meta/src/ads.ts
 - tools/mock-meta/src/ai.ts
 - README.md
 - docs/research/aisensy/feature-inventory-2026-11-19.md
 - specs/007-ads-manager/checklists/release.md
tests:
 - apps/api/test/integration/ads-results.int-spec.ts (CI)
 - apps/api/test/integration/ads-manage.int-spec.ts (CI)
 - apps/api/test/integration/ads-audiences.int-spec.ts (CI)
 - apps/api/test/integration/ads-leads.int-spec.ts (CI)
 - apps/api/test/integration/ads-website-ai.int-spec.ts (CI)
 - apps/api/test/contract/ads.contract-spec.ts (US4–US8 cases, CI)
 - apps/web/e2e/ads-us4-results.spec.ts … ads-us8-website-ai.spec.ts (CI)
 - retention, contact-deletion and rbac cases (CI)
 - api unit 513, shared 266, web 8 (local)
---

## Prompt

continue

(After restarts; the running request was: "Start with Setup, Foundational and the MVP batch (US1-US3), test-first; push the batch once and fix CI; then US4-US6, then US7-US8 with Polish.")

## Response snapshot

- **MVP CI:**
  - build-test was green on the first push.
  - The e2e failed because the mock token had 17 characters (the token rule needs 20); renamed to `mock-ads-token-ok-full`.
  - A 001 e2e template-sync race, worsened by more accounts in the suite, was fixed in four specs.
- **US4–US6 (green at f50ccf2):**
  - **Results:** hourly insights per version and day with the campaign's reach rows, a daily 28-day refresh, and the first read 30 seconds after a campaign becomes active. The results API and CSV give the platform's own counts and the costs per chat and lead.
  - **Manage:** pause, resume, end, duplicate, pause or resume one version, and budget or end date changes.
  - **Cap:** `AdsCap` refuses submits, resumes and budget increases that could pass the cap, and pauses all campaigns once a month when the cap is reached.
  - **Audiences:** saved audiences from tags, filters and campaign groups, sent as `PHONE_SHA256` hashes with daily diffs, plus lookalikes. Deletes are refused while a running campaign uses the audience.
  - **Web:** results panel, manage card, audiences page and the builder's audience picker.
- **US7, US8 and polish (5a460f0):**
  - **Lead forms:** forms made with the page token, with a WhatsApp consent checkbox and a welcome mapping; the page is subscribed to `leadgen`.
  - **Leads:** the webhook router dispatches by object to a leadgen handler, and a 15-minute catch-up finds missed leads. Each lead becomes a tagged contact, opted in with `LEAD_FORM` only when the box is ticked, and gets the welcome template once.
  - **Website ads:** links at `/l/a/:code` with UTM tags and the 005 rules.
  - **AI texts:** drafted through the 004 service within the assistant limit.
  - **Polish:** metrics and the `WbmAdsSyncFailing` alert, retention (25 and 12 months), contact erasure, RBAC over seven contracts, the empty audit pending list, the README Ads section, the AiSensy inventory and the release checklist.

## Outcome

- ✅ Impact: all 72 tasks of 007 are implemented; PR #9 carries the feature.
- 🧪 Tests: every batch green in CI before the last push; the last push's CI is the release gate.
- 📁 Files: see the list above.
- 🔁 Next prompts: mark the PR ready and merge on the user's go-ahead; then payments.
- 🧠 Reflection: a stateful Graph fake and mock-meta routes per story kept the Meta flows testable without real accounts; Prisma did not type-check a filter on a missing column, so integration tests remain essential.
