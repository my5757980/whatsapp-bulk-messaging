---
id: 142
title: Contacts Settings Security Implement Batches
stage: green
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 010-contacts-settings-security
branch: 010-contacts-settings-security
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ci-fix", "global-attributes", "keyword-replies", "date-automations", "2fa", "totp"]
links:
  spec: specs/010-contacts-settings-security/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/12
files:
 - apps/api/src/modules/contacts/audience-query.builder.ts
 - apps/api/src/modules/contacts/contacts.service.ts
 - apps/api/src/modules/inbox/conversations/chat-contact.service.ts
 - apps/api/src/modules/inbox/conversations/conversations.service.ts
 - apps/api/src/modules/settings/global-attributes.service.ts
 - apps/api/src/modules/settings/global-attributes.controller.ts
 - apps/api/src/modules/settings/keyword-replies.ts
 - apps/api/src/modules/automations/due-query.ts
 - apps/api/src/modules/automations/date-automations.service.ts
 - apps/api/src/modules/automations/date-automations.controller.ts
 - apps/api/src/modules/automations/date-automation-tick.processor.ts
 - apps/api/src/common/auth/totp.ts
 - apps/api/src/modules/auth/recovery-codes.ts
 - apps/api/src/modules/auth/two-factor.service.ts
 - apps/api/src/modules/auth/two-factor.controller.ts
 - apps/api/src/modules/auth/auth.controller.ts
 - apps/api/src/modules/auth/auth.service.ts
 - apps/api/src/modules/auth/auth.cookies.ts
 - apps/api/src/modules/sending/send.processor.ts
 - apps/api/src/modules/sending/send-outcome.ts
 - apps/api/src/modules/inbox/inbound/inbound-chat.handler.ts
 - apps/api/src/modules/inbox/automation/auto-replies.service.ts
 - apps/api/scripts/reset-2fa.ts
 - apps/web/src/app/(dashboard)/settings/global-attributes/page.tsx
 - apps/web/src/components/settings/keyword-replies-card.tsx
 - apps/web/src/app/(dashboard)/automations/page.tsx
 - apps/web/src/app/(dashboard)/automations/[id]/page.tsx
 - apps/web/src/app/(auth)/login/page.tsx
 - apps/web/src/app/(dashboard)/account/two-factor/page.tsx
 - apps/web/src/app/(dashboard)/settings/security/page.tsx
 - specs/001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml
tests:
 - apps/api/test/unit/global-attributes.spec.ts, flows/render.spec.ts, canned-render and variable-resolver additions
 - apps/api/test/unit/keyword-replies.spec.ts, send-processor.spec.ts (opt-out confirmation)
 - apps/api/test/unit/automations/due-query.spec.ts (parity with dueOn over three years), date-automation-tick.spec.ts
 - apps/api/test/unit/auth/totp.spec.ts (RFC 6238 and RFC 4226 vectors)
 - apps/api/test/integration/global-attributes, keyword-replies, date-automations, two-factor (.int-spec.ts)
 - apps/api/test/contract/contacts-settings.contract-spec.ts (US3 – US6)
 - apps/web/e2e/settings-us3-global-attributes, settings-us4-keywords, automations-us5-dates, security-us6-2fa
---

## Prompt

continue

## Response snapshot

- **MVP CI fixes:** the audience and segment builders import each other, so Nest saw `Object` for the
  segment builder when the processors loaded first (`forwardRef`); live chat shows the lead source
  kind as text; the 12,000-contact bulk test draws phones not already in the shared database; tags
  added to many contacts run in transactions of 1,000 with a longer timeout.
- **US3 global attributes:** settings page, campaign mapping source, insert menus in the chat
  composer and saved replies, flow editor hint; the estimate of uploaded lists also refuses empty
  values; the usage scan skips deleted agents.
- **US4 keyword replies:** text or utility template after a consent keyword, sent from the live chat
  handler once the chat exists; a `$keywordReply` marker lets an opt-out confirmation pass the
  pre-send consent rule; once a day per contact and kind; never to blocked contacts or with sending
  off.
- **US5 date automations:** due conditions as string comparisons (no casts), one occurrence per
  contact and date, a minute tick with skips, `too_late`, pausing with one admin notification, the
  send outcome on occurrences, results with the 009 replied definition, list and editor pages.
- **US6 two-factor sign-in:** RFC 6238 with node:crypto, keyed recovery codes, the `sid_2fa` pending
  sign-in, lockout after five wrong codes, required setup at sign-in, self-service, admin and operator
  resets, login steps, account and security pages, a banner.
- Batch 2 pushed for CI; batch 3 (business profile, guides, polish) next.

## Outcome

- ✅ Impact: US3 – US6 implemented test-first; MVP CI failures fixed.
- 🧪 Tests: api unit 658/658 locally; integration, contract and e2e run in CI.
- 📁 Files: listed above.
- 🔁 Next prompts: fix batch 2 CI; US7 – US8 and polish; merge question.
- 🧠 Reflection: shared-database tests need data that cannot collide and transactions sized for the
  hooks that run inside them.

## Evaluation notes (flywheel)

- Failure modes observed: circular imports hide constructor types from Nest; random phones collide in
  a shared database; interactive transactions time out when per-row hooks listen.
- Graders run and results (PASS/FAIL): local unit, tsc and eslint PASS.
- Prompt variant (if applicable): none.
- Next experiment (smallest change to try): none.
