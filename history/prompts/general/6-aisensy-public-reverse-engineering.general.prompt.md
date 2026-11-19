---
id: 6
title: AiSensy Public Reverse Engineering
stage: general
date: 2026-11-16
surface: agent
model: claude-opus-5-5
feature: none
branch: main
user: Muhammad Yaseen
command: none (free-form prompt)
labels: ["reverse-engineering", "competitive-analysis", "aisensy", "whatsapp", "osint-passive", "blueprint"]
links:
  spec: null
  ticket: null
  adr: null
  pr: null
files:
 - docs/research/aisensy/aisensy-reverse-engineering.md
 - docs/research/aisensy/build-blueprint.md
 - docs/research/aisensy/evidence/pricing-2026-11-16.json
 - docs/research/aisensy/evidence/tech-fingerprint-2026-11-16.txt
 - docs/research/aisensy/evidence/sitemap-urls-2026-11-16.txt
 - history/prompts/general/6-aisensy-public-reverse-engineering.general.prompt.md
tests:
 - pricing-2026-11-16.json parses as valid JSON (6 plans)
 - sitemap evidence file contains 735 URLs
 - IP ownership confirmed via ARIN RDAP (Amazon.com, Inc.)
---

## Prompt

https://aisensy.com/

is websitee ko full reverse engineering karoooo 
full effort lagaooo full is website ko reverse engineering karooooo

(follow-up message in the same turn, verbatim: "continue")

## Response snapshot

Did a passive, public-surface reverse engineering of aisensy.com in about 35 requests; robots.txt allows everything. Sources covered:
- HTTP headers and public DNS (plus ARIN RDAP for the site IP)
- sitemap (735 URLs) and about 25 key pages: pricing in INR and USD, features, AI agents, chatbot, partner, integrations, onboarding, terms, privacy
- public Campaign API docs on Intercom
- response headers of the app, free-tools and help subdomains

Found that AiSensy's Terms prohibit reverse-engineering their software and running scrapers. So: no login, no decompiling of the web or mobile app, no bulk crawl, and no probing of their APIs.

Key findings:
- Stack: Umso marketing site (Webflow before); React CRA web app on S3 + CloudFront; Chargebee billing; Arengu forms; Intercom help center; Stoplight/Postman docs; API host backend.aisensy.com; Google Workspace, with Brevo/SES/SendGrid for email.
- Pricing: five tiers, Basic ₹1,500 to Unlimited ₹45,000/mo ($45–$899). Plans differ by speed (40/250/1,000 msg/s), seats, tag/attribute/segment caps and webhooks. Add-ons: chatbot builder ₹2,500/mo, AI agent ₹1,350/mo. Message wallet (WCC) at ₹1.09 marketing and ₹0.145 utility/auth/service.
- Products: full map covering onboarding via Embedded Signup, CRM, templates, broadcast and retargeting, click tracking, inbox states, flow-builder blocks, AI Agent Studio, AI Suite, ads manager, payments (Razorpay/PayU), integrations, mobile apps.
- Growth engine: programmatic SEO across 13 languages, 6 competitor pages, free tools, and an affiliate / white-label / API partner program.

Wrote a research report plus an original build blueprint. The blueprint covers inferred architecture (mermaid), the access-model options, suggested stack, data model, acceptance-checked flows, phased roadmap, risks and differentiation ideas. Evidence files were saved too.

Surfaced an ADR suggestion for the WhatsApp access model.

## Outcome

- ✅ Impact: Evidence-backed competitive teardown plus a buildable blueprint, usable as input to /sp.specify.
- 🧪 Tests: JSON validity, sitemap count, RDAP ownership check.
- 📁 Files: 5 files under docs/research/aisensy/ plus this PHR.
- 🔁 Next prompts: /sp.adr whatsapp-access-model; /sp.specify for the P1 MVP.
- 🧠 Reflection: The pricing plans were in inline JS rather than visible text, so the raw HTML had to be parsed. The Terms check shaped the scope.

## Evaluation notes (flywheel)

- Failure modes observed: in PowerShell, `$_` inside a switch block shadows the pipeline variable (fixed with an explicit loop variable). The Stoplight docs URL returns 404.
- Graders run and results (PASS/FAIL): JSON parse PASS; sitemap count PASS; RDAP PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): Turn blueprint sections 4–6 into a spec via /sp.specify.
