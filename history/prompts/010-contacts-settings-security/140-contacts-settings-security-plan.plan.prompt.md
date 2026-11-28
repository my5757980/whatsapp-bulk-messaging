---
id: 140
title: Contacts Settings Security Plan
stage: plan
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 010-contacts-settings-security
branch: 010-contacts-settings-security
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "segments", "bulk-actions", "lead-source", "global-attributes", "date-automations", "2fa", "business-profile"]
links:
  spec: specs/010-contacts-settings-security/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/010-contacts-settings-security/plan.md
 - specs/010-contacts-settings-security/research.md
 - specs/010-contacts-settings-security/data-model.md
 - specs/010-contacts-settings-security/quickstart.md
 - specs/010-contacts-settings-security/contracts/contacts-settings-api.openapi.yaml
 - specs/010-contacts-settings-security/contracts/login-2fa.md
 - specs/010-contacts-settings-security/contracts/meta-business-profile.md
 - specs/010-contacts-settings-security/spec.md
 - CLAUDE.md
tests:
 - redocly lint of contacts-settings-api.openapi.yaml (valid; first run found two descriptions with commas, now quoted)
---

## Prompt

continue

(The session continued with the agreed next step: /sp.plan for 010 while the last 009 e2e run finished.)

## Response snapshot

- **Research R1–R14:**
  - **Segments:** rule JSON checked by a shared schema; members worked out on demand by one SQL
    builder next to the 001 audience builder; behaviour rules over messages; 009 replied definition;
    005 clicks.
  - **Campaigns and drips:** campaigns get the audience type SEGMENT; drips enrol a segment as a
    background bulk action.
  - **Bulk actions:** a `bulk_actions` record and an ordered `bulk` queue.
  - **Automatic tags:** one service with four call sites.
  - **Lead source:** a `lead_source_kind` enum with a legacy text mapping, set only at creation; the
    first message's chat link, website button or ad reference upgrades ORGANIC.
  - **Export and global attributes:** a streamed export; global attributes with a 30-second cache, a
    `global` variable source and `{global:key}` placeholders.
  - **Keyword replies:** text or utility template, once a day per contact and kind.
  - **Date automations:** a 1-minute tick, unique occurrences and a "too late" end of day.
  - **2FA:** RFC 6238 with `node:crypto`, keyed-hash recovery codes, a pending sign-in cookie and a
    15-minute lockout.
  - **Business profile:** Meta facts checked on 2026-11-28: field limits, verticals, `name_status`
    values, and `whatsapp_business_manager_messaging_limit` replacing the deprecated tier.
- **Documents:**
  - plan.md (constitution check passes with no violations, no new dependency)
  - data-model.md (10 new tables, enum additions)
  - the dashboard OpenAPI contract with x-permission on every role-limited operation
  - login-2fa.md and meta-business-profile.md
  - quickstart.md; the agent context is updated
- **Spec wording:** a campaign's global attribute is filled at launch, like every other variable.

## Outcome

- ✅ Impact: 010 is ready for /sp.tasks.
- 🧪 Tests: the contract lint passes.
- 📁 Files: see the list above.
- 🔁 Next prompts: /sp.tasks for 010; merge 009 when its e2e run is green.
- 🧠 Reflection: earlier contracts taught two rules applied here: quote flow-style descriptions that
  hold commas, and never build response schemas with allOf over a closed input schema.

## Evaluation notes (flywheel)

- Failure modes observed: the first lint run refused two unquoted descriptions with commas.
- Graders run and results (PASS/FAIL): redocly lint PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
