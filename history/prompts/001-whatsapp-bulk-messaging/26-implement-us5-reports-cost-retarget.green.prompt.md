---
id: 26
title: Implement US5 Reports Cost Retarget
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us5", "reports", "export", "cost", "rate-card", "retarget"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/modules/reports/{cost-calculator,reports.service,export.controller}.ts
 - apps/api/src/modules/rate-card/rate-card.controller.ts
 - apps/api/src/modules/campaigns/{retarget.service,audience-snapshot.service,estimate.service,launch.service,campaigns.service,campaigns.controller,csv}.ts
 - apps/api/src/modules/webhooks/handlers/status.handler.ts (cost on billable deliveries)
 - apps/api/src/modules/domain.module.ts
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml (RETARGET audience type, retargetStatus)
 - apps/web/src/app/(dashboard)/campaigns/[id]/report/page.tsx, apps/web/src/app/(dashboard)/settings/rate-card/page.tsx
 - apps/web/src/app/(dashboard)/{settings/layout,campaigns/[id]/page}.tsx, apps/web/src/components/campaigns/wizard/{audience-step,mapping-step,review-step}.tsx, apps/web/src/lib/types.ts
 - apps/api/test/unit/cost-calculator.spec.ts, apps/api/test/integration/{reports,retarget-ratecard}.int-spec.ts, apps/api/test/contract/us5.contract-spec.ts, apps/web/e2e/us5-reports.spec.ts
 - specs/001-whatsapp-bulk-messaging/tasks.md (T153-T156, T158-T165 done; notes on T157, T162, T163)
tests:
 - apps/api unit - 107 pass (new: cost calculator; red confirmed first)
 - apps/api integration - reports + retarget/rate card 10 pass; affected campaign-send/filter/schedule + imports 16 pass
 - apps/api contract - us5 2 pass; dashboard contract lint valid (warnings only)
 - web typecheck and eslint (web + api) - clean
 - Playwright us5-reports - written, not executed; full regression not rerun (memory)
---

## Prompt

continue

## Response snapshot

Implemented Phase 7, User Story 5.
- **Rate card:** GET/PUT /rate-card, validated and audited; USD↔micros conversion; latest effective rate per category and country, falling back to `*`, with a 30 s cache.
- **Cost:** status webhooks store the cost of billable deliveries (webhook pricing flag, else delivered). The pre-launch estimate (eligible recipients × the category/country rate) appears in the estimate and is stored on the campaign at launch.
- **Report:** GET /campaigns/{id}/report gives totals, delivery and read rates, failure reasons and the cost from SQL aggregation, labelled as an estimate.
- **Export:** GET /campaigns/{id}/export streams the recipients CSV in batches, is audited `data.exported`, and is limited to `data.export`.
- **Retargeting:** POST /campaigns/{id}/retarget creates a RETARGET draft for FAILED / NOT_READ / READ / DELIVERED recipients.
  - Recipients are snapshotted at launch, with opted-out contacts excluded.
  - The source campaign's uploaded columns still fill variables.
  - The contract was updated to include RETARGET.
- **Web:** report page (stat cards, rates, cost, failure reasons, Export, Retarget buttons), rate card settings page, "View report" link, retarget audience info in the wizard, and the cost estimate on the review step.

## Outcome

- ✅ Impact: Campaign results and costs can be measured and acted on (FR-028–FR-031).
- 🧪 Tests: The targeted suites pass. The full regression and the Playwright specs are still pending (machine memory).
- 📁 Files: about 20 source files plus the contract, tests and tasks.md.
- 🔁 Next prompts:
  - continue with Phase 8 (US6 team access, roles, audit)
  - "tests chalao" for a full regression when RAM allows
- 🧠 Reflection: The data model already had RETARGET and retarget_status, but the contract enum did not; validating responses against the contract surfaced it, and the contract was aligned.

## Evaluation notes (flywheel)

- Failure modes observed: The contract and the data model disagreed (RETARGET audience type); CSV formula neutralisation altered phone numbers in exports until plain numbers were exempted.
- Graders run and results (PASS/FAIL): unit PASS, US5 integration PASS, affected integration PASS, US5 contract PASS, contract lint PASS, typecheck PASS, lint PASS, Playwright NOT RUN.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Phase 8 - invitations, role changes, deactivation and the audit log viewer.
