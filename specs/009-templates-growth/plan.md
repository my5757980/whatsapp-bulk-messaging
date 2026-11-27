# Implementation Plan: More Template Types, Campaign Reports and the Website Chat Button

**Branch**: `009-templates-growth` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-templates-growth/spec.md`

## Summary

Add the template kinds, campaign results, reports and growth tools of the inventory row "Templates
and campaign growth", matching the documented behaviour of the market leader with our own design and
wording:
- **Template kinds:**
  - authentication templates, with a public API for one-time codes that are sent first and never
    stored
  - carousel templates with card media chosen per campaign
  - limited-time offer templates with an end time and per-recipient codes
  - a time-to-live per template
  - media from a web address in campaigns
- **Campaigns and reports:** replied counts and the reply rate; "send to every row" for uploads;
  overview, team member and opt-in/opt-out reports.
- **Help:** a sample template library, guidelines and the meaning of every delivery error.
- **Website:** a chat button for the company's website, plus a WhatsApp link and QR generator.

**Technical approach** (see research.md):
- **Templates:** the 001 `templates` row gains `kind`, `ttl_seconds` and `options`. The shared
  `validateTemplate` checks each kind, and the 001 submit service maps each kind to Meta's components
  (R1, R2, R6, R7; contracts/meta-templates.md).
- **Codes:**
  - `POST /api/v1/otp` with the new key scope `otp.send` (R3)
  - the code travels only in the request and an encrypted send job, and is masked everywhere else (R4)
  - OTP jobs go on the number's 002 send queue without a priority, so they run before chat replies
    and campaigns under the same rate limiter (R5)
- **Carousels:** card files are uploaded to the number before launch and cached for 25 days
  (`meta_media_uploads`). Card quick replies carry `wbm:c{i}:b{b}` payloads (R6).
- **Time-to-live:** codes and utility go to Meta; marketing is applied in our queue, because the Cloud
  API takes no marketing TTL. A new final status `EXPIRED` comes from send-time checks and a 5-minute
  sweep, since Meta sends no code for dropped messages (R8).
- **Campaigns:**
  - media addresses checked with the 003 safe HTTP client (all up to 1,000 distinct, a sample above)
    (R9)
  - `copy_index` on messages for "send to every row" (R10)
  - one `REPLIED` SQL fragment shared by results and the 005 retarget group (R11)
- **Help and samples:** versioned data files in `@wbm/shared` (R12, R13).
- **Reports:** aggregate SQL with streamed CSVs, never stored, under the new `reports.view` (R14).
- **Website button:** one static script plus a public config per key at `/l/w/…`. Chats go through
  006 chat links (`source: WIDGET`), so opens per page and chats started per page rule are counted
  (R15). The generator is one route using the 006 `qrcode` library (R16).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, the same as 001–008

**Primary Dependencies**:
- **Existing:**
  - NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, libphonenumber-js
  - Next.js 16.4, React 19.3, TanStack Query 5, Tailwind CSS 4
  - `qrcode` 1.5.4 (006)
  - from earlier features:
    - 001: templates and their sync, the Resumable Upload flow, campaigns and the snapshot, the send
      processor and payload builder, `TokenCipher`, the rate card and the CSV export pattern
    - 002: per-number send queues with priorities, the inbound parser, conversation openings
    - 003: the safe HTTP client and template button triggers
    - 005: the `REPLIED` definition, retry rounds and held-back messages, the link rate limiter
    - 006: API key scopes, idempotency, outbound events and chat links
- **New:** none.
  - The website button script is plain JavaScript built from one TypeScript file with the existing
    `tsc`.
  - Meta calls use the existing client.

**Storage**:
- **PostgreSQL:** 3 new tables, `meta_media_uploads`, `otp_settings` and `chat_widgets`.
  - **New columns:**
    - `templates`: `kind`, `ttl_seconds`, `ttl_applied_by`, `options`
    - `campaigns`: `allow_duplicate_rows`, `offer_config`, `card_media`, `launched_by_id`
    - `messages`: `copy_index`, `expired_reason`, `expires_at`
    - `chat_links`: `source`, `widget_id`, `widget_rule_id`
    - `chat_link_opens`: `page`
  - **Enums:** new and extended (data-model.md).
  - **Indexes:** `messages (created_at)` and the partial `(expires_at) WHERE status = 'SENT'`;
    `consent_events (created_at)`; `chat_link_opens (chat_link_id, page)`.
  - The messages unique key becomes `(campaign_id, contact_id, copy_index)`.
- **Redis:**
  - the per-phone code counter `wbm:otp:phone:{sha256}`
  - OTP send jobs with the encrypted code, removed on completion and on failure
- **Object storage:** none new. Brand images are media library files.

**Testing**:
- **Vitest unit (shared):**
  - `validateTemplate` for each kind, including the TTL ranges
  - mapping keys for cards, the offer code and `HEADER.media`
  - the launch checks
  - status ranking with `EXPIRED`
  - every sample valid, plus the coverage counts
  - error meanings coverage: every code in the classifier has an entry
  - page rule matching
  - report range rules
  - the widget script's size budget
- **Vitest unit (api):**
  - the Meta component mapping per kind
  - send payloads per kind
  - code masking in params and logs
  - the carousel quick reply parser
  - the alert rules
- **Vitest integration** (api, nock `FakeGraph` extended, R18):
  - **templates:** creating, submitting and syncing each kind
  - **codes:** the API with scope, limits, idempotency, blocked numbers and priority; the scan proving
    no code is kept anywhere (SC-002)
  - **carousels:** card uploads and the upload cache, card variables, quick replies
  - **offers:** per-recipient codes, the end time, "offer ended"
  - **expiry:** TTL before and after sending, with the sweep and late webhooks
  - **campaigns:** media address checks (the safe client against nock); duplicates and `copy_index`
  - **replied:** the count equals the retarget group (SC-006)
  - **reports:** totals against campaign results, ranges, masking, audit
  - **samples:** copying
  - **website button:** config, hidden states, page counts and starts per rule
  - **generator:** links and QR codes
  - **cross-cutting:** RBAC, audit coverage, retention and erasure
- **Contract:**
  - `contracts/templates-growth-api.openapi.yaml` (dashboard) and `contracts/public-otp-v1.openapi.yaml`
    (public API)
  - RBAC reads the dashboard contract and skips the three `/l/w/…` routes
  - **Updates to earlier contracts:**
    - 001: TemplateInput and Template kinds and TTL, campaign fields, report additions, the `EXPIRED`
      status
    - 002: carousel reply items
    - 006: the `otp.send` scope, the `otp.status` event and the `WIDGET` chat links
- **Playwright e2e** on mock-meta:
  - a code template and a code by API
  - a carousel campaign with a card reply
  - an offer campaign
  - TTL with held delivery
  - media addresses and duplicates
  - reports
  - samples and help
  - the website button on the mock test site, and the generator

**Target Platform**: the same Docker images and processes (api, worker, web) as 001–008

**Project Type**: web application (the existing monorepo)

**Performance Goals**:
- **SC-001** (a code handed to WhatsApp within 2 s, p95): no priority on the number's queue, one
  Meta call, no contact work; measured by `wbm_otp_send_seconds`.
- **SC-007** (reports for 100,000 messages in 30 s): grouped SQL on indexed columns; CSVs streamed in
  batches.
- **SC-010** (the button under 30 KB, visible within 1 s): one cached static script and a 60-second
  config.
- **Launch checks:** under a minute (at most 1,000 address checks, 5 at a time, 5-second timeouts).

**Constraints**:
- **Meta:**
  - Authentication bodies are fixed by Meta. Codes are at most 15 characters.
  - One-tap needs the company's Android app to start Meta's handshake.
  - Carousels and offers are marketing only. Carousel card media is sent by Meta media id.
  - Marketing TTL is not available on the Cloud API.
  - Offers show a notice instead on WhatsApp web and desktop.
  - Messages over Meta's per-person marketing limit are held back (131049).
- **Website:**
  - The snippet needs the company's web team.
  - A site Content Security Policy must allow the link host.

**Scale/Scope**:
- codes: up to thousands a day
- campaigns: up to 50,000 recipients, carousels up to 10 cards
- reports: up to 12 months back
- one or a few website buttons with up to 50 page rules each
- 60+ samples and a few dozen help entries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0):

- [x] **I. Official API & Policy**:
  - Only Meta's documented Cloud API template kinds, parameters and media upload are used, on the
    pinned Graph version.
  - Templates are still the only messages outside the 24-hour window.
  - Opt-out wins on every campaign path, including duplicate rows and carousels.
  - One-time codes are not marketing: the person asked for them on the company's own site or app
    (spec assumption). They skip marketing consent but never go to blocked numbers.
  - The broadcast kill switch (001) pauses campaigns, not codes. Codes have their own per-phone limit.
- [x] **II. Original Product**:
  - Behaviour comes from public documentation only.
  - Samples, guidelines, error meanings, the button's design and its icon are written or drawn by us.
- [x] **III. Security & Privacy**:
  - Codes are never stored: they exist only in the request and an encrypted, self-deleting send job.
    They are masked in Postgres, logs, idempotency records, exports and events, and a scan test proves
    it.
  - `otp.send` is a separate key scope.
  - The button's public config has display data only, with no cookies and no visitor data beyond the
    page path.
  - Media addresses go through the safe HTTP client (https and public addresses only).
  - Report downloads need `data.export`, are audited, and mask phones without `phones.full`.
- [x] **IV. Reliable Bulk Messaging**:
  - All sends use the number's queue and rate limiter. Codes overtake through queue order, not a
    second limiter.
  - Expired and offer-ended messages are final and never retried.
  - Duplicate rows keep idempotent message keys (`copy_index`).
  - Late webhooks replace an `EXPIRED` mark.
- [x] **V. Test-First**: unit, integration (nock), contract and e2e (mock-meta) tests come before
  each story's code. Meta is never called in tests.
- [x] **VI. Observability**:
  - metrics `wbm_otp_sends_total`, `wbm_otp_send_seconds`, `wbm_messages_expired_total`,
    `wbm_widget_opens_total`, `wbm_reports_exported_total`, `wbm_unknown_error_codes_total`
  - alerts `WbmOtpFailing` and `WbmOtpSlow`
- [x] **VII. Simplicity**:
  - no new dependency
  - one template table and one message table for every kind
  - help and samples as data files
  - reports from existing tables without rollups
  - the website button reuses chat links
  - one new permission and one new key scope

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker; costs in USD.

## Project Structure

### Documentation (this feature)

```text
specs/009-templates-growth/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── templates-growth-api.openapi.yaml  # dashboard routes and the public /l/w/… routes
│   ├── public-otp-v1.openapi.yaml         # /api/v1/otp (otp.send) and the otp.status event body
│   ├── meta-templates.md                  # Meta create, upload and send bodies per kind; fakes
│   └── website-button.md                  # snippet, script, config, page rules, counting
├── checklists/requirements.md
└── tasks.md             # /sp.tasks
```

### Source Code (repository root)

```text
packages/shared/src/
├── template-rules.ts                 # kinds, TTL ranges, carousel/offer/auth rules (extended)
├── templates/samples.ts              # TEMPLATE_SAMPLES (60+, en and ar)
├── templates/template-kinds.ts       # kind helpers, mapping keys for cards and offers
├── help/error-meanings.ts            # Meta and platform reasons: meaning, action, checkedAt
├── help/template-guidelines.ts       # editor sections and rejection reasons
├── growth/page-rules.ts              # website button rule matching (shared by the script and tests)
├── campaigns/launch-checks.ts        # offer end, card media, media addresses (rules only)
├── reports/ranges.ts                 # report range rules
├── status.ts, enums.ts, permissions.ts, integrations/scopes.ts, integrations/events.ts  # EXPIRED, reports.view, otp.send, otp.status

apps/api/src/modules/templates/       # kind mapping to Meta, TTL on create/edit, sync of kinds, samples controller
apps/api/src/modules/otp/
├── otp.module.ts
├── otp.service.ts                    # validation, limits, masked message rows, encrypted jobs
├── public-otp.controller.ts          # /api/v1/otp
└── otp-settings.controller.ts        # /otp/settings
apps/api/src/modules/sending/         # OTP jobs, carousel/offer/auth payloads, TTL and offer checks, expired sweep
apps/api/src/modules/media/meta-media-uploads.ts  # upload cache for card media
apps/api/src/modules/campaigns/       # duplicates, offer config, card media, media checks, replied.sql.ts, launchedById
apps/api/src/modules/reports/         # overview, team and consent reports with streamed CSVs
apps/api/src/modules/integrations/chat-widgets/   # widgets service and controller, public config, image and script routes
apps/api/src/modules/integrations/chat-links/     # source, widget links, page on opens
apps/api/src/modules/tools/whatsapp-link.controller.ts
apps/api/src/modules/inbox/inbound/message-parser.ts  # carousel quick reply payloads
apps/api/src/modules/maintenance/retention.processor.ts, contacts/contact-deletion.service.ts
apps/api/src/widget/chat-button.ts    # the website button script source, built to dist/widget/widget.js
apps/api/prisma/schema.prisma + migration 20261210000000_templates_growth

apps/web/src/app/(dashboard)/templates/new, templates/[id]   # kind choice and editors: code, carousel, offer, TTL
apps/web/src/app/(dashboard)/templates/samples/page.tsx
apps/web/src/app/(dashboard)/settings/one-time-codes/page.tsx
apps/web/src/app/(dashboard)/reports/page.tsx                # overview, team, opt-ins and opt-outs
apps/web/src/app/(dashboard)/website-button/page.tsx, website-button/[id]/page.tsx
apps/web/src/app/(dashboard)/tools/whatsapp-link/page.tsx
apps/web/src/components/templates/    # carousel cards, offer fields, code options, guidelines panel
apps/web/src/components/campaigns/    # card media, offer end and code, media addresses, every-row option, replied
apps/web/src/components/help/         # error meaning, frequency capping note

tools/mock-meta/src/                  # template kinds, media upload, hold delivery, the test site, CLI button payload
```

**Structure Decision**: the existing monorepo with one new api module, `otp` (the code API and
settings). Everything else extends the 001 templates, sending, campaigns and reports modules and the
006 chat links. The website button lives under integrations, next to chat links. The script source
sits in the api and is served as a static file. Queue work (OTP sends, the expired sweep) runs in the
existing worker processors.

## Delivery order

1. **Foundation**:
   - schema and migration, enums, status ranking
   - shared template kinds and rules, mapping keys, launch checks
   - `FakeGraph` and mock-meta routes
   - permissions, scope, event and audit actions
   - the error meanings data, so every later story shows reasons
2. **Batch 1 (MVP)**:
   - **US1 Codes** (P1): authentication templates, the code API, settings, priority, masking.
   - **US2 Carousels** (P1): editor, submit, card media uploads, sends, quick replies.
   - **US3 Offers** (P2): editor, campaign end time and codes, "offer ended".
3. **Batch 2**:
   - **US4** (P2): TTL (Meta and platform), the expired sweep, media addresses with the check.
   - **US5** (P2): replied and the reply rate, "send to every row", the three reports.
4. **Batch 3**:
   - **US6** (P3): samples.
   - **US7** (P3): guidelines and the frequency capping notes.
   - **US8** (P3): the website button and the generator.
   - **Polish**: metrics and alerts, retention and erasure, the code scan test, RBAC, docs and the
     release checklist.

Stories are pushed in these three batches so CI checks several at once.

## Complexity Tracking

No constitution violations. Three deliberate choices:

| Choice | Why | Simpler option rejected because |
|---|---|---|
| The code only in an encrypted, self-deleting job | A code is a credential; anything stored can leak from backups or logs. | A masked column after sending still writes the code to disk first. |
| A platform-side TTL and the expired sweep | Meta sends no code for dropped messages and takes no marketing TTL on the Cloud API; members still need "not delivered in time". | Waiting for Meta's status leaves messages "sent" forever, and Meta's Marketing Messages API is another integration. |
| One static script plus a config per key | The snippet never changes after edits; no framework and under 30 KB. | An iframe is heavier and harder to place; a script per button busts caches and needs a new snippet after every edit. |
