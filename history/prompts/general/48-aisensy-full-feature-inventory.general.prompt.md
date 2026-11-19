---
id: 48
title: AiSensy Full Feature Inventory
stage: general
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: none
branch: 002-team-inbox
user: Muhammad Yaseen
command: none
labels: ["research", "aisensy", "feature-parity", "roadmap"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - docs/research/aisensy/feature-inventory-2026-11-19.md
tests:
 - none (research)
---

## Prompt

nahiii achaaa bat sunooo phalayy meriii is bar aik dafaa phir full effort lagooo reverse engineering karooo websitee ko poora flow aik aik feature kuch miss galat nahiii honaa chiyaaa is bar poora flow same jasayy wo website work kartii haii aik aik feature same kuch misss nahiii bar bar tum ko thorii boluu gaaa ya ya ya add karoooo poora mukaaam mal karoooo full effort lagoo confirm karooo phir shuruu kartayyy haiiii

## Response snapshot

- **Method:** public-source research only (no login, scraping or decompiling, per AiSensy's Terms).
  - Used the captured sitemap of 735 URLs (30 feature pages, 113 tutorials).
  - Read 31 public pages in detail: pricing, live-chat settings, agent rules, chat profile, bot handoff, history page, canned messages, auto replies, notifications, blocking, broadcasting, click tracking, retargeting, automation, QR campaigns, birthday automation, payments, catalog, forms, webviews, ads manager, AI agents, AI assistant, API docs, website chat button, failed retries, first-message tags, business profile, opt-in/out, Shopify, coexistence and carousel templates.
- **Output:** `feature-inventory-2026-11-19.md` lists 102 capabilities in 12 modules. Each has the documented flow, our status (13 built, about 17 partial, 68 missing, 4 not applicable) and a planned feature.
- **Roadmap to full functional parity:**
  - 002 live chat (aligned to AiSensy's Active/Requesting/Intervened/Resolved and History model)
  - 003 contacts, settings and security
  - 004 templates and campaign growth
  - 005 chatbot builder
  - 006 commerce, forms and payments
  - 007 AI agent and suite
  - 008 integrations and developer platform
  - 009 ads manager
  - 010 mobile installable app
- **Meta-dependent items** called out: verification, Blue Tick, ads account, and payments, which are country-limited and not available in the UAE.
- **Asked the user to confirm** before starting; on confirmation, the 002 spec is revised to the AiSensy live-chat model.

## Outcome

- ✅ Impact: A complete, sourced parity checklist, so features won't be missed piecemeal.
- 🧪 Tests: none
- 📁 Files: docs/research/aisensy/feature-inventory-2026-11-19.md
- 🔁 Next prompts: the user confirms; revise the 002 spec; then `/sp.plan` for 002
- 🧠 Reflection: Parity is defined as documented behaviour with original design. Undocumented internals are defaults, not claims of "identical".

## Evaluation notes (flywheel)

- Failure modes observed: the webhook reference URL returned 404 and the event names are unpublished, so we will design our own event names.
- Graders run and results (PASS/FAIL): N/A
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): N/A
