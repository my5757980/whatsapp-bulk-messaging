---
id: 104
title: Merge 005 And Spec Integrations Platform
stage: spec
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.specify
labels: ["merge", "005-campaign-growth", "spec", "integrations", "webhooks", "public-api", "shopify", "woocommerce", "qr-codes", "number-wizard"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/6
files:
 - specs/006-integrations-platform/spec.md
 - specs/006-integrations-platform/checklists/requirements.md
tests:
 - none (specification); before the merge, CI for 005 passed on all four jobs at a10eabe and the secret scan passed on 913464a
---

## Prompt

haaa agayyycontinue karooo kaam

(The user said yes to merging 005 into main and to going on with the next work. Claude merged 005 and started 006 with /sp.specify, using a description built from the inventory's Integrations row: API campaigns, a fuller contacts API, outbound webhooks, Shopify and WooCommerce order notifications with COD confirmation and abandoned carts, QR chat links and a guided number connection wizard. Out of scope: Embedded Signup, Dialogflow, payments, ads and named CRM connectors.)

## Response snapshot

- **005 merged:** `005-campaign-growth` was merged into main with git (`--no-ff`, e2dcd0e, "Merge pull request #6"). Main had not moved, so the merge was clean.
- **006 started:** the branch `006-integrations-platform` was created with the feature script (number 6, following the project's global numbering).
- **The spec has 8 stories:**
  - US1 (P1): outbound webhooks — signed, retried for 24 hours, with a delivery log, resend and a test event
  - US2 (P1): a contacts API — API key permissions, create or update by phone, tags, attributes, opt-ins with a source, enrolling in drips
  - US3 (P2): named API campaigns — mapping, media, tags and attributes, daily limits, self-pause and results
  - US4 (P2): store order notifications for Shopify and WooCommerce — once per order and event, skip reasons, 3-day stale limit
  - US5 (P2): COD confirmation — buttons mark the store order, one reminder, "not confirmed", automatic cancel off by default
  - US6 (P3): abandoned carts — up to 3 reminders, marketing consent only, stopping on an order, opt-out or reply, recovered value
  - US7 (P3): chat links and QR codes — pre-filled message with a reference, a flow and a tag, opens and chats started
  - US8 (P3): the number connection wizard — token checks, picking the account and number, registration, webhook subscription, a test message
- **Requirements:** 60 functional requirements, 9 success criteria, edge cases, assumptions, out of scope and dependencies.
- **Checklist:** every item passes, with no clarification markers. Defaults are recorded in Assumptions:
  - a store's consent counts as a WhatsApp opt-in only when an admin confirms its text names WhatsApp
  - automatic COD cancel is off
  - the waits and limits

## Outcome

- ✅ Impact: 005 is on main, and the 006 spec is ready for planning.
- 🧪 Tests: none for the spec; the quality checklist passes.
- 📁 Files: the spec and its quality checklist.
- 🔁 Next prompts: `/sp.plan` for 006, with research on Shopify and WooCommerce store access and events, Meta's permissions for the wizard, and webhook signing.
- 🧠 Reflection: a large integrations scope stays testable when each outside system gets its own story built on one shared piece (the store connection).

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): spec quality checklist PASS (iteration 1).
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): check Meta's template category rules for order updates and cart reminders early in research.
