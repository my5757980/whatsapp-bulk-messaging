---
id: 139
title: Contacts Settings Security Spec
stage: spec
date: 2026-11-28
surface: agent
model: claude-opus-5-5
feature: 010-contacts-settings-security
branch: 010-contacts-settings-security
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "segments", "tags", "lead-source", "global-attributes", "keyword-replies", "date-automations", "2fa", "business-profile"]
links:
  spec: specs/010-contacts-settings-security/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/010-contacts-settings-security/spec.md
 - specs/010-contacts-settings-security/checklists/requirements.md
tests:
 - none (specification only); quality checklist passed on the first validation run after two fixes
---

## Prompt

achaa jab taak short mayy mujayyy ya batoooo project kitnaaa % mukaamal hogayssaaaa haiiiiii or kitnaaa kia kiaa baaqi haiii

sahiii haiii to sab kuch pooraaa flowww verfication live tak tum hi sab guide karooo gayyy abhiii ya kaam jaldieee completee karooooo or agayy kaam continue karoooo

(Earlier in the same exchange the user chose, through Claude's question: merge 009 when CI is green, and build "Contacts, settings, security" next. Claude then ran /sp.specify with this description:)

Contacts, settings and security (AiSensy inventory items 1.3, 1.4, 1.6, 2.3, 3.2, 3.3, 3.5, 3.8, 3.9, 3.10 and 5.11). Saved segments (lists) built from tags, attributes, consent, lead source and behaviour (delivered, read, replied, clicked, failed, from campaigns), with live counts, usable as audiences for campaigns, drips and retargeting. A full contacts export (CSV, the current filter or a segment, phones masked by role, audited). Bulk add and remove tags on selected or filtered contacts, and automatic tags (first message, API, broadcast, import). A lead source on every contact (organic, API, import label, chat link, ad, form, website button), shown and filterable. Global attributes: company-wide values (for example the support phone or store address) usable as template variables, in messages, flows and AI replies. Opt-in and opt-out keyword automation: up to 5 keywords each, with a reply chosen as text or an approved template. Date automations such as birthdays: any date attribute, a send time in the company time zone, skip opted-out contacts, a chosen approved template, and results. Two-factor authentication for team logins (an authenticator app with recovery codes; admins can require it for everyone). Editing the WhatsApp Business profile (logo, description, address, email, category, websites) through Meta, with the display name status and a guided Blue Tick (official business account) application checklist. In-app guides for moving a number from another provider and for moving it back to the WhatsApp Business app. Same features and flows as AiSensy's public docs, with our own design and wording.

continue

(After /model and /effort, once the session restarted.)

## Response snapshot

- Told the user the progress: about 80% of the AiSensy-equivalent features (about 78 of 98 applicable inventory rows). Listed what remains: 010, the mobile app, small optional items, and the go-live steps that need the company (Meta verification, number, server, domain, Stripe, Anthropic key, template approvals). Agreed to guide the whole go-live flow later; saved this in memory.
- Created branch 010-contacts-settings-security from main and wrote the spec. It has 8 stories:
  - US1 saved segments with behaviour rules as campaign and drip audiences (P1)
  - US2 bulk tags, automatic tag rules, lead source set at creation, contacts export (P1)
  - US3 global attributes (P2)
  - US4 keyword replies for opt-in and opt-out (P2)
  - US5 birthday and other date automations (P2)
  - US6 two-factor authentication with recovery codes and a company requirement (P2)
  - US7 the business profile, display name status and a blue tick checklist (P3)
  - US8 guides for moving a number in and out (P3)
- The spec has 37 requirements and 8 success criteria. It records what already exists (lead source field, keyword lists, quality rating and limit), so those parts are extended, not rebuilt.
- Validation: keyword replies may use utility templates only; the keyword limit stays 20 per list. No clarifications were needed.

## Outcome

- ✅ Impact: 010 spec ready for /sp.plan; 009 waits for its last e2e run before merging.
- 🧪 Tests: none (specification); the quality checklist passes.
- 📁 Files: spec.md and checklists/requirements.md.
- 🔁 Next prompts: merge 009 when CI is green, then /sp.plan for 010.
- 🧠 Reflection: checking the schema first (lead source, keyword lists, number fields) kept the spec from asking to rebuild things that exist.

## Evaluation notes (flywheel)

- Failure modes observed: none in the spec; the inventory still shows the 002/003 rows as missing, to correct when it is next updated.
- Graders run and results (PASS/FAIL): spec quality checklist PASS.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): null
