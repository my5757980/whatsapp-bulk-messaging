# AiSensy Feature Inventory vs Our Platform (2026-11-19)

**Goal:** list every AiSensy capability that public sources show, with the documented flow, and map each one to our platform. Then plan the features still missing, so that functional parity is complete.

**Method and boundaries:**
- Public sources only: the sitemap of 735 public URLs captured on 2026-11-16 (30 feature pages, 113 tutorials, product, integration and pricing pages), plus 31 pages read on 2026-11-19 (sources at the end).
- No logging in, decompiling, scraping or API probing. AiSensy's Terms forbid them.
- We match **behaviour and flow, with our own design and wording**. Constitution Principle II forbids copying their screens, text or assets.
- Where a page leaves a detail out, we choose a sensible default and mark it "default". Nothing undocumented is claimed as "identical".

**Status legend:**
- ✅ built (features 001, 002 and 003)
- 🟡 partly built
- ❌ missing
- ➖ not applicable to a single company running its own WhatsApp account

---

## 1. Account, numbers and WhatsApp setup

| # | AiSensy capability (documented flow) | Our status | Planned in |
|---|---|---|---|
| 1.1 | Connect a WhatsApp Business number (they use Meta "Log in with Facebook" Embedded Signup; needs Meta Tech Provider status) | 🟡 We connect by pasting the WABA ID, phone number ID and system-user token. This works for one company and needs no partner status. | Integrations adds a guided connect wizard. Embedded Signup only if the company becomes a Tech Provider ➖ |
| 1.2 | Quality rating and messaging-limit tier (250 → 2K → 10K → 100K → unlimited) shown, with upgrade guidance | ✅ Quality, tier and quality webhooks; upgrade guidance text 🟡 | Contacts & settings (guidance) |
| 1.3 | Edit the WhatsApp Business profile: logo (640×640, ≤5 MB), description (≤256), address (≤256), email, vertical/category, website. Owner only. | ❌ | Contacts & settings |
| 1.4 | Display-name verification status, and a free Blue Tick (official business account) application guide | ❌ | Contacts & settings (status display and a step-by-step guide; Meta decides) |
| 1.5 | Coexistence: the same number used in the WhatsApp Business app and the API, with 6 months of 1:1 chat history synced (beta, partner-enabled) | ➖ Partner-only onboarding today | Revisit if available to direct Cloud API users |
| 1.6 | Migrating from another provider, and downgrading back to the app (guides) | ❌ docs only | Contacts & settings (docs) |
| 1.7 | Virtual numbers, sold by AiSensy | ➖ A vendor service | – |

## 2. Team, security and settings

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 2.1 | Roles: owner/admin, manager, agent; invite and remove agents | ✅ admin, manager and agent; invitations; deactivation | – |
| 2.2 | Number masking for agents (last 4 digits) | ✅ | – |
| 2.3 | Two-factor authentication for team logins | ❌ | Contacts & settings |
| 2.4 | Agent rules: an agent sees and resolves only chats whose contact matches tag or attribute values (for example tag "Demo", or Industry = Ecommerce) | ❌ | 002 |
| 2.5 | Notification preferences: sound on/off; browser push on up to 5 devices (add, remove, pause) | 🟡 We have an in-app notification bell only | 002 |
| 2.6 | Audit trail | ✅ We go further: a full audit log | – |

## 3. Contacts and audience

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 3.1 | Unlimited contacts; CSV import with column mapping; add a single contact | ✅ | – |
| 3.2 | Export contacts | 🟡 We export campaigns; a full contact export is missing | Contacts & settings |
| 3.3 | Tags (manual) plus automated tags for first message, API and broadcast; bulk add/remove tags on selected contacts | 🟡 Manual tags work; automated tag types and bulk tag management are missing | Contacts & settings |
| 3.4 | Custom attributes (typed), editable from the profile | ✅ | – |
| 3.5 | **Global attributes**: project-wide values usable in templates and messages | ❌ | Contacts & settings |
| 3.6 | Fallback values for attributes used in templates | ✅ in variable mapping | – |
| 3.7 | **First Message tags**: a tag with category "First Message" and a list of phrases. Exact-match phrases auto-tag a contact on their first message. Pre-filled messages from links, QR codes and widgets drive it. | ✅ First-message rules set the tag on a contact's first message and can start a flow (003); links and QR codes not yet | 003 Flow builder (QR in Integrations) |
| 3.8 | Lead source: Organic, API, or a custom label on import | 🟡 Consent source exists; lead source is missing | Contacts & settings |
| 3.9 | **Segments / lists**: saved audiences built from tags, attributes, campaigns and behaviour (read, replied, clicked) | 🟡 We have per-campaign filters; saved segments and behaviour filters are missing | Contacts & settings |
| 3.10 | Opt-in/opt-out keyword automation: up to 5 keywords each, configurable response message (template or regular) | 🟡 Keywords work; configurable response messages and the keyword limit need checking | Contacts & settings |
| 3.11 | **Block a contact** ("block all messages"): stops their incoming messages; you can still message them | ❌ | 002 |
| 3.12 | Contact deletion | ✅ with anonymisation | – |
| 3.13 | Payment history on the contact profile | ❌ | Commerce |

## 4. Templates

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 4.1 | Create and submit marketing, utility and authentication templates; approval status sync (1 min–24 h) | 🟡 Marketing and utility work. Authentication (OTP) templates are refused by our editor. | Templates & growth |
| 4.2 | Text, media (image/video/document) headers; quick-reply, URL (dynamic) and call buttons; variables | ✅ | – |
| 4.3 | **Carousel templates**: up to 10 cards, each with an image or video and a card body; per card 2 buttons max (2 CTA, 2 quick replies, or 1+1); media attached when sending | ❌ | Templates & growth |
| 4.4 | **Limited-time offer** templates (offer expiry countdown) | ❌ | Templates & growth |
| 4.5 | **Authentication / OTP templates** with copy-code button and automation | ❌ | Templates & growth |
| 4.6 | **Template TTL**: stop delivery attempts after a time window | ❌ | Templates & growth |
| 4.7 | Media-link templates (media from a URL) | 🟡 We upload media; sending media by URL is missing for campaigns | Templates & growth |
| 4.8 | Catalog / product templates (multi-product) | ❌ needs a catalog | Commerce |
| 4.9 | Sample template library (100+ samples by industry) | ❌ We will write our own originals | Templates & growth |
| 4.10 | AI template generator | ❌ | AI agent |
| 4.11 | Template guidelines and broadcast error meanings (help content) | 🟡 Error reasons are shown; guidelines are missing | Templates & growth |

## 5. Broadcasts and campaigns

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 5.1 | Bulk broadcast to a CSV upload or filtered contacts; personalisation | ✅ | – |
| 5.2 | Scheduler, up to 2 months ahead, time-zone aware | ✅ (no 2-month cap; time zones supported) | – |
| 5.3 | Option to message duplicate numbers in a CSV | ❌ We always dedupe (one per contact) | Templates & growth (option) |
| 5.4 | Throughput per number (their plans: 40–1,000 msg/s) | ✅ Up to 80 msg/s per number (Meta's default). Higher only if Meta upgrades the number. | – |
| 5.5 | **Failed retries**: a "Retry Campaign" toggle per broadcast, up to 3 retries with set delays, all within 24 h; a "Scheduled Retries" section | 🟡 We retry transient errors automatically (3×). A user-configured retry of failed messages is missing. | Templates & growth |
| 5.6 | Campaign analytics: sent, delivered, read, replied, clicked, failed with reasons; budget and cost | 🟡 Replied and clicked are missing | 002 (replied) and Templates & growth (clicked) |
| 5.7 | **Retargeting** by Read, Replied, Clicked, Delivered (from the campaign tabs) | 🟡 We support failed and not-read. Replied, clicked and delivered are missing. | Templates & growth |
| 5.8 | **Click tracking**: URL CTA buttons only; "Clicked" tab with per-user click counts; one-tap retarget of clickers | ❌ | Templates & growth |
| 5.9 | **API campaigns**: a named "Live" campaign bound to one template, triggered by API with params, media, tags and attributes; auto-creates contacts | 🟡 Our public API sends a template directly, with idempotency and rate limits. Named API campaigns, and tags/attributes on API calls, are missing. | Integrations |
| 5.10 | **QR code campaigns**: name, pre-filled message, optional linked flow; "Set Live and generate QR"; download the QR or a printable standee; track Scanned → Replied leads, then export, broadcast or tag them | ❌ | Templates & growth |
| 5.11 | **Birthday automation**: a date-of-birth attribute; a toggle with send time; "skip opted-out"; a chosen template; analytics. Default: any date attribute. | ❌ | Contacts & settings |
| 5.12 | **Drip sequences**: time-based follow-ups after an action | ❌ | Integrations |
| 5.13 | Campaign reports download (campaign, user, overview, opt-in/opt-out) | 🟡 Campaign export works; overview and opt-in/out reports are missing | Templates & growth |
| 5.14 | Meta frequency capping awareness (marketing messages limited per user) | 🟡 Errors are shown; an explanation is missing | Templates & growth |

## 6. Live chat (team inbox)

| # | Capability (documented flow) | Our status | Planned in |
|---|---|---|---|
| 6.1 | Shared inbox: many agents on one number, real time | ❌ (spec drafted) | 002 |
| 6.2 | **Chat states**: Active (bot handling or new), Requesting (needs a human), Intervened (an agent took over; only that agent sees it), Resolved/Closed (back to the bot) | ❌ | 002 (spec to be aligned) |
| 6.3 | **Intervene** and **Resolve** actions; resolving hands the chat back to the bot | ❌ | 002 |
| 6.4 | **History**: a chat moves to History 24 h after the user's last message. Agents can't reply there, but can **Send Template** to restart; the chat returns to Active when the user writes. | ❌ | 002 |
| 6.5 | **Auto-resolve** after 24 h of inactivity (toggle), so chats aren't stuck with absent agents | ❌ | 002 |
| 6.6 | Manual transfer between agents; manager monitoring | ❌ | 002 |
| 6.7 | Agent rules (2.4) limit which chats an agent sees | ❌ | 002 |
| 6.8 | Smart filters by tags, campaigns and attributes | ❌ | 002 |
| 6.9 | **Canned messages**: name; type text or media (up to 4,096 chars; *bold*/_italic_); variables ($FirstName, $Name, $MobileNumber, $LastName, custom attributes, and {{1}} filled at send); media from a URL or the media library; personal favourites; insert with "/" or the bookmark icon; max 200 | ❌ | 002 |
| 6.10 | **Welcome and off-hours messages**: welcome inside working hours, off-hours outside; template or regular text/image/file; time zone; hours per weekday | ❌ | 002 |
| 6.11 | **Chat profile panel**: status, last active, template and session message counts, unresolved queries count, source (Organic/API/custom), first-message tag (editable), campaigns with read ticks, attributes (editable), tags (add/create), **customer journey** (timestamped log of interventions, tag changes, campaigns) | ❌ | 002 |
| 6.12 | Send payment requests, catalog items and forms from live chat | ❌ | Commerce |
| 6.13 | Notification preferences (2.5) and push notifications | ❌ | 002 |
| 6.14 | Media library (reusable uploaded media) | 🟡 Media assets exist; a library screen is missing | 002 |

## 7. Chatbot flow builder

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 7.1 | Build by drag-and-drop canvas, from a template (60+ by industry), or with an AI generator from a prompt | 🟡 Canvas and 6 starter flows of our own (003); an AI generator is not built | 003 Flow builder (AI generator in AI agent) |
| 7.2 | **Triggers**: keywords, regex, template-message buttons, QR codes, Click-to-WhatsApp ads | 🟡 Keywords, patterns (regex), template quick-reply buttons and first-message rules (003); QR codes and ads not yet | 003 Flow builder (QR in Integrations, ads in Ads) |
| 7.3 | **Message nodes**: text/media, reply buttons, list menus | ✅ (003) | 003 Flow builder |
| 7.4 | **Commerce nodes**: product cards, catalog, cart, payments, native forms | ❌ | Commerce |
| 7.5 | **Logic**: save answers to attributes; conditions; API request (live data such as order status); time delay; timeout fallback; fallback reply for unknown input | ✅ Questions with validation and retries, attributes, tags, conditions, safe API calls with secrets, delays, timeouts and invalid-answer branches (003) | 003 Flow builder |
| 7.6 | **Request Intervention** node: hands off to live chat (Requesting state) with history | ✅ Hand-over step (003) | 003 Flow builder (with 002) |
| 7.7 | Test on up to 3 test numbers, then set the flow Active | ✅ Up to 3 test numbers run the draft; versions and restore (003) | 003 Flow builder |
| 7.8 | Connect an existing Google Dialogflow bot | ❌ optional | Integrations |

## 8. Commerce: catalog, payments, forms, webviews

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 8.1 | **Catalog**: connect a Meta catalog ("Connect Catalog" / "Manage Catalog"), up to 500 products; products from Shopify | ❌ | Commerce |
| 8.2 | Product and catalog messages; cart; orders placed in chat | ❌ | Commerce |
| 8.3 | **WhatsApp Payments**: Razorpay, PayU and others; UPI, cards and net banking; payment messages from broadcast, live chat or a flow; pending vs paid tracking; retarget non-payers; payments dashboard. Only in India, Brazil and Singapore. | ❌ | Commerce (country-limited; payment links as the alternative elsewhere) |
| 8.4 | **WhatsApp Forms** (Meta WhatsApp Flows): multi-step in-chat forms with buttons, quick replies and text inputs; responses to attributes, CRM or webhook | ❌ | Commerce |
| 8.5 | **Webviews**: web pages and landing pages opened inside WhatsApp | ❌ | Commerce |

## 9. AI

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 9.1 | **AI Agent Studio**, 7 steps: business info and instructions → tone/personality/guardrails → skills → knowledge (website crawl, PDF/DOCX uploads) → test (3 numbers) → publish | ❌ | AI agent |
| 9.2 | Agent skills: tool calling to any REST API with dynamic variables; replies with buttons, media or lists; long-term memory; escalation rules to a human | ❌ | AI agent |
| 9.3 | Agent library: prebuilt agents (sales, support, booking, lead qualification, returns, KYC, admissions…) | ❌ We will write our own | AI agent |
| 9.4 | AI message metering (1 reply = 1 AI message), with a usage dashboard | ❌ | AI agent |
| 9.5 | **AI Assistant**: dashboard copilot for contacts, templates, broadcasts, ads, flows and reports, with a confirmation preview before sending, spending or deleting | ❌ | AI agent |
| 9.6 | AI template generator, AI flow generator, AI campaign agent | ❌ | AI agent |
| 9.7 | AI ads agent, AI ad creative generator, AI video ad generator | ❌ | Ads |

## 10. Ads manager

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 10.1 | Click-to-WhatsApp, website, lead-form and WhatsApp Status ads | ❌ | Ads |
| 10.2 | Objective, audience (location, age, gender, interests, lookalikes, customer lists, website visitors), placements, daily budget and duration, creative (upload or AI) | ❌ | Ads |
| 10.3 | Meta approval tracking (about 15–20 min); reporting (impressions, reach, clicks, CTR, CPC, spend) | ❌ | Ads |
| 10.4 | Free 72-hour messaging window for chats started from CTWA ads; ad-to-flow triggers | ❌ | Ads (with 003 Flow builder) |
| 10.5 | Ad credits sold by AiSensy | ➖ We would pay Meta directly from the company's ad account | – |

## 11. Developer platform and integrations

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 11.1 | Template message API (send) | ✅ Public API v1 with keys, idempotency and rate limits | – |
| 11.2 | Project APIs: contacts, tags, attributes and more | ❌ | Integrations |
| 11.3 | **Outbound webhooks**: message and status events pushed to your backend, with events chosen by toggles | ❌ | Integrations |
| 11.4 | Shopify: abandoned cart (up to 3 reminders), order confirmed/fulfilled/delivered/cancelled, COD confirmation and status, payment reminders, feedback, reorder; per-flow metrics | ❌ | Integrations |
| 11.5 | WooCommerce, OpenCart | ❌ | Integrations (WooCommerce; OpenCart optional) |
| 11.6 | Zapier, Pabbly, Integrately, viaSocket ("2000+ apps") | ❌ | Integrations (webhooks and API cover Zapier, Pabbly, Make and n8n) |
| 11.7 | CRMs and engagement tools: WebEngage, CleverTap, MoEngage, LeadSquared, Kylas, Superleap and others | ❌ | Integrations (generic webhooks/API; named connectors on request) |
| 11.8 | Razorpay and PayU payment notifications | ❌ | Commerce |

## 12. Growth tools and apps

| # | Capability | Our status | Planned in |
|---|---|---|---|
| 12.1 | **Website chat button / widget**: number, colour, CTA text, position, margins, corner radius, pre-filled message, widget brand name, image and greeting, per-URL settings; "Generate Snippet" | ❌ | Templates & growth |
| 12.2 | WhatsApp link and QR generator | ❌ | Templates & growth |
| 12.3 | Website popup builder, pricing calculator, free AI tools (lead magnets) | ➖ Their marketing tools; a link/QR/widget generator covers our use | – |
| 12.4 | Android and iOS apps: live chat with push, broadcasts, drip, ads, contact sync, templates, AI agents | ❌ | Mobile (installable web app with push first) |

## 13. Commercial items that do not apply to us ➖

- Subscription plans, trials, seats pricing and the plan limits matrix
- Wallet and prepaid message credits: Meta bills the company directly, and our rate card estimates cost
- Reseller, white-label and partner commission programs
- Multi-tenant projects for many customer companies
- Embedded Signup and coexistence, which need Meta partner status

---

## Roadmap to full functional parity

Feature numbers follow the order specs are started. 002 and 003 are built; each remaining row gets the next
free number when its spec starts. Agreed order: the AI agent next, then click tracking, drip campaigns and
integrations, then click-to-WhatsApp ads and payments; the other rows are scheduled around them.

| Feature | Scope | Depends on |
|---|---|---|
| **002 Live chat inbox** ✅ built | Items 6.1–6.11, 6.13 and 6.14. Also agent rules 2.4, notifications 2.5, block 3.11, and "replied" metrics 5.6. | 001 |
| **003 Chatbot flow builder** ✅ built | Items 7.1–7.3 and 7.5–7.7: canvas, starters, keyword, pattern, template-button and first-message triggers, questions, lists, logic, API calls, hand-over, test numbers, versions and analytics | 002 |
| **AI agent and AI suite** (next) | Items 9.1–9.6; AI generators for templates and flows | 002, 003 |
| **Integrations and developer platform** | Items 5.9 and 5.12; 7.8; 11.2–11.7; guided connect 1.1; QR codes for flow triggers | 002, 003 |
| **Templates and campaign growth** | Items 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9 and 4.11; 5.3, 5.5, 5.7, 5.8, 5.10, 5.13 and 5.14 (click tracking, drip); 12.1 and 12.2 | 001 |
| **Ads manager** | Items 9.7 and 10.1–10.4 (click-to-WhatsApp ads start flows) | 003, Integrations |
| **Commerce, forms and payments** | Items 3.13, 4.8, 6.12, 7.4 and 8.1–8.5; 11.8 | 003 |
| **Contacts, settings and security** | Items 1.3, 1.4, 1.6 and 2.3; 3.2, 3.3, 3.5, 3.8, 3.9 and 3.10 (3.7 first-message tags came with 003); 5.11 (birthday and date automations) | 001 |
| **Mobile (installable app with push)** | Item 12.4 | 002 |

**What depends on Meta, not on us:**
- business verification and tier upgrades
- display-name and Blue Tick approval
- template approvals
- Ads Manager access (an ad account with billing)
- WhatsApp Payments, which are only offered in India, Brazil and Singapore. Our numbers are in the UAE, so payments would use payment links.
- Catalog through Commerce Manager

## Sources (read 2026-11-19)

- **Pricing:** aisensy.com/pricing/usd
- **Live chat:**
  - live-chat-settings-feature
  - how-to-assign-agent-rules
  - understanding-chat-profile
  - how-to-use-live-chat-aisensy-with-chatbot
  - chats-in-history-page
  - how-to-initiate-new-conversations-directly-from-history-page
  - how-to-create-canned-messages-in-aisensy-app
  - how-to-setup-auto-replies-in-aisensy-app
  - notification-preferences
  - how-to-block-users-from-sending-you-spam-messages
- **Campaigns:**
  - features/whatsapp-broadcasting, click-tracking, whatsapp-retargeting, whatsapp-automation
  - tutorials: how-to-create-a-whatsapp-qr-code-campaign, how-to-automate-a-personalized-birthday-wish, how-to-retry-failed-messages-up-to-3-times, how-to-setup-whatsapp-api-campaigns, api-reference-docs
- **Commerce:** features/whatsapp-payments, whatsapp-catalog, whatsapp-forms, whatsapp-webviews
- **AI and ads:**
  - features/aisensy-meta-ads-manager, whatsapp-ai-agents, whatsapp-ai-assistant, whatsapp-chatbot
- **Contacts, profile and templates:**
  - how-to-create-whatsapp-button
  - how-to-create-first-message-tag-for-whatsapp-contacts
  - how-to-edit-whatsapp-business-profile-in-aisensy
  - how-to-automatically-optin-optout-users-in-aisensy-app
  - how-to-create-a-carousel-whatsapp-template-message-in-aisensy
- **Integrations:** integrations/shopify; whatsapp-co-existence-everything-you-need-to-know
- **Earlier report:** aisensy-reverse-engineering.md (2026-11-16)
- **Search:** one web search for the webhook reference (AiSensy's webhook event names are not published; ours will be our own)
