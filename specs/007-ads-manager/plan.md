# Implementation Plan: Click-to-WhatsApp Ads and the Ads Manager

**Branch**: `007-ads-manager` | **Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-ads-manager/spec.md`

## Summary

Run the company's Meta ads from the platform with its own ad account, matching the documented
behaviour of the market leader with our own design and wording:
- an ads connection with checks (the 006 wizard pattern)
- a guided builder for Click-to-WhatsApp, lead-form and website ads, with review tracking
- chats from ads marked in live chat, with the ad's tag and flow
- results from Meta plus the platform's own counts, and a monthly spending cap
- audiences from contacts with lookalikes
- lead forms whose leads become contacts with their consent
- AI-drafted ad texts

**Technical approach** (see research.md):
- **Meta:** a thin `MetaAdsClient` on the pinned Graph version (v27.0) with the company's system
  user token, stored with the 001 `TokenCipher` (R1). The connection reuses the 006 wizard session
  and check pattern (R2).
- **Structure:** one Meta campaign, one ad set and up to five ads per platform ad campaign; ODAX
  objectives by goal; chats use `destination_type: WHATSAPP` with the page and number; the
  pre-filled message is a WhatsApp welcome message sequence (R3, R4).
- **Jobs:** a new `ads` BullMQ queue with `ads-status` (every 5 minutes), `ads-insights` (hourly,
  plus a daily 28-day refresh that also enforces the cap), `ads-audiences` (daily diffs),
  `ads-leads-catchup` (every 15 minutes) and `ads-lead` (one lead) (R6–R9).
- **Chats:** the 002 inbound handler passes `referral` to an `AdChatMatcher`, called before the 006
  chat link matcher and the 003 flow router; flow starts follow the 006 chat link rules (R11).
- **Leads:** Meta's page `leadgen` webhooks arrive on the existing `/api/webhooks/meta` route (same
  app secret), handled by a new handler; a catch-up job reads missed leads (R9).
- **Website ads:** a counted link `${PUBLIC_LINK_BASE_URL}/a/{code}` served at `/l/a/:code`, built
  like the 006 chat link redirect (R10).
- **AI texts:** the 004 AI service with its limits and rules (R12).

## Technical Context

**Language/Version**: TypeScript 6.0 (strict) on Node.js 26 LTS, the same as 001–006

**Primary Dependencies**:
- **Existing:** NestJS 12.5, Prisma 7.10, BullMQ 6.7, ioredis 6, zod 4, libphonenumber-js; Next.js
  16.4, React 19.3, TanStack Query 5, Tailwind CSS 4; from earlier features: `TokenCipher`, the media
  library and send queue (001), live chat and the journey (002), flow sessions (003), the AI service
  (004), campaign groups and the link rate limiter (005), the wizard checks, chat link rules and
  outbound events (006).
- **New:** none. Graph calls use Node's `fetch` like `MetaGraphClient`; hashing uses `node:crypto`.

**Storage**:
- **PostgreSQL:** 10 new tables: `ads_connections`, `ad_campaigns`, `ad_versions`,
  `ad_result_days`, `ad_chat_starts`, `ad_audiences`, `ad_audience_members`, `ad_lead_forms`,
  `ad_leads`, `ad_link_opens`; a column on `messages` and extended enums (data-model.md).
- **Redis:** the `ads` queue; connection sessions (encrypted token, 30-minute TTL); the 005 link
  rate-limit keys for website links.
- **Object storage:** ad images and videos stay in the 001 media library until uploaded to Meta.

**Testing**:
- **Vitest unit (shared):** targeting and placement validation, minimum budget and cap math, status
  mapping, referral parsing, phone normalization for hashing, free window computation, text limits,
  ads check rules.
- **Vitest integration (api, nock Graph):** connection checks; launch with rollback; status sync and
  rejected versions; insights and the cap; audiences with diffs and erasure; leads from webhooks and
  the catch-up (once each, consent); chats from ads with tag and flow; website links; permissions,
  audit and retention.
- **Contract:** `contracts/ads-api.openapi.yaml` cases; RBAC reads the new contract.
- **Playwright e2e on mock-meta** (`tools/mock-meta/src/ads.ts`): connect, launch to Active, an ad chat
  with its flow and tag, results and pause, an audience, a lead.

**Target Platform**: the same Docker images and processes (api, worker, web) as 001–006

**Project Type**: web application (the existing monorepo)

**Performance Goals**: SC-002 (state within 15 minutes) with the 5-minute status job; SC-005 (leads
within 5 minutes) with webhooks and the 15-minute catch-up; SC-006 (at most 2 hours past the cap)
with hourly insights.

**Constraints**: Meta's business use case rate limits per ad account (the client slows syncs above
75% usage); Meta's review times and minimums; app review or advanced access for lead retrieval may be
needed (release checklist).

**Scale/Scope**: one ad account and page; tens of ad campaigns; audiences up to the size of the
contact list (batches of 10,000); leads in the thousands per month.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from `.specify/memory/constitution.md` (v1.0.0):

- [x] **I. Official API & Policy**: only Meta's documented Marketing and Cloud APIs on the pinned
  version; ads follow Meta's review, minimums and special category rules; leads are opted in only
  when they ticked a consent question naming WhatsApp; the free ad window changes no sending rule;
  opt-out still wins on every send path (welcome templates go through the 001 send checks).
- [x] **II. Original Product**: behaviour from public documentation only; screens, labels and texts
  are our own.
- [x] **III. Security & Privacy**: the system user and page tokens are encrypted, never shown again,
  never logged or sent in events; customer details reach Meta only as SHA-256 hashed phone numbers;
  opted-out, blocked and deleted contacts never go to audiences; page webhooks are verified with the
  app secret; audit entries for every sensitive change; phones masked for agents.
- [x] **IV. Reliable Bulk Messaging**: welcome templates use the 001 queue and limits; Graph changes
  are retried and launches roll back on failure; leads are deduplicated by Meta's id; webhooks are
  stored before processing (001 receiver).
- [x] **V. Test-First**: unit, integration (nock), contract and e2e (mock-meta) tests are written before
  each story's code; Meta is never called in tests.
- [x] **VI. Observability**: structured logs with correlation ids; metrics
  `wbm_ads_sync_total{job,result}`, `wbm_ad_chat_starts_total{matched}`, `wbm_ad_leads_total{result}`,
  `wbm_ads_spend_cap_pauses_total`; alert `WbmAdsSyncFailing`.
- [x] **VII. Simplicity**: no new dependency; one campaign, one ad set per platform campaign; existing
  permissions; the flow link lives on the ad campaign (the flow builder edits the same field).

Platform constraints: single tenant; Next.js + NestJS (TypeScript strict); PostgreSQL with
migrations; Redis + BullMQ; Docker. Ad money stays in the ad account currency (Meta bills it); the
platform's own costs stay in USD.

## Project Structure

### Documentation (this feature)

```text
specs/007-ads-manager/
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── ads-api.openapi.yaml   # dashboard routes
│   └── meta-ads-graph.md      # the Graph calls used, and mock-meta behaviour
├── checklists/requirements.md
└── tasks.md             # /sp.tasks
```

### Source Code (repository root)

```text
packages/shared/src/ads/
├── targeting.ts          # targeting and placement schema and rules (special categories, Status)
├── budgets.ts            # minimum budget and spending cap math
├── statuses.ts           # Meta effective status → platform states
├── referral.ts           # referral parsing and the free window
├── hashing.ts            # phone normalization for customer lists (hashing in the api)
├── checks.ts             # ads connection check rules
└── limits.ts             # text, media and button limits per goal

apps/api/src/modules/ads/
├── ads.module.ts                      # domain (matcher, client) and API modules, queue processors
├── meta-ads.client.ts                 # thin Graph client for ads calls
├── connection/ads-connection.service.ts, ads-connection.controller.ts
├── campaigns/ad-campaigns.service.ts, ad-campaigns.controller.ts, ad-launcher.ts, ad-targeting.controller.ts, ad-ai-text.service.ts
├── sync/ads-status.processor.ts, ads-insights.processor.ts, ads-cap.ts
├── results/ad-results.service.ts
├── chats/ad-chat-matcher.ts
├── audiences/ad-audiences.service.ts, ad-audiences.controller.ts, ads-audiences.processor.ts
├── leads/ad-lead-forms.service.ts, ad-lead-forms.controller.ts, leadgen.handler.ts, ad-leads.processor.ts
└── links/ad-link-redirect.controller.ts

apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts   # referral → AdChatMatcher
apps/api/src/modules/webhooks/                                # route object "page" to the leadgen handler
apps/api/src/modules/flows/ (UI only)                         # ad trigger card edits ad_campaigns.flow_id
apps/api/prisma/schema.prisma + migration

apps/web/src/app/(dashboard)/ads/
├── page.tsx                 # campaigns list
├── connect/page.tsx         # connection and checks, spending cap
├── new/page.tsx             # guided builder (also edits drafts)
├── [id]/page.tsx            # campaign: state, versions, results, chats, manage
├── audiences/page.tsx
└── lead-forms/page.tsx, lead-forms/[id]/page.tsx
apps/web/src/components/inbox/   # the ad card in live chat and the journey entries
apps/web/src/components/flows/   # the Ads trigger card

tools/mock-meta/src/ads.ts       # ads routes, review, insights, audiences, leads
tools/mock-meta/src/inbound-cli.ts  # --referral-ad
```

**Structure Decision**: the existing monorepo; a new `ads` module split into a global domain part
(the client and the chat matcher, used by the worker's inbound handler) and an API part
(controllers), with queue processors in `WorkerFeaturesModule`, as in 002–006.

## Delivery order

1. **Foundation**: schema and migration, shared rules, `MetaAdsClient`, mock-meta ads routes, the
   `ads` queue, permissions and audit actions.
2. **US1 Connection** (P1) → **US2 Launch** (P1) → **US3 Ad chats** (P1): the MVP.
3. **US4 Results** and **US5 Manage and cap** (P2), then **US6 Audiences** (P2).
4. **US7 Lead forms** and **US8 Website ads and AI texts** (P3).
5. **Polish**: metrics and alert, retention and erasure, RBAC, docs and the release checklist.

Stories are pushed in batches (US1–US3, US4–US6, US7–US8 with polish) so CI checks several at once.

## Complexity Tracking

No constitution violations. Two deliberate choices:

| Choice | Why | Simpler option rejected because |
|---|---|---|
| Keep the hashes sent to Meta (`ad_audience_members`) | Removing opted-out or deleted contacts needs the exact hashes; diffs keep daily updates small | Re-uploading whole audiences daily cannot remove people Meta already matched |
| A page webhook handler on the existing Meta route | Leads arrive within minutes (SC-005) with the same signature check | Polling only would need calls every minute per form |
