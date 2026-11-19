# AiSensy — Public-Surface Reverse Engineering Report

> **Target:** https://aisensy.com · **Date:** 2026-11-16 · **Prepared for:** whatsapp-project
> **Method:** passive review of public pages, public docs, HTTP response headers and public DNS. About 35 requests in total; `robots.txt` is `Allow: /`.
> **Deliberately out of scope:** logging in, decompiling the web or mobile app, bulk scraping, probing APIs, security testing. AiSensy's Terms forbid reverse-engineering their software and running automated scrapers, so everything below comes from what any visitor can read.
> **Legend:** **[O]** observed on a public page, header or DNS record · **[I]** inference from observed facts (verify before relying on it).

---

## 1. Executive summary

- AiSensy (AiSensy Communications Pvt Ltd, India) is a **Meta Business Solution Partner**. It sells an all-in-one WhatsApp marketing platform built on the official WhatsApp Business (Cloud) API. [O]
- **Business model:** free WhatsApp API onboarding, then freemium SaaS tiers (₹1,500 to ₹45,000 per month). On top of that they sell a prepaid WhatsApp message wallet, paid add-ons (chatbots, AI agents, virtual numbers, seats), Meta ad credits, and partner / white-label deals. [O]
- **Product pillars:** [O]
  - **Acquire:** Click-to-WhatsApp ads, links, QR codes, website widget.
  - **Engage:** broadcast, retargeting, segments, scheduler, click tracking.
  - **Automate:** flow builder, AI agents, AI suite.
  - **Convert:** catalog, cart, WhatsApp payments, forms.
  - **Support:** multi-agent shared inbox, routing rules.
- **Stack:** [O]
  - Marketing site on **Umso**.
  - Web app is a **React (Create React App) single-page app on Amazon S3 + CloudFront**.
  - Billing on **Chargebee**, help center on **Intercom**, API docs on **Stoplight / Postman**.
  - Public API host is `backend.aisensy.com`.
- **Growth engine is SEO-heavy.** The sitemap has **735 URLs**: [O]
  - roughly 100+ programmatic template pages and 74 chatbot-template pages
  - 24 AI-agent pages, 79 case studies and 113 tutorials
  - 6 competitor-comparison pages
  - 13 language versions (186 Portuguese URLs alone)
- **Plan levers.** Plans are separated mainly by sending speed (40 / 250 / 1,000 messages per second), caps on tags, attributes and segments, agent seats, and webhook count. This structure is a useful template for packaging your own plans. [O]

---

## 2. Company & positioning [O]

| Item | As published |
|---|---|
| Legal entity | AiSensy Communications Private Limited, India |
| Positioning | "AI-first WhatsApp Marketing Platform built on official WhatsApp Business APIs" |
| Meta status | Official WhatsApp Business Solution Partner; "Emerging Partner of the Year 2023" and "CTWA Partner of the Year 2024" (Meta) |
| Customers claimed | "2.5L+ businesses" (pricing page) / "210,000+ businesses" (features page) / "100,000 businesses served" (about page); 68+ countries |
| Volume claimed | 1.5 Bn+ messages sent; ₹200 Cr+ revenue generated for customers |
| Team | "100+" (about page) / "150+ members, goal 200+" (careers page) |
| Partners | "6,000 partners" (partner page) / "200 partners" (about page) |
| Competitors they name | WATI, Interakt, DoubleTick, Zoko, Gupshup, Gallabox |
| Target industries (17 pages) | e-commerce/D2C, education, healthcare, real estate, finance & insurance, automobile, travel, events/webinars, IT services, retail, restaurants, spas & salons, gyms, HR/recruitment, marketing agencies, government |

> Their own pages give inconsistent customer and partner numbers. Treat these marketing claims as approximate.

---

## 3. Product map

### 3.1 WhatsApp Business API onboarding [O]
- Free API procurement, "go live in ~10 minutes". Meta's display-name review takes a few hours (3–4 h quoted).
- Onboarding steps:
  1. Sign up.
  2. Connect the Meta Business Portfolio with **"Log in with Facebook"**.
  3. Add and verify the number by OTP. This can be a new number, or the existing WhatsApp Business app number via **coexistence**.
  4. Set the display name and profile.
- Requirements: a business website, a Meta Business Portfolio, and a number that can receive an OTP.
- They explain Meta's messaging-limit ladder to users: 250 → 2,000 → 10,000 → 100,000 → unlimited.
- Extra services:
  - free **Blue Tick** application
  - Indian **virtual numbers** (₹2,000 + GST per year; needs GST/MSME KYC)
  - a guide for migrating from other BSPs, and one for downgrading back to the app
- [I] The "Log in with Facebook" step is Meta's **Embedded Signup** flow, which Solution Partners and Tech Providers use.

### 3.2 Contacts & CRM [O]
- Unlimited contacts. Import/export by CSV, add single contacts, or sync phone contacts (mobile app).
- **Tags** and **custom attributes**, both capped per plan. Also **global attributes**, fallback values for attributes in templates, a "first message tag" and a lead-source field.
- **Audience segments** combine tags and attributes (2 / 10 / 50 per plan).
- Opt-in/opt-out automation by keyword, and spam-user blocking.
- Each contact profile shows the payment history.

### 3.3 Template messages [O]
- Create and submit templates to Meta (marketing, utility, authentication) and track approval status.
- Formats: text; media (image/video/document); quick-reply, URL and call buttons; **carousel** (up to 10 cards); authentication/OTP templates.
- **Template TTL** (Premium): if the user stays offline past a set window, WhatsApp stops trying, so OTPs and reminders never arrive late.
- An AI template generator, and a public library of 100+ sample templates (these double as SEO pages).

### 3.4 Broadcast, retargeting & campaigns [O]
- **Sending:**
  - Bulk broadcasts to segments or uploaded CSVs.
  - **Campaign scheduler** that handles time zones, plus a CSV campaign scheduler.
  - An option to message duplicate numbers in a CSV.
- **Retargeting:** re-send based on how users responded: read, clicked, replied, failed, or went quiet.
- **Click tracking:** works only for URL CTA buttons (who clicked, how many times), including clicks on individual carousel cards. One tap retargets the clickers.
- **Failed-message retry** happens automatically (a tutorial says up to 3 retries).
- **Reporting:** campaign budget & analytics, plus downloadable reports (campaign, user, overview, opt-in/opt-out).
- **API campaigns:** a named campaign in "Live" status, bound to one template, that external systems trigger through the API (§6).
- **Other automations:** QR-code campaigns, birthday automations, drip sequences (mobile app).
- **Throughput by plan:** **40 msg/s (Basic, Pro) → 250 msg/s (Premium) → 1,000 msg/s (Unlimited)**. Marketing pages claim a 10,000-message broadcast takes about 18 minutes.

### 3.5 Live chat / shared team inbox [O]
- Many agents share one number. Chats sit in three columns:
  - **Requesting:** needs a human.
  - **Active:** handled by the bot, or a new chat.
  - **Intervened:** a human has taken over.
- Agent transfer and manager monitoring.
- **Custom agent rules** auto-route chats by tags and attributes. Smart filters work on tags, campaigns and attributes.
- Access and privacy controls:
  - **Number masking**: agents see only the last 4 digits of customer numbers.
  - **User access control** (roles) and 2-factor authentication.
- Seats: Basic/Pro include 1 owner + 5 agents, Premium 1 + 9, Unlimited up to 200. An extra seat costs ₹750 per month ($20).

### 3.6 Chatbot flow builder (add-on) [O]
- Three ways to build:
  - **AI flow generator** from one prompt
  - **60+ templates**
  - a drag-and-drop canvas
- **Triggers:**
  - keywords or **regex**
  - template-message buttons
  - QR codes
  - **Click-to-WhatsApp ads** (Premium lets several ads trigger one flow)
- **Blocks:**
  - Messages: text/media, reply buttons, list menus.
  - Commerce: product cards & **cart**, catalog, **payments**, **WhatsApp Forms** (native).
  - Logic: save answers to attributes, **conditions**, **API request** (fetch live data), **time delay**, **timeout fallback**, fallback reply.
  - Handoff: **"Request Intervention"** moves the chat to a human.
- Test on up to 3 test numbers, then switch the flow to Active.
- Existing Google **Dialogflow** bots can be connected.

### 3.7 WhatsApp AI agents (add-on, "Agent Studio") [O]
- **7-step builder:** business info → tone/voice → skills → **knowledge base from website + PDFs** → test → publish.
- **Capabilities:**
  - knowledge-base Q&A and **long-term user memory**
  - **tool calling / skills / API integrations** (Shopify, CRMs, live data)
  - AI routing between agents, human handoff, many languages
- **Metering:** sold as **AI messages** (1,000 per month in the add-on; 500 free for testing). AI replies also count as WhatsApp service messages.
- **Agent library:** 24 prebuilt agents, for example sales, support, appointment booking, lead qualification, returns, KYC, admissions and property enquiry.

### 3.8 AI Suite (inside the dashboard) [O]
- **AI Assistant:** do dashboard tasks by chat (find contacts, add tags, choose templates, check results).
- **AI Campaign Agent:** writes the messages, **submits templates to Meta**, sends broadcasts and follow-ups, and shows the estimated cost first.
- **AI Ads Agent:** writes ad copy and creatives; the user reviews audience, destination and budget.
- **Gen AI Suite:** generates templates, turns product photos into ad creatives, and makes short video ads.

### 3.9 Ads manager [O]
- Create and manage Meta ads inside AiSensy:
  - **Click-to-WhatsApp** ads
  - lead-form, website-traffic and sales ads
  - **WhatsApp Status** ads
- Includes AI generators for ad creatives and video.
- The Free plan includes 1,000 free Meta ad credits (the mobile-app page says ₹1,000).
- Partners earn commission on ad credits, which shows AiSensy sells or handles ad credits.
- Built around Meta's **72-hour free entry-point window** for conversations that start from CTWA ads.

### 3.10 Commerce: catalog, payments, forms, webviews [O]
- WhatsApp **catalog** and product messages; cart management and a Shopify bot (via the chatbot add-on).
- **WhatsApp Payments:**
  - Accepts UPI, cards and net banking via **Razorpay, PayU** and other gateways.
  - Payment messages can go out from broadcasts, live chat or flows.
  - Tracks pending vs paid payments, so non-payers can be retargeted; one dashboard shows all payments.
  - Case study: eMudhra collected ₹1.2 Cr in 3 months.
- **WhatsApp Forms** (native in-chat forms) and **Webviews** (web pages opened inside WhatsApp).

### 3.11 Developer platform [O]
- **Template Message APIs** (Basic and above).
- **Project APIs** (Pro and above).
- **Webhooks** (Premium: 1, Unlimited: 3) that push message and status events to the customer's backend. See §6.

### 3.12 Integrations [O]
- **E-commerce:** Shopify (plus Shopify checkouts such as "Magic Checkout"), WooCommerce, OpenCart.
- **Payments:** Razorpay, PayU.
- **No-code automation:** Zapier, Pabbly Connect, Integrately, viaSocket. Through these they advertise "2000+ apps".
- **Engagement / CRM:** WebEngage, CleverTap, MoEngage, LeadSquared, Kylas, Superleap.
- **Others:** Yuko, Nector (loyalty), Adverti (analytics), Bolna.ai (voice AI), XtremeGenAI, DaySchedule, Dialogflow.

### 3.13 Mobile apps [O]
- Android and iOS apps cover:
  - live chat with push notifications
  - broadcasts and drip campaigns
  - 5 types of Meta ads
  - contact sync and template creation
  - AI agents

### 3.14 Free tools / lead magnets [O]
- WhatsApp link generator and website chat button (`create.aisensy.com`).
- WhatsApp pricing calculator.
- AI ad generator and AI template generator.
- A contextual website popup builder.

---

## 4. Pricing & monetization [O]
Read from `/pricing` and `/pricing/usd` on 2026-11-16. Structured copy: `evidence/pricing-2026-11-16.json`.

### 4.1 Plans

| Plan | ₹ / month | ₹ / quarter | ₹ / year | $ / month | Key unlocks |
|---|---|---|---|---|---|
| Free Forever | 0 | – | – | 0 | WhatsApp API, Blue-tick application, CTWA ads (1,000 ad credits), ₹50 message credit, templates, live chat. **No broadcasting** |
| Basic | 1,500 | 4,275 | 16,200 | 45 | Broadcast & retarget, 40 msg/s, 1+5 agents, template APIs, Shopify/WooCommerce, 2 segments, 1 GB media |
| Pro *(most popular)* | 3,200 | 9,120 | 34,560 | 99 | Scheduler, click tracking, budget analytics, Project APIs, agent rules, roles, auto-retry, flow delay/timeout, 10 segments |
| Premium | 9,100 | 25,935 | 98,280 | 299 | 250 msg/s, 1+9 agents, number masking, reports, template TTL, 1 webhook, priority support, 50 segments |
| Unlimited | 45,000 | 1,28,250 | 4,86,000 | 899 | 1,000 msg/s, up to 200 agents, 3 webhooks, dedicated account manager |
| Enterprise | custom | – | – | custom | For 5 lakh+ messages/month: SSO & audit logs, SLA, custom throughput, custom message rates |

- Paying quarterly saves 5%; paying yearly saves 10%.
- All billing is prepaid. Upgrades and downgrades are pro-rated.

### 4.2 Limits matrix

| Limit | Free | Basic | Pro | Premium | Unlimited |
|---|---|---|---|---|---|
| Sending speed (msg/s) | – (no broadcast) | 40 | 40 | 250 | 1,000 |
| Agents included | – | 1+5 | 1+5 | 1+9 | up to 200 |
| Tags / attributes | 10 / 5 | 10 / 5 | 100 / 20 | 250 / 50 | 500 / 100 |
| Segments | – | 2 | 10 | 50 | 50 |
| Webhooks | – | – | – | 1 | 3 |

"Unlimited" items follow fair-use caps: 200 agents, 500 tags, 100 attributes, 50 segments.

### 4.3 Add-ons

| Add-on | Price (INR) | Includes |
|---|---|---|
| Chatbot Flow Builder | 2,500/mo (2,250/mo billed yearly) | 5 chatbots, cart/catalog, Shopify bot, 3 AI flow generations |
| AI Agent Builder | 1,350/mo (1,215/mo billed yearly) | 1,000 AI messages/mo, knowledge-base Q&A, memory, tool calling; 500 free test messages |
| Indian virtual number | 2,000 + GST per year, or 299 per quarter | Number without a SIM (GST/MSME KYC needed) |
| Extra agent seat | 750/mo ($20) | – |

### 4.4 WhatsApp message charges
India rates, effective 1 Oct 2026, as published by AiSensy:

| Category | Price per delivered message |
|---|---|
| Marketing | ₹1.09 |
| Utility | ₹0.145 (also charged inside the 24-hour window) |
| Authentication | ₹0.145 |
| Service (free-form replies, including bot and AI replies) | First 1,000 per number per month free, then ₹0.145 |
| Incoming messages; CTWA 72-hour window | Free |

- Charges come out of a prepaid **WhatsApp Conversation Credits (WCC)** wallet.
- New accounts get ₹50 of credit at sign-up.
- A minimum balance of ₹10 / $1 is needed to keep bots and automations running.

### 4.5 Revenue streams
1. SaaS subscriptions [O]
2. Add-ons: chatbots, AI agents, virtual numbers, seats [O]
3. Message-wallet top-ups (WCC) [O]. [I] Probably a margin over Meta's rates; this is not disclosed.
4. Meta ad credits [O]
5. White-label and direct-API partnerships [O]

**Acquisition channel:** affiliates earn 20% recurring commission, tracked with Tapfiliate. [O]

---

## 5. Technology stack [O]
Evidence log: `evidence/tech-fingerprint-2026-11-16.txt`.

| Layer | Technology | Evidence |
|---|---|---|
| Marketing site | **Umso** website builder | `X-Umso-Render` response header; assets on `umsousercontent.com` |
| Previous marketing host | Webflow (legacy) | DNS TXT `proxy-ssl.webflow.com.` |
| Marketing site IP | Amazon (AWS) network | A record 99.83.181.15 → ARIN: Amazon.com, Inc. |
| Media CDN | Amazon CloudFront (2 distributions) | asset URLs on `*.cloudfront.net` |
| Web app (`app.aisensy.com`) | **React single-page app (Create React App)** | `<div id="root">`, `/static/js/main.<hash>.js` |
| Web app hosting | **Amazon S3 + CloudFront** | `Server: AmazonS3`, `Via: … (CloudFront)` |
| Free tools (`create.aisensy.com`) | React (CRA) on S3 + CloudFront | same signals |
| Subscription billing | **Chargebee** | `js.chargebee.com/v2/chargebee.js` loaded in app; privacy policy says payment data is stored by Chargebee |
| Signup/forms flows | Arengu | `sdk.arengu.com/forms.js` loaded in app |
| Video | Wistia (app), YouTube (site) | script and embed hosts |
| Help center | **Intercom Articles**, behind Cloudflare | `wiki.` / `faq.` serve Intercom assets; `CF-RAY` header |
| Public API host | `backend.aisensy.com` | public API docs |
| API docs | Stoplight (`aisensy.stoplight.io`), Postman public workspace | links on site and docs |
| Analytics & ads | Google Tag Manager, GA4 (2 properties), Meta Pixel, Microsoft Clarity, Plausible, Ahrefs Analytics | homepage scripts |
| Affiliate tracking | Tapfiliate | homepage script |
| Demo booking | Calendly | homepage links |
| Website popups | Custom app hosted on Replit | `…replit.app/v1.js` |
| Corporate email | Google Workspace | MX records |
| Email sending | Brevo, Amazon SES, SendGrid | SPF record |
| DNS | Namecheap (`registrar-servers.com`) | NS records |
| Other verifications | Microsoft 365, Facebook domain verification, Google Search Console | TXT records |

- **Not visible from outside:** backend language/framework, database, queues, LLM provider, and the backend's cloud region.
- [I] S3/CloudFront app hosting plus Amazon SES and an AWS-hosted marketing IP point to **AWS** as the main cloud.

---

## 6. Public developer API [O]

**Campaign API (v2).** It triggers a "Live" API campaign (an approved template) for one recipient.

```http
POST https://backend.aisensy.com/campaign/t1/api/v2
Content-Type: application/json

{
  "apiKey": "<project API key>",
  "campaignName": "<live API campaign name>",
  "destination": "+91XXXXXXXXXX",
  "userName": "Customer name",
  "source": "optional lead source",
  "templateParams": ["value1", "value2"],
  "media": { "url": "https://public.example/invoice.pdf", "filename": "invoice.pdf" },
  "tags": ["existing-tag"],
  "attributes": { "existing_attribute": "value" }
}
```

- The API key goes **in the JSON body**. Each project generates its own key under Developer → API Campaign key.
- Numbers without a country code default to +91.
- Their examples also use `buttons`, `carouselCards`, `paramsFallbackValue` and `location`.
- **Validation rules:**
  - The media URL must be publicly reachable.
  - The number of `templateParams` must match the template.
  - Tags and attributes that don't already exist are ignored.
  - Success returns HTTP 200; no other response fields are documented.
- Higher plans add **Project APIs** and **webhooks**. The Stoplight Project-API page linked from the homepage currently returns 404.
- [I] **Design takeaways:**
  - Customers never touch Meta's API. They send "campaign name + parameters" and AiSensy builds the Meta template payload.
  - A **Project** = one WhatsApp number/workspace; tags, attributes and API keys are scoped to it.

---

## 7. Growth & SEO engine [O]

| Section | URLs | Purpose |
|---|---|---|
| `/pt` plus 12 other language folders | 186 + ~60 | International SEO: a Brazil push, plus es, fr, de, ar, id, ms, hi, bn, gu, mr, ta, te |
| Message-template pages (`/whatsapp-marketing-template-*`, `/whatsapp-template-*`) | ~100+ | Programmatic SEO for "WhatsApp template for X" searches |
| `/tutorials` | 113 | How-to docs that double as SEO |
| `/case-studies` | 79 | Social proof |
| `/whatsapp-chatbot-template` | 74 | Chatbot template gallery |
| `/features` | 30 | Feature landing pages |
| `/whatsapp-ai-agent-library` | 24 | AI-agent use-case pages |
| `/industries` | 17 | Vertical landing pages |
| `/integrations` | 10 | Integration landing pages |
| Competitor pages | 6 | vs WATI, Interakt, DoubleTick, Zoko; Gupshup and Gallabox "alternative" pages |
| Free tools | 5+ | Link/button generator, pricing calculator, AI ad and template generators |

**Partner program:**
- **Affiliate:** 20% recurring commission.
- **Prime Plus:** commission also on ad credits and message credits.
- **White-label:** your brand, domain, logo and pricing; AiSensy runs the backend.
- **Direct API partnership.**
- **Integration partnership.**

**Funnel:**
1. Free tools, SEO pages and CTWA ads bring visitors.
2. They sign up for Free Forever (no card needed).
3. The paywall sits on broadcasting.
4. Upsells: add-ons, more seats, higher speed tiers.

**Gap observed:** no Urdu (`/ur`) localization.

The full URL list is in `evidence/sitemap-urls-2026-11-16.txt`.

---

## 8. Unknowns (not determinable from public data)
- Backend language and framework, database, queueing, LLM vendor, data residency.
- Whether WCC prices include a margin over Meta's rates.
- Full Project API and webhook schemas (the docs page returns 404).
- Internal quotas beyond the published plan caps.

---

## 9. Boundaries for building your own product
- ✅ **Fine:**
  - building a product with a similar feature set
  - learning from their pricing structure
  - copying public API design *patterns*
  - publishing truthful comparison pages
- ❌ **Not fine:**
  - copying their text, page designs, images, logos, template wording or brand
  - decompiling their web or mobile app
  - bulk-scraping their site or app
  - using their trademark in a way that misleads

  Their Terms explicitly ban reverse-engineering their software and running automated scrapers.
- Use only the official Meta WhatsApp Business Platform. Unofficial WhatsApp Web automation gets numbers banned.

---

## 10. Sources (fetched 2026-11-16)
- **aisensy.com:** `/`, `/pricing`, `/pricing/usd`, `/features`, `/features/whatsapp-broadcasting`, `/features/whatsapp-chatbot`, `/features/whatsapp-ai-agents`, `/features/whatsapp-support`, `/features/click-tracking`, `/features/whatsapp-payments`, `/products/whatsapp-marketing`, `/products/whatsapp-blue-tick`, `/products/click-to-whatsapp-ads`, `/integrations`, `/partner`, `/enterprise`, `/about-us`, `/aisensy-whatsapp-ai-suite`, `/aisensy-vs-wati`, `/whatsapp-business-api`, `/mobile-app`, `/privacy-policy`, `/refund-policy`, `/tos`, `/robots.txt`, `/sitemap.xml`
- https://wiki.aisensy.com/en/articles/11501889-api-reference-docs
- https://careers.aisensy.com/
- Response headers from `app.aisensy.com`, `create.aisensy.com`, `wiki.aisensy.com`, `faq.aisensy.com`
- Public DNS for `aisensy.com`; ARIN RDAP for 99.83.181.15
