---
id: 20
title: Implement US2 Contacts And Audiences
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us2", "contacts", "imports", "tags", "attributes", "audience-filter", "consent", "nextjs"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/src/modules/contacts/{attribute-validator,audience-query.builder,contacts.service,contacts.controller,tags.controller,attributes.controller,consent.service}.ts
 - apps/api/src/modules/imports/{imports.service,imports.controller,import.processor}.ts
 - apps/api/src/modules/campaigns/{campaigns.service,audience-snapshot.service,estimate.service,launch.service,audience-upload.service}.ts
 - apps/api/src/modules/sending/send-queue.manager.ts (boot no longer fails when the DB is briefly unavailable)
 - apps/api/src/modules/domain.module.ts, apps/api/src/worker-features.module.ts
 - apps/web/src/app/(dashboard)/contacts/{page,[id]/page,import/page}.tsx
 - apps/web/src/app/(dashboard)/settings/{layout,attributes/page,keywords/page}.tsx
 - apps/web/src/components/campaigns/{audience-rule-builder,wizard/audience-step,wizard/mapping-step}.tsx
 - apps/web/src/lib/{types,format,query}.ts(x)
 - apps/web/e2e/us2-contacts.spec.ts, samples/contacts-100.csv
 - specs/001-whatsapp-bulk-messaging/tasks.md (T114-T118, T120-T131 marked done; note on T119)
tests:
 - apps/api unit - 102 pass (new: audience query builder, attribute validator)
 - apps/api integration - 67 pass (new: contacts CRUD/search/bulk/preview, tags and attributes, contacts import with error report, FILTER and ALL_OPTED_IN campaigns)
 - apps/api contract - 10 pass (new: us2.contract-spec.ts)
 - typecheck (all workspaces) and eslint - clean
 - live HTTP smoke run (real API + worker + mock-meta) - contacts-100.csv: 103 rows, 100 imported, 3 errors in the report; STOP via `npm run mock:inbound` -> OPTED_OUT (KEYWORD) in about 1 s; tag audience excludes it; no phone numbers in logs
 - apps/web/e2e/us2-contacts.spec.ts - written, NOT executed (Playwright needs chromium v1255; low RAM)
---

## Prompt

continue

(continuation of /sp.implement into Phase 4; repeated once after an interruption: "continue")

## Response snapshot

Implemented Phase 4, User Story 2, test-first; the unit tests were confirmed red first.
- **Contacts:** CRUD with phone normalisation, typed attributes, tag sets, and documented manual consent (an opt-in needs a note). Search covers names, and phone digits for phone-like queries. Filters cover tag (AND) and consent. Bulk actions: add/remove tag, set/clear attribute.
- **Tags and attributes:** tags are case-insensitively unique and listed with contact counts. Attribute definitions use a key pattern and fixed type; deleting one removes its values from contacts.
- **Imports:** multipart upload with a JSON column mapping validated against the header and definitions. Streaming parse, then batched `INSERT ... ON CONFLICT (phone_e164)` upserts that merge attributes and add tags. Opt-ins come from a per-row source column or a file-level note, and opted-out contacts are never re-opted-in. A row-level error CSV is served at GET /imports/{id}/errors.
- **Audiences:** a parameterised SQL builder for tag/attribute rules with type-checked operators, plus a consent eligibility rule (opted-out always excluded; MARKETING needs opt-in). POST /contacts/audience-preview returns the counts.
- **Campaigns:** campaigns support FILTER and ALL_OPTED_IN in validation, estimate and the launch snapshot.
- **Web:** contacts list with bulk bar and add dialog, contact detail with consent history and delete, import page with mapping/preview/progress/error report, settings tabs (attributes & tags, consent keywords), and the wizard audience step with Upload / Filter (rule builder + live count) / All opted-in.

## Outcome

- ✅ Impact: The US2 checkpoint is met. US1 and US2 both work independently, and the quickstart US2 flow passed on the live stack.
- 🧪 Tests: 179 automated tests pass (unit 102, integration 67, contract 10) plus 28 shared; the Playwright specs for US1/US2 are still pending execution.
- 📁 Files: about 25 new or changed source files, the sample CSV and tasks.md updates.
- 🔁 Next prompts:
  - run T083/T119 after `npx playwright install chromium`
  - continue /sp.implement with Phase 5 (US3 templates, T132-T143)
- 🧠 Reflection:
  - Driving the rules from one compiled SQL condition, shared by preview, estimate and launch, keeps the counts consistent.
  - The live run caught an environment issue: Postgres went into recovery mode under memory pressure. That led to making the worker boot tolerant of a briefly unavailable DB.

## Evaluation notes (flywheel)

- Failure modes observed:
  - A mixed name+digits search matched phones; phone search now runs only for phone-like input.
  - A heredoc with nested quotes failed in the shell; edits were moved into script files.
  - Low RAM crashed Postgres once during a live run.
- Graders run and results (PASS/FAIL): unit PASS, integration PASS, contract PASS, typecheck PASS, lint PASS, live smoke PASS, Playwright NOT RUN.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Phase 5 - template creation with validation, header media handles, and status webhooks that auto-pause campaigns.
