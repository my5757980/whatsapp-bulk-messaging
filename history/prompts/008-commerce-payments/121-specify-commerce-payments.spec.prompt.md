---
id: 121
title: Specify Commerce Payments
stage: spec
date: 2026-11-25
surface: agent
model: claude-opus-5-5
feature: 008-commerce-payments
branch: 008-commerce-payments
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "payments", "stripe", "catalog", "whatsapp-forms", "commerce"]
links:
  spec: specs/008-commerce-payments/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/008-commerce-payments/spec.md
 - specs/008-commerce-payments/checklists/requirements.md
tests:
 - none (specification)
---

## Prompt

haaaa

(The user's yes to starting payments next. Claude ran /sp.specify with this description:)

Commerce and payments over WhatsApp (feature 008), following the AiSensy inventory row "Commerce, forms and payments" (items 3.13, 4.8, 6.12, 7.4, 8.1-8.4 and 11.8; 8.5 webviews optional). The company sells to customers in the UAE; Meta's native WhatsApp Payments is not offered in the UAE, so customers pay through payment links from the company's own payment gateway account. Scope: (1) Payment requests: make a payment link (amount, currency, description, expiry, optional order reference) and send it from live chat, a flow step, a campaign, an API call or a store order; track pending, paid, failed, expired and refunded through the gateway's signed webhooks; a payment history on the contact profile and in the journey; reminders to people who have not paid and retargeting of non-payers; a payments page with totals; outbound webhook events for payment changes. (2) Meta catalog: connect the WhatsApp account's Meta catalog (or fill it from the 006 Shopify/WooCommerce stores), browse products, send single-product, multi-product and catalog messages from live chat, flows and templates (multi-product templates), and turn carts that customers send in chat into orders with a payment link. (3) WhatsApp Forms (Meta WhatsApp Flows): build multi-step in-chat forms (text, choices, dates), publish them to Meta, send them from live chat, flows and templates, and save answers to contact attributes and tags and the 006 outbound webhooks. (4) Commerce steps in the 003 flow builder: product, catalog, payment request and form steps. Card data never touches the platform (payment pages belong to the gateway). Reuse 001-007 patterns: test-first, mock gateway and mock-meta routes, encrypted credentials, audit entries, roles, retention and erasure.

## Response snapshot

- Branch `008-commerce-payments` and `specs/008-commerce-payments/spec.md`.
- **Eight stories:**
  - US1 connect the gateway (P1)
  - US2 a payment request in live chat (P1)
  - US3 payment requests from flows, campaigns, the API and store orders (P1)
  - US4 reminders, non-payers and the payments page (P2)
  - US5 the Meta catalog and product messages (P2)
  - US6 carts into chat orders with a payment link (P2)
  - US7 WhatsApp Forms (P3)
  - US8 commerce steps in the flow builder (P3)
- **The rest of the spec:**
  - FR-001 to FR-045 and SC-001 to SC-008
  - edge cases, assumptions, out of scope and dependencies
- **One clarification**, answered by the user: the gateway is **Stripe**. It is recorded under Clarifications and in FR-001.
- The quality checklist passes 16 of 16.

## Outcome

- ✅ Impact: 008 is specified and ready for planning.
- 🧪 Tests: none at this stage.
- 📁 Files: spec.md and checklists/requirements.md.
- 🔁 Next prompts: /sp.plan (research Stripe payment links and webhooks, the catalog Graph calls, WhatsApp Flows).
- 🧠 Reflection: native WhatsApp Payments is not available in the UAE, so the design centres on the gateway's hosted page; card data stays out of the platform.
