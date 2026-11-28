# Quickstart: Contacts, Settings and Security

**Feature**: `010-contacts-settings-security` | **Date**: 2026-11-28

## 1. Run it locally

Everything from the 009 quickstart. There are no new settings:
- 2FA uses the existing `TOKEN_ENCRYPTION_KEY` for the app secrets and recovery code hashes, and
  `APP_NAME` as the name shown in authenticator apps.
- Date automations use the company time zone (Settings → General).

```powershell
docker compose up -d          # Postgres, Redis, MinIO
npm run dev:mock-meta         # mock Graph API, now with the business profile and number status
npm run dev                   # api, worker (including the new `bulk` queue) and web
```

## 2. Mock Meta

- **Business profile:** `GET` and `POST /{phone-number-id}/whatsapp_business_profile` keep a profile
  per number in memory. Fields beyond Meta's limits get Meta-style errors.
- **Number status:** `GET /{phone-number-id}?fields=…` returns `verified_name`, `name_status`
  (default `APPROVED`), `quality_rating` and `whatsapp_business_manager_messaging_limit`.
  - `POST http://localhost:4010/mock/name-status { "phoneNumberId": "<id>", "nameStatus": "DECLINED",
    "newNameStatus": null }` changes them, to try the badges.
- **Inbound CLI:** `npm run mock:inbound -- --from +971501234567 --phone-number-id <id> --text "STOP"`
  sends a keyword.

## 3. Try each story

1. **US1 Segments:**
   - Contacts → **Segments** → New: tag "customer", attribute city is "Dubai", read a message from
     campaign A, and did not reply. The counts update as you type, and a sample of 20 shows.
   - Save it. Campaigns → New → Audience → **Segment**: the estimate matches the segment's
     marketable count. Launch to it.
   - Drips → a drip → **Enrol a segment**: the bulk action shows its progress and the 005 counts.
   - Delete the tag "customer": the segment shows the broken rule and the draft campaign cannot
     launch.
2. **US2 Bulk tags, automatic tags, lead source and export:**
   - Contacts: filter, select 3 rows → **Add tags** "VIP"; then **All matching** → **Remove tags**
     "trial". The result and the audit log show the counts.
   - Settings → **Automatic tags**: lead source "Website button" → "web lead"; link click →
     "interested". Start a chat from the website button, then click a tracked link: both tags appear.
   - The contact list shows a **Lead source** column and filter. Create contacts by API, import (with
     a label), chat link and website button, and check each one's source.
   - **Export**: the CSV's rows match the count and have one column per attribute. A manager sees
     masked phones only without `phones.full`.
3. **US3 Global attributes:**
   - Settings → **Global attributes**: `support_phone`, `store_address`.
   - Use `store_address` in a campaign variable, `{global:support_phone}` in a saved reply, a flow
     message and an AI agent's instructions.
   - Change the value; new messages use it.
   - Try deleting it: the places that use it are listed.
4. **US4 Keyword replies:**
   - Settings → **Consent keywords** → *Keyword replies*: the opt-out reply is a text; the opt-in reply
     is an approved utility template.
   - Send "STOP" with the inbound CLI: the contact is opted out and the reply shows in the chat.
     Send "STOP" again: no second reply within 24 hours.
5. **US5 Date automations:**
   - Automations → New: attribute `birthday`, yearly, on the day, at the next minute, an approved
     template with `{first_name}`.
   - Seed contacts born today, tomorrow and on 29 February, and one opted out. Only today's
     opted-in contacts get it, once.
   - The results show the skipped contact with its reason.
   - Reject the template in mock-meta: the automation pauses and admins are notified.
6. **US6 2FA:**
   - **Two-factor** (top bar) → *Turn on two-factor sign-in*: scan the QR code with an authenticator
     app (or use `npm run tool:totp -w @wbm/api -- --secret <key>` to print codes), confirm, and save
     the recovery codes.
   - Sign out and in: a code is asked for. Five wrong codes lock the step for 15 minutes.
   - Settings → **Security** → *Require two-factor sign-in for every member*: a member without 2FA
     must set it up at sign-in, and members already signed in see a reminder.
   - Reset a member's 2FA: their sessions end.
7. **US7 Business profile:**
   - Settings → WhatsApp numbers → a number's **Profile**: change the about text, address, websites and category, and
     upload a square picture. The page shows Meta's values. A 3000×2000 picture is refused.
   - Set the name status to `DECLINED` in mock-meta (`POST /mock/name-status`) before opening the
     page (it keeps Meta's answer 5 minutes): the badge and the steps show.
   - Tick blue tick checklist steps and record an application date.
8. **US8 Guides:** Settings → WhatsApp numbers → **Move a number here** and **Move a number back to
   the app**: every step and warning shows, with links; removing a number asks for the number to be
   typed.

## 4. Tests

```powershell
npm run test -w @wbm/shared                         # unit: segment rules, lead source map, due dates, profile limits, guides
npm run test -w @wbm/api -- unit                    # unit: segment SQL builder, TOTP vectors, automation tick maths
npm run test:integration -w @wbm/api -- segments bulk auto-tags lead-source export global keyword automations two-factor business-profile
npm run test:contract -w @wbm/api -- contacts-settings
npm run test:e2e -w @wbm/web -- contacts-us settings-us automations-us security-us numbers-us
npm run perf:segments -w @wbm/api                   # 200,000 contacts: counts under 3 s (SC-001); CI runs it in build-test
```

Docker is not running on the development machine, so integration, contract, e2e and perf runs happen
in CI.

## 5. Before going live (release checklist, written with the tasks)

- **2FA:** require it for admins at least, and keep the operator reset command documented with the
  server runbook.
- **Business profile:** change the real profile once and see it on a phone. Confirm the picture
  limits Meta accepts.
- **Date automations:** approve the birthday template, and check the company time zone.
- **Keyword replies:** approve the utility template for the opt-in reply, if one is used.
- **Guides:** re-check the migration guides and the blue tick steps against Meta's pages (their
  `checkedAt` dates).
