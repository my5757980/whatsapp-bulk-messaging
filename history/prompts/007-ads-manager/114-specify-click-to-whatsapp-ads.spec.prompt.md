---
id: 114
title: Specify Click To WhatsApp Ads
stage: spec
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 007-ads-manager
branch: 007-ads-manager
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "ads", "click-to-whatsapp", "meta-marketing", "lead-forms", "audiences"]
links:
  spec: specs/007-ads-manager/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/007-ads-manager/spec.md
 - specs/007-ads-manager/checklists/requirements.md
tests:
 - none (specification)
---

## Prompt

achaaa abhiii ya hojayyy jab is ka result ajayy to is kayy bad khoshisi karnaaa agayy kaaaaa kaam jaldieee complete karoooo speed barhoooo ok

(After PR #8 merged, the next roadmap feature was started with /sp.specify and this description:)

Feature 007: Click-to-WhatsApp ads and the ads manager (AiSensy inventory items 10.1-10.4 and the text part of 9.7; public information only, our own design and wording). Managers run Meta ads from the platform with the company's own ad account, paid directly to Meta (no ad credits). Admins connect the ad account and Facebook page once (system user token, checked like the number wizard). Ad types: Click-to-WhatsApp ads that open a chat with one of our numbers with a pre-filled message (the main type), plus website and lead-form ads where Meta allows them. A guided builder: objective, audience (locations, age, gender, interests, and custom audiences made from our contact tags or campaign results, plus lookalikes of them), placements (automatic or chosen), daily budget and start/end dates, creative (upload image or video, primary text, headline, call to action), with optional AI-drafted ad text from the existing AI assistant. Submit to Meta, then track review and delivery status (in review, active, rejected with the reason, paused, ended); pause, resume, change budget or end date, and duplicate. Reporting synced from Meta per ad and per campaign: impressions, reach, clicks, CTR, CPC, spend, plus our own chats started, new contacts, replies and cost per chat. Chats that start from an ad carry the ad (Meta referral data), show it in live chat, and use Meta's free 72-hour window for ad chats where it applies; a flow can start when a chat comes from a chosen ad (ad trigger in the flow builder). Lead-form leads become contacts with their consent answer, tagged by form. Out of scope: AI image or video generation, WhatsApp Status ads if Meta does not offer them through the API, buying ad credits, other ad networks. Permissions: admins connect accounts, managers build and run ads, agents see results. Audit, retention and privacy as in earlier features.

## Response snapshot

- PR #8 (the retry rounds fix) passed every CI job and was merged to main (cdb6332).
- Created branch `007-ads-manager` and `specs/007-ads-manager/spec.md`:
  - **Stories:** P1 connect the ad account and page with checks; P1 launch a Click-to-WhatsApp ad with a guided builder and Meta review tracking; P1 handle chats from ads (ad shown in live chat and the journey, the free ad window, an ad flow and tag); P2 results; P2 managing ads and a monthly spending cap; P2 audiences from contacts and lookalikes; P3 lead forms; P3 website ads and AI-drafted texts.
  - **Requirements:** 44 FRs, 7 SCs.
  - **No clarification markers.** The choices are in Assumptions: one ad account and page, and one ad set per campaign with up to five versions.
- Quality checklist: all items pass.

## Outcome

- ✅ Impact: the 007 spec is ready for planning.
- 🧪 Tests: none (spec).
- 📁 Files: spec.md, checklists/requirements.md.
- 🔁 Next prompts: /sp.plan (research Meta's ads, leads and referral details), then /sp.tasks and /sp.implement.
- 🧠 Reflection: a detailed user description let the spec skip clarifications, which keeps the speed the user asked for.
