---
id: 137
title: Templates Growth MVP Batch
stage: green
date: 2026-11-27
surface: agent
model: claude-opus-5-5
feature: 009-templates-growth
branch: 009-templates-growth
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "test-first", "otp", "carousel", "limited-time-offer", "expired", "mvp-batch"]
links:
  spec: specs/009-templates-growth/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/11
files:
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261210000000_templates_growth/migration.sql
 - apps/api/src/modules/otp/ (service, status, controllers, module)
 - apps/api/src/modules/sending/send-expiry.ts
 - apps/api/src/modules/sending/send.processor.ts
 - apps/api/src/modules/sending/template-payload.builder.ts
 - apps/api/src/modules/campaigns/media-check.service.ts
 - apps/api/src/modules/campaigns/launch.service.ts
 - apps/api/src/modules/campaigns/schedule.service.ts
 - apps/api/src/modules/campaigns/estimate.service.ts
 - apps/api/src/modules/campaigns/campaign-messages.controller.ts
 - apps/api/src/modules/growth/links/tracked-links.service.ts
 - apps/api/src/modules/growth/links/link-codes.ts
 - apps/api/src/modules/flows/definitions/publish.service.ts
 - apps/api/src/modules/inbox/inbound/message-parser.ts
 - apps/api/src/modules/reports/reports.service.ts
 - apps/api/src/modules/public-api/public-api.service.ts
 - apps/web/src/components/campaigns/wizard/card-media.tsx
 - apps/web/src/components/campaigns/wizard/offer-config.tsx
 - apps/web/src/components/campaigns/wizard/mapping-step.tsx
 - apps/web/src/components/campaigns/wizard/review-step.tsx
 - apps/web/src/components/inbox/chat-item-view.tsx
 - apps/web/src/components/flows/trigger-panel.tsx
 - apps/web/src/app/(dashboard)/campaigns/[id]/page.tsx
 - apps/web/src/lib/types.ts
 - apps/web/src/lib/format.ts
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml
 - specs/009-templates-growth/plan.md
 - specs/009-templates-growth/tasks.md
tests:
 - apps/api/test/unit/sending/template-payload-kinds.spec.ts (carousel and offer payloads, sendExpiry; pass)
 - apps/api/test/unit/inbox/message-parser.spec.ts (card reply and inbox preview; pass)
 - apps/api/test/integration/templates-carousel.int-spec.ts (CI)
 - apps/api/test/integration/templates-offer.int-spec.ts (CI)
 - apps/api/test/contract/templates-growth.contract-spec.ts, us3.contract-spec.ts, us5.contract-spec.ts (CI)
 - apps/web/e2e/templates-us2-carousel.spec.ts, templates-us3-offer.spec.ts (CI)
 - api unit suite 580/580 pass; api and web typecheck pass; eslint and lint:contracts pass
---

## Prompt

shuruuuu aroooooo

(The user's go-ahead to start implementing; /sp.implement ran with: "Start with Setup, Foundational and the MVP batch (US1-US3), test-first; push the batch once and fix CI; then US4-US5, then US6-US8 with Polish.")

continue

(After /model and /effort, twice: continue the MVP batch.)

## Response snapshot

- Finished the MVP batch (Setup, Foundational, US1 codes, US2 carousels, US3 offers) test-first:
  - Expiry at send time: sendExpiry drops a message as EXPIRED with OFFER_ENDED or EXPIRED_BEFORE_SENDING. The MessageEventType gains EXPIRED. Campaign totals count expired messages, and the report shows why they expired.
  - Carousel cards work with 005 tracked links (card URL buttons) and 003 template button triggers (the publish check and the trigger panel read card quick replies).
  - Scheduling checks that an offer does not end before the new start time.
  - The estimate counts recipients without an offer code or a media address.
  - The recipients list can be filtered by EXPIRED.
- Web:
  - campaign wizard: card files from the library with a check, and offer settings (end time, plus the code from one value, a column or an attribute)
  - an offer line in the review step
  - an Expired tile and filter on the campaign page
  - "Card 2 · Tell me more" in live chat and in the inbox list
- Contracts: the 001 contract gains offerConfig, cardMedia, allowDuplicateRows, the expired totals, the report breakdown and the estimate counts.
- Docs: plan.md now says codes respect the number's sending_enabled switch. T038 is reworded: the chat item keeps the button text.
- Pushed 9d65df2 and opened PR #11. CI is running.

## Outcome

- ✅ Impact: the MVP batch is pushed for CI; tasks are marked done only after CI passes.
- 🧪 Tests: unit, typecheck and lint pass locally; integration, contract and e2e tests run in CI.
- 📁 Files: see the list above.
- 🔁 Next prompts: fix CI, then US4–US5 (TTL and media addresses; replies, duplicates and reports).
- 🧠 Reflection: carousel card keys (CARD.c.BUTTON.b.n) are a new kind of key. Every place that read top-level BUTTONS only needed a card-aware branch: tracked links, link codes, flow publish checks and the trigger panel.

## Evaluation notes (flywheel)

- Failure modes observed: scheduling skipped the offer end check because it validated the stored draft (scheduledAt null); it is fixed by passing the new start.
- Graders run and results (PASS/FAIL): api unit PASS (580); tsc PASS; eslint PASS; redocly PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
