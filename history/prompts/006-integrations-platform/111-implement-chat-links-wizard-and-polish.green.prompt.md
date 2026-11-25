---
id: 111
title: Implement Chat Links Wizard And Polish
stage: green
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.implement (continue)
labels: ["implement", "integrations", "chat-links", "qr", "number-wizard", "metrics", "retention", "rbac", "perf", "docs"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/7
files:
 - packages/shared/src/integrations/chat-links.ts (+ test)
 - apps/api/src/modules/integrations/chat-links/ (service, controller, redirect, matcher)
 - apps/api/src/modules/integrations/number-wizard/ (check rules, service, controller)
 - apps/api/src/modules/meta/meta-graph.client.ts (wizard Graph calls)
 - apps/api/src/modules/integrations/webhooks/outbound-events.ts (endpoint changes seen within a second), webhook-backlog.collector.ts
 - apps/api/src/modules/integrations/stores/store-carts.ts, prisma schema and migration (cart link owner)
 - apps/api/src/modules/webhooks/handlers/inbound.handler.ts, inbox/inbound/inbound-chat.handler.ts (new contact flag, chat link matcher)
 - apps/api/src/common/metrics/metrics.service.ts, ops/alerts.yml
 - apps/api/src/modules/maintenance/retention.processor.ts, contacts/contact-deletion.service.ts
 - apps/web/src/app/(dashboard)/campaigns/chat-links/ (list, link page, poster), numbers/connect/page.tsx, settings/numbers/page.tsx, components/integrations/wizard-checks.tsx, components/inbox/journey-list.tsx
 - tools/mock-meta/src/wizard.ts, tools/perf/webhooks-latency.ts, tools/perf/stores-latency.ts
 - README.md, docs/research/aisensy/feature-inventory-2026-11-19.md, specs/006-integrations-platform/ (data-model, quickstart, tasks, checklists/release.md)
tests:
 - unit: api 488/488, shared 247/247, web 8/8 (local)
 - CI on PR #7 at f07ac55: every job green (build-test with integration, contract, RBAC and key permissions; e2e 47/47; Docker images; secret scan)
---

## Prompt

continue

(Sent after /model and /effort; the work went on with 006 US6, US7, US8 and the polish tasks.)

## Response snapshot

- **US6 carts, green in CI:** a cart link failed the 005 one-owner check, so tracked link targets got
  `store_cart_id` and a three-owner check. The US1 e2e then showed the real cause of its flakiness:
  the worker kept endpoint subscriptions for 15 seconds, so early events were lost; every process now
  sees endpoint changes within a second.
- **US7 chat links and QR codes (T069–T076):** shared references, links with a short code on the 005
  address, QR images (SVG and PNG), a printable poster, the `/l/c/:code` redirect with the 005
  preview, robot and rate rules, and a matcher in live chat that counts the start (a contact once a
  day), tags the contact and starts the link's flow before keyword flows, never over a running flow
  or a member's chat. New contacts come from a flag set by the 001 inbound handler, which creates
  unknown senders first. Results per day, contacts, tagging and the export.
- **US8 number wizard (T077–T084):** Graph calls (debug_token, accounts, numbers, register,
  subscribed apps, app subscriptions), check rules with a plain fix each, sessions in Redis with the
  token encrypted for 30 minutes, fixes only when asked, a test template whose delivered status is
  found in the stored webhooks, connecting through the 001 service, and the health check. Mock-meta
  answers the wizard tokens. The web wizard and *Run checks* on the numbers page.
- **Polish (T085–T090):** seven integration metrics and two alerts; retention of integration
  records and the last erasure case; role checks over the 006 contract and key permission checks
  over every public operation; `perf:webhooks` and `perf:stores`; README, quickstart and the
  feature inventory. The release checklist records the results and the open release items.

## Outcome

- ✅ Impact: all 91 tasks of 006 done; every CI job green at f07ac55 (47/47 e2e). The release
  checklist lists the items that need people before go-live.
- 🧪 Tests: every API, shared and web unit test passes locally; build-test is green in CI.
- 📁 Files: see the list above.
- 🔁 Next prompts: the release items in checklists/release.md; merge PR #7 only after the user
  says yes.
- 🧠 Reflection: a cache that is invalidated only in the process that made the change looks right in
  single-process tests and fails only end to end; checking a cheap version stamp keeps the cache and
  makes every process correct within a second.
