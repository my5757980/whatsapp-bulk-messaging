---
id: 117
title: Implement Ads MVP Batch
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 007-ads-manager
branch: 007-ads-manager
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ads", "click-to-whatsapp", "mvp", "test-first"]
links:
  spec: specs/007-ads-manager/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261202000000_ads/migration.sql
 - packages/shared/src/ads/*.ts
 - packages/shared/src/integrations/events.ts
 - packages/shared/src/enums.ts
 - apps/api/src/modules/ads/meta-ads.client.ts
 - apps/api/src/modules/ads/ads.module.ts
 - apps/api/src/modules/ads/connection/ads-connection.service.ts
 - apps/api/src/modules/ads/connection/ads-connection.controller.ts
 - apps/api/src/modules/ads/campaigns/ad-campaigns.service.ts
 - apps/api/src/modules/ads/campaigns/ad-campaigns.controller.ts
 - apps/api/src/modules/ads/campaigns/ad-targeting.controller.ts
 - apps/api/src/modules/ads/campaigns/ad-launcher.ts
 - apps/api/src/modules/ads/sync/ads-jobs.ts
 - apps/api/src/modules/ads/sync/ads-status.processor.ts
 - apps/api/src/modules/ads/chats/ad-chat-matcher.ts
 - apps/api/src/modules/ads/chats/ad-chats.controller.ts
 - apps/api/src/modules/inbox/inbound/message-parser.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
 - apps/api/src/modules/inbox/conversations/conversations.service.ts
 - apps/api/src/modules/integrations/webhooks/platform-events.ts
 - apps/web/src/lib/ads.ts
 - apps/web/src/app/(dashboard)/ads/page.tsx
 - apps/web/src/app/(dashboard)/ads/connect/page.tsx
 - apps/web/src/app/(dashboard)/ads/new/page.tsx
 - apps/web/src/app/(dashboard)/ads/[id]/page.tsx
 - apps/web/src/components/ads/*.tsx
 - apps/web/src/components/inbox/ad-referral-card.tsx
 - apps/web/src/components/flows/ads-trigger-card.tsx
 - tools/mock-meta/src/ads.ts
 - tools/mock-meta/src/inbound-cli.ts
 - specs/007-ads-manager/contracts/ads-api.openapi.yaml
 - specs/007-ads-manager/contracts/meta-ads-graph.md
 - specs/002-team-inbox/contracts/inbox-api.openapi.yaml
 - specs/006-integrations-platform/contracts/integrations-api.openapi.yaml
 - specs/006-integrations-platform/contracts/webhook-events.md
tests:
 - packages/shared/src/ads/{targeting,budgets,statuses,referral,hashing,checks}.test.ts (19 passing)
 - apps/api/test/unit/meta-ads-client.spec.ts (7 passing)
 - apps/api/test/unit (504 passing, incl. parser, redaction and audit coverage)
 - apps/api/test/integration/ads-connection.int-spec.ts (CI)
 - apps/api/test/integration/ads-launch.int-spec.ts (CI)
 - apps/api/test/integration/ads-chats.int-spec.ts (CI)
 - apps/api/test/contract/ads.contract-spec.ts (CI)
 - apps/web/e2e/ads-us1-connection.spec.ts, ads-us2-launch.spec.ts, ads-us3-ad-chats.spec.ts (CI)
---

## Prompt

Start with Setup, Foundational and the MVP batch (US1-US3), test-first; push the batch once and fix CI; then US4-US6, then US7-US8 with Polish.

(Resumed after restarts with "continue".)

## Response snapshot

- **Setup and foundation (T001–T018):**
  - `ADS_FREE_WINDOW_HOURS`, the `ads` queue, contract lint, schema with 10 tables and the migration tail.
  - Pure shared rules with tests: targeting, budgets and the cap, states, referrals and the free window, hashing, limits and checks.
  - `MetaAdsClient` with nock unit tests, audit actions, redaction keys, module wiring and `mock:inbound --referral-ad`.
- **US1 connection:**
  - Encrypted 30-minute token session, checks with fixes, one saved row, re-checks with an ERROR state and admin alerts, the monthly cap and disconnect.
  - Ads > Connect page and mock-meta ads routes.
- **US2 launch:**
  - Drafts checked with the shared rules, targeting search and estimates with Meta's minimum, and a submit that respects the linked number and the cap.
  - Launch order: media, welcome message sequence, creatives, campaign, ad set, ads; rollback on failure.
  - Resubmits edited rejected versions; a 5-minute status job plus follow-up reads after a submit.
  - List, builder and campaign pages.
- **US3 ad chats:**
  - The parser keeps the referral. `AdChatMatcher` runs before chat links: start row once a day, tag, journey, the `ad.chat_started` event and the campaign flow (never over a running flow or a member's chat).
  - The free window is read at query time on the chat detail.
  - Campaign chats and Other ads endpoints.
  - Live chat ad card, journey labels and the flow builder Ads card.
- Contracts documented (`adChat` on the chat detail, `edited` versions, new event types, Graph fields marked *(verify)*).

## Outcome

- ✅ Impact: the MVP of 007 (connect, launch, chats from ads) is built; integration, contract and e2e tests run in CI.
- 🧪 Tests: shared 266, api unit 504, web unit 8 passing locally; eslint and tsc clean; Docker-backed suites in CI.
- 📁 Files: see the list above.
- 🔁 Next prompts: push the batch and fix CI; then US4–US6 (results, manage and cap, audiences).
- 🧠 Reflection: a small stateful Graph fake made the launch, rollback and resubmit tests readable; follow-up status reads keep "Active within a minute" without polling Meta every few seconds.
