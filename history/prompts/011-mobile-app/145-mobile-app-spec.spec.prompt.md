---
id: 145
title: Mobile App Spec
stage: spec
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 011-mobile-app
branch: 011-mobile-app
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "mobile", "pwa", "push", "offline", "live-chat"]
links:
  spec: specs/011-mobile-app/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/011-mobile-app/spec.md
 - specs/011-mobile-app/checklists/requirements.md
tests:
 - none (specification); the quality checklist passed after one round of fixes
---

## Prompt

Installable mobile app for the team (inventory item 12.4, "installable web app with push first"): members install the platform on Android and iOS home screens and work on the go - live chat optimized for phones (chat list, a chat with the composer, saved replies, templates, media, notes, take over/resolve/transfer), push notifications for new chats, messages, chats waiting for an agent and assignments (the 002 Web Push, also on iOS home screen apps), an app shell that opens fast and shows a clear offline state, quick views of campaigns, drips, ads and AI agents with their key results, starting a broadcast from a template, contacts lookup with call and WhatsApp actions, and the device's contacts optionally imported as contacts with consent. Same accounts, roles, 2FA and permissions as the web app; no separate backend.

(The user chose "Mobile app shuru karo (Recommended)" after 010 was merged.)

## Response snapshot

- Branch `011-mobile-app` and `specs/011-mobile-app/spec.md`.
- 7 stories: install and sign in (P1), live chat on phones (P1), alerts with kinds and hidden text
  (P1), fast start and a read-only offline state (P2), quick views with pause and resume (P2), a
  broadcast from a template (P2), contacts on the go with phone contact import and consent (P3).
- 32 functional requirements, 9 measurable success criteria, assumptions (iPhone alerts need the
  home screen; contact picking only where the browser offers it, vCard otherwise; offline is
  read-only), out of scope (store apps, offline sending, phone-sized heavy editors).
- No clarifications needed; the quality checklist passed after replacing an internal permission name
  and making "slow connection" measurable.

## Outcome

- ✅ Impact: the mobile app is specified and ready for planning.
- 🧪 Tests: none (spec stage).
- 📁 Files: spec and requirements checklist.
- 🔁 Next prompts: /sp.plan for 011.
- 🧠 Reflection: the existing 002 service worker and alert devices make an installable app a
  natural extension; the iPhone home-screen rule shapes the alerts story.

## Evaluation notes (flywheel)

- Failure modes observed: none.
- Graders run and results (PASS/FAIL): spec quality checklist PASS.
- Prompt variant (if applicable): none.
- Next experiment (smallest change to try): none.
