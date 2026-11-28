# Implementation Plan: Contacts, Settings and Security

**Branch**: `010-contacts-settings-security` | **Date**: 2026-11-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-contacts-settings-security/spec.md`

## Summary

Add the contact, settings and security tools of the inventory row "Contacts, settings and security",
matching the documented behaviour of the market leader with our own design and wording:
- **Contacts:**
  - saved segments with behaviour rules, used as campaign audiences and drip enrolments
  - bulk tags and automatic tag rules
  - a lead source on every contact
  - a full contacts export
- **Messages:**
  - global attributes for templates, chats, flows and AI replies
  - replies to opt-in and opt-out keywords
  - birthday and other date automations
- **Security:** two-factor authentication for team sign-ins.
- **Numbers:** the WhatsApp Business profile, display name status, a blue tick checklist, and guides
  for moving a number in and out.

**Technical approach** (see research.md):
- **Segments:**
  - Stored as rule JSON and checked by a shared schema.
  - Members are worked out on demand by one SQL builder next to the 001 audience builder, so
    segments never go stale (R1).
  - Campaigns get the audience type `SEGMENT`; drips enrol a segment as a background bulk action
    (R2).
- **Bulk work:** a `bulk_actions` record and a new `bulk` queue (one worker, in order), walking the
  selection in keyset batches of 5,000 with set-based SQL (R3).
- **Automatic tags:** one `AutoTagService` called from contact creation, consent changes, link
  clicks and campaign replies (R4).
- **Lead source:**
  - A `lead_source_kind` enum next to the existing label.
  - Set only when a contact is created, through one helper.
  - The first message's chat link, website button or ad reference upgrades `ORGANIC` (R5).
- **Export:** a streamed CSV like the 009 reports (R6).
- **Global attributes:** a table with a 30-second cache, a new campaign variable source `global`, and
  `{global:key}` placeholders in flows, saved replies and AI agent instructions (R7).
- **Keyword replies:** text or utility-template replies sent by the 001 consent handler, at most once
  per contact and kind a day (R8).
- **Date automations:** a 1-minute tick finds due contacts by SQL on date attributes, writes unique
  occurrences (no double sends) and sends through the existing queues (R9).
- **2FA:**
  - RFC 6238 codes with `node:crypto`, the secret encrypted with `TokenCipher`, keyed-hash recovery
    codes.
  - A pending-login step, so no session exists before the second step.
  - A 15-minute lockout after 5 wrong codes (R10).
- **Business profile:** Meta's `whatsapp_business_profile` endpoint and the number fields
  `name_status`, `new_name_status`, `quality_rating` and `whatsapp_business_manager_messaging_limit`
  (R11).
- **Checklist and guides:** versioned data files in `@wbm/shared` (R12).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, the same as 001–009

**Primary Dependencies**:
- **Existing:**
  - NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, argon2, libphonenumber-js
  - Next.js 16.4, React 19.3, TanStack Query 5, Tailwind CSS 4
  - `qrcode` 1.5.4 (006), for the 2FA setup code
  - from earlier features:
    - 001: contacts, tags, attributes and the audience builder, consent and keyword lists,
      campaigns and the snapshot, the variable resolver, the template payload builder,
      `TokenCipher`, sessions and the login throttle, the Resumable Upload flow, audit and retention
    - 002: per-number send queues with priorities, session messages, saved replies, the lead source
      field
    - 003: flow message placeholders
    - 004: the AI agent prompt builder
    - 005: drips and enrolments, tracked link clicks
    - 006–009: chat links, ad referrals, lead forms, WhatsApp Forms, stores, the website button, the
      replied definition and report CSV streaming
- **New dependencies:** none.

**Storage**:
- **New tables:** `segments`, `bulk_actions`, `auto_tag_rules`, `global_attributes`,
  `date_automations`, `date_automation_occurrences`, `user_two_factor`, `user_recovery_codes`,
  `number_business_profiles` and `oba_checklist`.
- **Changed:**
  - `contacts`: `lead_source_kind`
  - `campaigns`: `segment_id`
  - `settings`: `opt_out_reply`, `opt_in_reply` and `require_2fa`
- **Enums:**
  - `AudienceType`: `SEGMENT`
  - `MessageOrigin`: `DATE_AUTOMATION`
  - `NotificationType`: `DATE_AUTOMATION_PAUSED`
  - new: `LeadSourceKind`, `BulkActionKind`, `BulkActionStatus`, `AutoTagEvent`,
    `DateAutomationTiming`, `DateAutomationStatus`, `OccurrenceStatus`
- **New index:** `messages (contact_id, created_at)`.
- **Redis:** pending sign-ins, second-step counters, keyword reply limits, the segment count cache.
- **One migration:** `20261217000000_contacts_settings_security`.

**Testing**:
- Vitest:
  - unit: rule schema, SQL builder, TOTP vectors, due dates, profile checks
  - integration: Postgres and Redis with nock `FakeGraph`
  - contract: OpenAPI responses
- Playwright e2e on mock-meta.
- Integration, contract and e2e run in CI (no Docker on the development machine).

**Target Platform**: The company's own Linux server (api, worker, web, Postgres, Redis, MinIO), as
for 001–009.

**Project Type**: Web application in the existing monorepo (apps/api, apps/web, packages/shared,
tools/mock-meta).

**Performance Goals**:
- SC-001: a segment count over 200,000 contacts in under 3 seconds
- SC-002: bulk tags on 50,000 contacts in under 1 minute
- SC-003: an export of 100,000 rows starts within 5 seconds and finishes in under 2 minutes
- SC-004: 99% of date automation messages handed to Meta within 15 minutes of the send time
- SC-005: keyword replies within 10 seconds
- SC-007: a global attribute change used by every message within 30 seconds

**Constraints**:
- **Consent:** opted-out and blocked contacts never get campaign, automation or keyword-reply
  messages. Marketing templates need opted-in contacts, and no marketing template is ever used as a
  keyword reply.
- **Sign-in:** a password alone never creates a session for a member with 2FA, or while 2FA is
  required.
- **Secrets and codes:** app secrets are stored encrypted; recovery codes cannot be read back.
- **Business profile:** changes go only through Meta's API and within Meta's limits.

**Scale/Scope**:
- Up to 500,000 contacts, 200 segments, 50 date automations, 30 team members and 20 numbers.
- 8 stories, 37 requirements, 10 new tables, about 30 new dashboard routes and 4 sign-in routes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this plan complies |
|---|---|
| I. Official WhatsApp Cloud API & policy | The business profile and number status use Meta's documented Cloud API endpoints only (R11). Date automations and keyword replies send through the existing template and session paths, so templates, the 24-hour window, rate limits and frequency capping still apply. Opt-out always wins. |
| II. Original product, no copying | The behaviour follows the public docs. Screens, labels, the checklist and the guides are our own words (R12). |
| III. Security & privacy by default | Exports mask phones by role and are audited. 2FA uses an encrypted secret, keyed-hash recovery codes, replay protection, a lockout and an audit trail (R10). Admin resets end the member's sessions. Segments and samples mask phones by role. No new personal data leaves the platform, and erasure covers the new records (R13). |
| IV. Reliable bulk messaging | Date automations send through the per-number queues with campaign priority. Unique occurrences prevent double sends; pending occurrences never spill into the next day; problems pause and notify (R9). Bulk work runs in an ordered queue that survives restarts (R3). |
| V. Test-first | Every story starts with failing unit, integration, contract and e2e tests (R14). |
| VI. Observability | Six new metrics and two alerts, with structured logs for every run and action (R13). |
| VII. Simplicity & smallest viable change | No new dependency. The 001 audience builder, snapshot, variable resolver, send queues and login throttle are reused and extended. Segments are not stored as membership tables. |

**Result**: PASS, with no violations to justify (the Complexity Tracking table is empty).

**Re-check after Phase 1**: PASS.
- The data model adds one table per concept.
- The contracts reuse the 001 error shape and paging.
- The sign-in additions keep the 001 cookies and CSRF.

## Project Structure

### Documentation (this feature)

```text
specs/010-contacts-settings-security/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 (R1–R14)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── contacts-settings-api.openapi.yaml   # dashboard routes, x-permission on every operation
│   ├── login-2fa.md                         # the sign-in steps, cookies and lockout
│   └── meta-business-profile.md             # the Graph calls and their errors
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/sp.tasks)
```

### Source Code (repository root)

```text
packages/shared/src/
├── contacts/
│   ├── segment-rules.ts          # SegmentRulesSchema, rule kinds, limits (R1)
│   ├── lead-source.ts            # LeadSourceKind labels, legacy text mapping (R5)
│   └── date-automation.ts        # due-date maths: yearly, once, offset, 29 February (R9)
├── settings/
│   ├── business-profile.ts       # Meta's limits, verticals and picture rules (R11)
│   ├── oba-checklist.ts          # blue tick steps, our own words, checkedAt (R12)
│   └── number-guides.ts          # move in / move back guides (R12)
└── permissions.ts                # unchanged permission set; new audit actions in the api

apps/api/
├── prisma/schema.prisma + migrations/20261217000000_contacts_settings_security/
├── scripts/reset-2fa.ts          # operator reset (R10)
└── src/
    ├── common/auth/totp.ts                     # RFC 6238 (R10)
    ├── modules/auth/                           # pending sign-in, code step, setup during sign-in, lockout
    ├── modules/me/two-factor.controller.ts     # /me/2fa
    ├── modules/users/                          # 2FA reset; settings/security
    ├── modules/contacts/
    │   ├── segment-query.builder.ts            # R1
    │   ├── segments.service.ts + controller    # CRUD, preview, counts, usage
    │   ├── bulk-actions.service.ts + controller + bulk.processor.ts   # R3 (queue `bulk`)
    │   ├── auto-tags.service.ts + controller   # R4
    │   ├── lead-source.ts                      # leadSourceFor() used by every creation path (R5)
    │   └── contacts-export.controller.ts       # R6
    ├── modules/settings/global-attributes.*    # R7 (service, controller, cache, usage scan)
    ├── modules/settings/keyword-replies.ts     # R8 (called by the 001 consent handler)
    ├── modules/automations/                    # R9: service, controller, tick processor, results
    ├── modules/numbers/business-profile.*      # R11
    ├── modules/numbers/oba-checklist.*         # R12
    └── (touched) campaigns audience snapshot and estimate, variable resolver, drips enrolment,
        flows render, canned render, AI prompt builder, inbound and consent handlers, chat link and
        ad matchers, public and contacts APIs, imports, uploads, lead forms, forms, stores, link
        clicks, retention, contact erasure, metrics

apps/web/src/app/(dashboard)/
├── contacts/segments/            # list, editor with live counts and sample
├── contacts/page.tsx             # segment filter, lead source column and filter, bulk bar, export
├── settings/automatic-tags/      # rules
├── settings/global-attributes/   # list and editor
├── settings/keywords/            # keyword lists and replies (extends the 001 keyword settings)
├── automations/                  # date automations list, editor, results
├── settings/security/            # require 2FA; members' 2FA status and reset
├── account/two-factor/           # a member's own 2FA
├── (auth)/login/                 # code step and setup step
└── numbers/[id]/profile/         # business profile, display name status, checklist, guides

tools/mock-meta/src/business-profile.ts   # GET/POST profile, number status fields
```

**Structure Decision**: the existing monorepo layout. New api modules sit beside their neighbours
(`contacts`, `settings`, `numbers`, `auth`), plus a new `automations` module. Shared rules and
content live in `@wbm/shared`, so the web app and the api check the same limits.

## Delivery order

- **Setup and foundation:**
  - the migration and enums
  - shared rule schemas and content files
  - `leadSourceFor()` wired into every creation path
  - the `bulk` queue
  - the global attribute resolver
  - mock-meta and FakeGraph routes
  - the new audit actions and metrics
- **Batch 1, the MVP (P1):**
  - **US1:** segments and their use in campaigns and drips
  - **US2:** bulk tags, automatic tags, lead source display and filter, export
- **Batch 2 (P2):**
  - **US3:** global attributes
  - **US4:** keyword replies
  - **US5:** date automations
  - **US6:** 2FA
- **Batch 3 (P3) and Polish:**
  - **US7:** business profile, display name status and checklist
  - **US8:** guides
  - Polish: metrics and alerts, retention and erasure, RBAC with the new contract, docs and the
    release checklist
- **Dependencies:** US1 needs the foundation; US2's automatic tags need the lead source helper
  (foundation); US3 must land before US5 (automations use global attributes in their mapping); US6,
  US7 and US8 are independent.

## Complexity Tracking

*No constitution violations: the table is intentionally empty.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
