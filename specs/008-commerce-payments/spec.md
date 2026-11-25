# Feature Specification: Commerce and Payments over WhatsApp

**Feature Branch**: `008-commerce-payments`
**Created**: 2026-11-25
**Status**: Draft
**Input**: User description: "Commerce and payments over WhatsApp (feature 008), following the AiSensy inventory row "Commerce, forms and payments" (items 3.13, 4.8, 6.12, 7.4, 8.1-8.4 and 11.8; 8.5 webviews optional). The company sells to customers in the UAE; Meta's native WhatsApp Payments is not offered in the UAE, so customers pay through payment links from the company's own payment gateway account. Scope: (1) Payment requests: make a payment link (amount, currency, description, expiry, optional order reference) and send it from live chat, a flow step, a campaign, an API call or a store order; track pending, paid, failed, expired and refunded through the gateway's signed webhooks; a payment history on the contact profile and in the journey; reminders to people who have not paid and retargeting of non-payers; a payments page with totals; outbound webhook events for payment changes. (2) Meta catalog: connect the WhatsApp account's Meta catalog (or fill it from the 006 Shopify/WooCommerce stores), browse products, send single-product, multi-product and catalog messages from live chat, flows and templates (multi-product templates), and turn carts that customers send in chat into orders with a payment link. (3) WhatsApp Forms (Meta WhatsApp Flows): build multi-step in-chat forms (text, choices, dates), publish them to Meta, send them from live chat, flows and templates, and save answers to contact attributes and tags and the 006 outbound webhooks. (4) Commerce steps in the 003 flow builder: product, catalog, payment request and form steps. Card data never touches the platform (payment pages belong to the gateway). Reuse 001-007 patterns: test-first, mock gateway and mock-meta routes, encrypted credentials, audit entries, roles, retention and erasure."

**Context**: This is the last part of the order the user chose on 2026-11-19 (live chat, flows, the
AI agent, campaign growth, integrations, ads, then payments). It covers items 3.13, 4.8, 6.12, 7.4,
8.1–8.4 and 11.8 of `docs/research/aisensy/feature-inventory-2026-11-19.md`. Item 8.3 describes
Meta's native WhatsApp Payments, which Meta offers only in India, Brazil and Singapore; the company's
numbers are in the UAE, so customers pay on the payment gateway's own page through a link. Item 11.8
names Indian gateways; here the notifications come from the company's own gateway. We match the
documented behaviour, not the look: screens, labels and wording are our own (constitution
Principle II).

## Clarifications

### Session 2026-11-25

- Q: Which payment gateway does the company use for payment links in the UAE? → A: Stripe (available in the UAE with AED, payment links and signed notifications, free test mode). Other gateways can be added later.

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Payment gateway** | The company's own online payment provider account — Stripe at first. It hosts the payment page, takes the card or wallet payment, and pays the company. The platform never sees card details. |
| **Gateway connection** | The link between the platform and the gateway account, made once by an admin with the gateway's keys, and checked before use. |
| **Payment request** | One request for one customer to pay an amount: the amount and currency, what it is for, an expiry, an optional reference (for example an order number), and the gateway's payment link. |
| **Payment link** | The address of the gateway's payment page for one payment request. |
| **Payment status** | Where a request stands: waiting (sent, not paid), paid, failed attempt, expired, cancelled, or refunded (fully or in part). The gateway tells the platform through signed notifications. |
| **Meta catalog** | The product list in Meta Commerce Manager linked to the company's WhatsApp account. WhatsApp product messages show products from it. |
| **Product message** | A WhatsApp message that shows one product (single-product), a list of up to 30 products in sections (multi-product), or a button that opens the whole catalog (catalog message). |
| **Cart** | What a customer sends from a product message: the products, quantities and prices they chose. |
| **Chat order** | The platform's record of a cart: its items, total, customer and payment. |
| **WhatsApp Form** | A multi-step form that opens inside WhatsApp (Meta calls them WhatsApp Flows): screens with text fields, choices and dates. The answers come back into the chat. |
| **Form answers** | What one customer entered in a form, saved to their contact. |
| **Commerce steps** | Flow builder steps (feature 003) that send a product, a catalog, a payment request or a form, and continue when the customer acts. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect the company's payment gateway (Priority: P1)

An admin opens **Payments → Gateway** and enters the company's Stripe account keys. The
platform checks each thing payments need and shows a plain fix for each failure: the keys are
valid, live or test mode, the account's currency (AED by default), and that payment notifications
reach the platform (the admin registers the notification address the platform shows, or the
platform registers it when the gateway allows). The admin saves the connection; the keys and the
notification secret are stored encrypted and never shown again.

**Why this priority**: nothing else in payments works without the connection, and a test-mode or
mismatched-currency account caught here saves wrong payment links later.

**Independent Test**: With the mock gateway, connect an account; wrong keys are refused with the
reason; test-mode keys are labelled as test; a notification sent by the gateway to the platform's
address is received and verified; the saved connection never shows the keys.

**Acceptance Scenarios**:

1. **Given** an admin enters valid keys, **When** the platform checks them, **Then** it shows the account name, mode (live or test) and currency.
2. **Given** the keys are wrong or lack a needed permission, **When** checked, **Then** the check says which and how to fix it, and payments cannot be sent until it passes.
3. **Given** the connection is saved, **When** the gateway sends a test notification, **Then** the platform verifies its signature and shows "Notifications working".
4. **Given** a notification arrives with a wrong signature, **When** received, **Then** it is rejected and recorded, and no payment status changes.
5. **Given** the connection is saved, **When** anyone views it later, **Then** the keys are never shown again; only "Run checks", "Replace keys" and "Disconnect" are offered.

---

### User Story 2 - Ask for a payment in live chat and see it paid (Priority: P1)

An agent chatting with a customer chooses **Request payment**, enters the amount, what it is for,
an expiry (24 hours by default) and an optional reference. The platform creates the payment link
at the gateway and sends it in the chat with a clear **Pay now** button. When the customer pays,
the chat shows **Paid** on the request within a minute, the contact's payment history and journey
record it, and the agent is notified. Failed attempts show as such; an unpaid request expires at its
time. Outside the 24-hour reply window the agent sends the request with an approved payment
template instead.

**Why this priority**: taking payments in the chat where the sale happens is the main value of the
feature; it is how most small sales close.

**Independent Test**: In live chat with the mock gateway, request AED 150 for "Order 1042"; the
chat shows the request with its link; a mock payment marks it **Paid** in the chat, the profile and
the journey; a failed attempt shows **Failed attempt**; an unpaid request becomes **Expired** at its
expiry.

**Acceptance Scenarios**:

1. **Given** a connected gateway and an open chat, **When** an agent requests a payment, **Then** the customer receives a message with the amount, what it is for and a Pay now button that opens the gateway's page.
2. **Given** the customer pays, **When** the gateway notifies the platform, **Then** the request shows Paid with the time and amount in the chat, the contact's payment history and the journey, and the agent who asked is notified.
3. **Given** a payment attempt fails, **When** the gateway reports it, **Then** the request shows Failed attempt and stays payable until it expires.
4. **Given** the request is not paid by its expiry, **When** the time passes, **Then** it shows Expired and its link no longer takes payments.
5. **Given** the 24-hour reply window is closed, **When** an agent requests a payment, **Then** the platform offers only approved payment templates for it.
6. **Given** the gateway is down, **When** an agent requests a payment, **Then** the agent sees that the link could not be made, nothing is sent, and they can try again.

---

### User Story 3 - Payment requests from flows, campaigns, the API and store orders (Priority: P1)

Payment requests also go out without an agent: a flow step asks for a fixed amount or an amount
from the conversation (for example a quote saved earlier) and continues on **paid** or **not paid
in time**; a campaign sends each recipient their own payment link (amount from their contact data or
a fixed price); another company system sends a payment request with one API call; and a store order
from feature 006 can get a **Pay now** link instead of cash on delivery. Paying can add a tag and
start a flow.

**Why this priority**: most payment requests at scale come from automations and other systems, not
from agents typing them one by one.

**Independent Test**: A flow asks for AED 99 and takes the paid branch after a mock payment; a
campaign to three contacts sends three different links whose payments are matched to the right
contacts; an API call creates and sends a request and its status can be read; a store order gets a
Pay now link and shows paid.

**Acceptance Scenarios**:

1. **Given** a flow with a payment step, **When** the customer reaches it, **Then** they receive a payment request and the flow waits, continuing on the paid branch when paid or the not-paid branch when it expires.
2. **Given** a campaign whose template has a payment button, **When** it is sent, **Then** each recipient gets their own link for their amount, and each payment is recorded on that recipient.
3. **Given** another system calls the payments API with a phone number, amount and description, **When** the call is valid, **Then** a request is made and sent, and its status can be read back or received as an outbound webhook event.
4. **Given** a store order (feature 006) with online payment chosen, **When** the order arrives, **Then** the customer receives a Pay now link for the order total, and the order shows paid when the payment comes in.
5. **Given** a payment request was made with a tag or flow to run on payment, **When** it is paid, **Then** the contact gets the tag and the flow starts (never over a running flow or a member's chat).

---

### User Story 4 - Reminders, non-payers and the payments page (Priority: P2)

Managers see every payment request on **Payments**: totals of requested, paid, waiting, expired and
refunded amounts by day and by source (live chat, flows, campaigns, API, store orders), with filters
and a CSV export. Unpaid requests can get up to two automatic reminders before they expire (an
approved template, never to contacts who opted out of marketing when the template is marketing).
People who did not pay can be retargeted as a campaign audience. Refunds made in the gateway show on
the request and in the totals.

**Why this priority**: following up on unpaid requests recovers revenue, and the totals show what
WhatsApp brings in; both come after payments work.

**Independent Test**: With five mock requests (two paid, one refunded in part, two unpaid), the
page shows the right totals; the unpaid ones get their reminder at the set time; the "not paid"
group of a campaign can be sent a new campaign; the export lists every request.

**Acceptance Scenarios**:

1. **Given** payment requests from several sources, **When** a manager opens Payments, **Then** they see totals by status, day and source for a chosen period, in the account's currency.
2. **Given** reminders are on with "6 hours before expiry", **When** a request is still unpaid 6 hours before it expires, **Then** the customer gets the reminder template once.
3. **Given** a campaign sent payment requests, **When** a manager retargets its "not paid" group, **Then** only recipients whose request is unpaid or expired are in the new campaign.
4. **Given** a payment is refunded in full or in part in the gateway, **When** the gateway notifies the platform, **Then** the request shows the refund and the totals change.
5. **Given** a manager exports payments, **When** the file is made, **Then** it lists each request with amount, status, dates, source and reference, phones masked for roles without full phone access, and the export is audited.

---

### User Story 5 - Connect the Meta catalog and send products (Priority: P2)

An admin connects the Meta catalog linked to the company's WhatsApp account; the platform reads its
products (name, price, image, availability). A store connected in feature 006 can fill the catalog
and keep prices and availability up to date. In live chat an agent searches products and sends one
product, a list of up to 30 products in sections, or the whole catalog. Managers can use catalog and
multi-product templates in campaigns.

**Why this priority**: showing products inside WhatsApp turns chats into sales; it builds on the
payment flow of the first stories.

**Independent Test**: Connect the mock catalog with 40 products; search finds a product by name;
sending one product, a multi-product list and the catalog each arrive as the right message type; a
product made unavailable in the catalog shows as unavailable in the picker.

**Acceptance Scenarios**:

1. **Given** the WhatsApp account has a linked catalog, **When** an admin connects it, **Then** the platform lists its products and keeps them up to date.
2. **Given** a store from feature 006 is connected, **When** the admin chooses to fill the catalog from it, **Then** its products are added to the catalog and later price and stock changes follow.
3. **Given** an open chat, **When** an agent sends one product, a list of products or the catalog, **Then** the customer receives the matching WhatsApp product message.
4. **Given** a catalog or multi-product template is approved, **When** it is used in a campaign, **Then** each recipient receives it with the chosen products.
5. **Given** a product is unavailable or no longer in the catalog, **When** an agent tries to send it, **Then** the picker shows it as unavailable and it cannot be sent.

---

### User Story 6 - Turn carts sent in chat into orders with a payment link (Priority: P2)

When a customer picks products in a product message and sends the cart, the platform records a chat
order with its items and total, shows it in live chat and on the contact, and either replies at once
with a payment link for the total (automatic mode) or lets the agent check it and send the link. The
order's status follows its payment; a paid order can add a tag and be sent to other systems as an
outbound webhook event.

**Why this priority**: carts complete the in-chat shopping flow; they need the catalog (US5) and
payment requests (US2).

**Independent Test**: A mock customer sends a cart of two products; a chat order with the right
items and total appears in live chat; in automatic mode a payment link for the total arrives within
a minute; paying it marks the order paid.

**Acceptance Scenarios**:

1. **Given** a customer sends a cart, **When** the platform receives it, **Then** it records a chat order with each product, quantity, price and the total, and shows it in the chat.
2. **Given** automatic mode is on, **When** a cart arrives, **Then** the customer receives a payment link for the total within a minute.
3. **Given** automatic mode is off, **When** a cart arrives, **Then** an agent sees it waiting and can change quantities or cancel before sending the payment link.
4. **Given** a product's price in the cart differs from the catalog now, **When** the order is made, **Then** the cart's price is used and the difference is shown to the agent.
5. **Given** the order is paid, **When** the payment arrives, **Then** the order shows paid, the contact gets the order tag if set, and an outbound event is sent.

---

### User Story 7 - WhatsApp Forms (Priority: P3)

A manager builds a form on **Forms**: screens with a title, text fields (short text, long text,
email, phone, number), choices (one, several, dropdown), dates and an opt-in checkbox, with required
fields and a final screen. They preview it and publish it to Meta. Agents send it from live chat;
templates can open it with a button. When a customer submits it, the answers show in the chat, are
saved to the contact's attributes as mapped (and tags as chosen), appear in the journey and the
form's answers list, and are sent to other systems as an outbound webhook event.

**Why this priority**: forms replace long question-and-answer chats for bookings and sign-ups; they
are useful on their own and come after payments and products.

**Independent Test**: Build a 2-screen form (name, email, a choice, a date), publish it to the mock
Meta, send it in a chat; a mock submission saves the mapped attributes, adds the tag, and lists the
answers on the form.

**Acceptance Scenarios**:

1. **Given** a draft form, **When** a manager publishes it, **Then** the platform checks it (every screen reachable, required fields set, labels within Meta's limits) and publishes it to Meta; problems are listed instead.
2. **Given** a published form, **When** an agent sends it in an open chat, **Then** the customer can open it in WhatsApp and fill it in.
3. **Given** a customer submits the form, **When** the answers arrive, **Then** they show in the chat, mapped answers are saved to contact attributes, chosen tags are added, and the journey records it.
4. **Given** a published form is changed, **When** the manager publishes again, **Then** a new version is made; answers to the old version stay with that version.
5. **Given** a form has an opt-in checkbox, **When** a customer ticks it, **Then** the contact is opted in with the form as the source; unticked never opts in.

---

### User Story 8 - Commerce steps in the flow builder (Priority: P3)

Flow builders (feature 003) get four new steps: **Send product** (one product or a list),
**Send catalog**, **Request payment** (with paid and not-paid branches) and **Send form** (with an
answered branch and access to the answers in later steps, and a not-answered branch after a wait).

**Why this priority**: automating shopping and forms in flows multiplies the earlier stories, and it
needs them first.

**Independent Test**: A flow sends a product list, waits for a cart, requests the cart total, and
takes the paid branch after a mock payment; another flow sends a form and uses its answers in a
message; both work in the 003 test panel.

**Acceptance Scenarios**:

1. **Given** a flow with a Send product step, **When** it runs, **Then** the customer receives the product message and the flow continues when they send a cart or at the step's timeout.
2. **Given** a Request payment step after a cart, **When** it runs, **Then** the amount can be the cart total, and the flow follows the paid or not-paid branch.
3. **Given** a Send form step, **When** the customer submits the form, **Then** the flow continues on the answered branch with the answers available to later steps.
4. **Given** a flow with commerce steps, **When** it is published, **Then** the 003 checks also check that the gateway, catalog or form it uses is connected or published.

---

### Edge Cases

- The gateway is down or slow when a link is made: nothing is sent; the agent, flow or API call gets a clear failure and can retry; automations retry with backoff and then mark the request as not sent.
- The link is made but the WhatsApp message fails: the request shows "not delivered" and can be sent again or cancelled; a cancelled request's link stops taking payments when the gateway allows.
- The same notification arrives several times or out of order (paid before "link created"): each is applied once, and a later status never goes back (paid does not return to waiting).
- A payment arrives after expiry (the gateway accepted it): the request shows Paid late, and managers are alerted.
- An amount of zero, a negative amount or one above the admin's per-request limit is refused.
- A currency the gateway account does not support is refused before the link is made.
- Partial refunds: the request shows the refunded amount and stays Paid with "partly refunded".
- The contact opted out: marketing payment reminders are not sent; utility payment messages follow Meta's rules.
- The 24-hour window closes between creating and sending: only a template can be used.
- A cart contains a product no longer in the catalog or a currency different from the account's: the order is recorded with a warning and the agent decides; automatic mode does not send a link.
- A form is answered after it was unpublished: answers are still saved to the version they belong to.
- A form maps an answer to an attribute that no longer exists: the answer is kept with the form answers and the agent is told.
- A contact with waiting payment requests is deleted: their links are cancelled where the gateway allows, and the requests keep amounts and statuses without the person's details.
- Test-mode keys in production: every screen shows "Test mode" and requests are labelled test; test payments are left out of the totals.
- Two agents request payment for the same reference at once: both requests exist; the reference shows both, and paying one does not pay the other.

## Requirements *(mandatory)*

### Functional Requirements

**Gateway connection**

- **FR-001**: Admins MUST be able to connect the company's Stripe account (the chosen gateway, available in the UAE with AED) with its keys. Other gateways (for example Network International, Telr or Tap) MUST be addable later without changing how payments work in the rest of the platform.
- **FR-002**: The platform MUST check the connection (keys valid, live or test mode, account currency, notifications reaching the platform) and show each failure with a plain fix; payments MUST NOT be sent while a check fails.
- **FR-003**: Keys and notification secrets MUST be stored encrypted, never shown again after saving, never written to logs, and never sent in outbound events.
- **FR-004**: Gateway notifications MUST be accepted only with a valid signature; each MUST be stored, applied once, and invalid ones rejected and recorded.
- **FR-005**: A connection in test mode MUST be labelled on every payments screen, and test payments MUST be left out of totals and reports.

**Payment requests**

- **FR-006**: A payment request MUST have an amount, a currency (the account's, AED by default), what it is for, an expiry (default 24 hours, at most 30 days), and MAY have a reference, a tag to add on payment and a flow to start on payment.
- **FR-007**: Agents and managers MUST be able to request a payment from a live chat they may reply in; inside the 24-hour window it is sent as a message with a Pay now button, outside it only with an approved payment template.
- **FR-008**: Admins MUST be able to set a maximum amount per request and which roles may request payments; requests above the maximum MUST be refused.
- **FR-009**: The platform MUST make the payment link at the gateway and send it to the customer; card or wallet details MUST never be entered in, sent through or stored by the platform.
- **FR-010**: Payment requests MUST be possible from flows (FR-041), campaigns (each recipient their own link and amount), a public API call (with an idempotency key), and feature 006 store orders (a Pay now link for the order total).
- **FR-011**: The platform MUST track each request's status — waiting, paid, failed attempt, expired, cancelled, refunded (in full or part) — from gateway notifications, with a later status never going back to an earlier one.
- **FR-012**: A request not paid by its expiry MUST become Expired, and its link MUST stop taking payments where the gateway allows; a payment after expiry MUST show as Paid late and alert managers.
- **FR-013**: When a request is paid, the platform MUST add its tag and start its flow if set (never over a running flow or a member's chat), notify the agent who asked, and record it in the journey.
- **FR-014**: A request MUST be cancellable before it is paid; a cancelled request's link MUST stop taking payments where the gateway allows.
- **FR-015**: Payment changes MUST be sent as feature 006 outbound webhook events (requested, paid, failed, expired, refunded) without card details.

**History, reminders and reports**

- **FR-016**: The contact profile MUST show the contact's payment history (requests and chat orders with amounts, statuses and dates).
- **FR-017**: Admins MUST be able to turn on up to two reminders for unpaid requests at times before expiry, sent with approved templates; marketing reminders MUST NOT go to contacts who opted out, and each reminder MUST be sent at most once per request.
- **FR-018**: Campaigns that sent payment requests MUST offer "paid" and "not paid" groups for retargeting (feature 005).
- **FR-019**: The Payments page MUST show totals of requested, paid, waiting, expired and refunded amounts by day and source for a period, in the account's currency, with filters by status, source and agent.
- **FR-020**: Managers MUST be able to export payment requests and chat orders as CSV; phones MUST be masked for roles without full phone access, and exports MUST be audited.

**Catalog and product messages**

- **FR-021**: Admins MUST be able to connect the Meta catalog linked to the company's WhatsApp account; the platform MUST keep a copy of its products (name, description, price, currency, image, availability, retailer id) up to date at least every hour and on demand.
- **FR-022**: Admins MAY fill the catalog from a feature 006 store and keep prices and availability in step with the store.
- **FR-023**: Agents MUST be able to search products and send a single-product message, a multi-product message (up to 30 products in up to 10 sections) or a catalog message in an open 24-hour window.
- **FR-024**: Managers MUST be able to use approved catalog and multi-product templates in campaigns, choosing the products per campaign.
- **FR-025**: Products that are unavailable or no longer in the catalog MUST be shown as such and MUST NOT be sendable.

**Chat orders**

- **FR-026**: A cart sent by a customer MUST become a chat order with its products, quantities, prices, currency and total, shown in live chat, on the contact and in the journey.
- **FR-027**: Admins MUST be able to choose automatic mode (a payment link for the total sent within a minute) or agent review (the agent can change quantities, remove items or cancel before sending the link).
- **FR-028**: A chat order's status MUST follow its payment (waiting, paid, expired, cancelled, refunded); a paid order MAY add a tag and MUST be sent as an outbound webhook event.
- **FR-029**: Carts with products not in the catalog, a different currency or prices that differ from the catalog MUST be recorded with a visible warning, and automatic mode MUST NOT send a link for them.

**WhatsApp Forms**

- **FR-030**: Managers MUST be able to build forms with screens holding text fields (short, long, email, phone, number), single and multiple choices, dropdowns, dates and an opt-in checkbox, with required fields and a final screen, and preview them.
- **FR-031**: Publishing MUST check the form (all screens reachable, required fields valid, texts within Meta's limits) and publish it to Meta; problems MUST be listed instead of publishing.
- **FR-032**: Changing a published form MUST make a new version when published; answers MUST stay linked to the version they came from.
- **FR-033**: Agents MUST be able to send a published form in an open chat; templates with a form button MUST open it.
- **FR-034**: Submitted answers MUST show in the chat, be saved to contact attributes as mapped, add chosen tags, appear in the journey and the form's answers list (exportable, audited), and be sent as an outbound webhook event.
- **FR-035**: A form's opt-in checkbox MUST opt the contact in with the form as the source only when ticked.

**Flow builder steps**

- **FR-036**: The flow builder MUST offer a Send product step (one product or a list) that continues when a cart arrives or at a timeout.
- **FR-037**: The flow builder MUST offer a Send catalog step.
- **FR-038**: The flow builder MUST offer a Request payment step whose amount is fixed, from a contact attribute or answer, or the last cart's total, with paid and not-paid branches.
- **FR-039**: The flow builder MUST offer a Send form step with an answered branch (answers available to later steps) and a not-answered branch after a wait.
- **FR-040**: Publishing a flow with commerce steps MUST check that the gateway is connected, the catalog connected or the form published as each step needs.
- **FR-041**: Commerce steps MUST work in the feature 003 test panel with the test numbers.

**Roles, audit, data and monitoring**

- **FR-042**: Permissions: admins connect the gateway and the catalog and set limits; managers and admins build forms, catalog campaigns and payment automations and see all payments; agents request payments and send products and forms in chats they may reply in and see those chats' payments; exports need the export permission.
- **FR-043**: Connecting and disconnecting the gateway and catalog, changing limits and reminders, cancelling requests, publishing forms and exports MUST be audited.
- **FR-044**: Payment requests and chat orders MUST be kept 5 years; raw gateway notifications 30 days; form answers 12 months. Deleting a contact MUST cancel their waiting links where possible, keep requests and orders without their name or phone, and delete their form answers.
- **FR-045**: The platform MUST measure payment links made and failed, notifications received and rejected, payments by status, carts and form answers, and alert when notifications stop arriving or most link attempts fail.

### Key Entities

- **Gateway connection**: the company's gateway account; provider, mode (live or test), currency, encrypted keys and notification secret, last check results, who connected it.
- **Payment request**: one customer's request to pay; contact, amount, currency, what it is for, reference, expiry, source (live chat, flow, campaign, API, store order, chat order), who or what made it, the gateway's link and id, status with times, refunded amount, tag and flow to run on payment.
- **Payment event**: one gateway notification as received; its id, type, signature result, raw body (kept 30 days) and the request it changed.
- **Catalog connection and product copy**: the linked Meta catalog and the platform's copy of its products (retailer id, name, price, currency, image, availability, last change).
- **Chat order**: a cart a customer sent; contact, items (product, quantity, price), currency, total, warnings, mode, its payment request, status.
- **Form and form version**: a form's screens and fields, its attribute and tag mapping, its Meta id and versions with their published state.
- **Form answer**: one submission; contact, form version, answers, time, and what was saved to the contact.
- **Payment reminder setting**: the reminder times before expiry and the templates used.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent can request a payment from a chat in under 30 seconds, and 95% of payment requests reach the customer within 10 seconds of the agent confirming.
- **SC-002**: 99% of payment status changes show in live chat, on the contact and on the Payments page within 1 minute of the gateway reporting them.
- **SC-003**: Repeated or out-of-order gateway notifications never change a payment twice: 0 duplicates in a test of 1,000 notifications with 20% repeats.
- **SC-004**: No card number or card security code is ever stored, logged or sent by the platform (checked by scanning the stored data, logs and outbound events after the test runs).
- **SC-005**: In automatic mode, 95% of carts sent in chat get a payment link for the right total within 1 minute.
- **SC-006**: A catalog of 500 products is copied within 5 minutes of connecting, and product search in live chat answers within 2 seconds.
- **SC-007**: 99% of form answers are saved to the contact within 1 minute of submission.
- **SC-008**: Reminders reach unpaid customers within 5 minutes of their set time, and none is sent twice for the same request.

## Assumptions

- The company opens (or already has) a Stripe account for the UAE business (AED), with live and test keys; one gateway is connected at a time in this feature.
- Customers pay on the gateway's own page (cards, Apple Pay and others the gateway offers); the platform never handles card data, so it stays outside card data security scope beyond storing gateway keys safely.
- Amounts are in the gateway account's currency, AED by default; one currency per connection.
- Refunds are made in the gateway's own dashboard; the platform shows them but does not start them.
- The Meta catalog is created in Meta Commerce Manager and linked to the company's WhatsApp account by the company; the platform connects to it and reads or fills it.
- WhatsApp Forms are static forms: all screens are defined in advance and answers return in the chat (no live data lookups during the form).
- Product and catalog messages follow Meta's rules: free-form product messages only in the 24-hour window; catalog and multi-product templates are marketing templates that need Meta's approval and opted-in contacts.
- Payment reminder templates are utility templates where Meta accepts them as such.
- Payment records are kept 5 years as commercial records; this can be shortened if the company's accountant prefers.

## Out of Scope

- Meta's native WhatsApp Payments (in-chat payment) — not offered in the UAE.
- Webviews and landing pages opened inside WhatsApp (item 8.5).
- Starting refunds, subscriptions or recurring payments, invoices and VAT documents beyond the gateway's own receipts.
- Several gateways at once, cash and bank transfer tracking, coupons and loyalty points.
- A storefront or checkout of our own; catalog editing beyond filling it from a connected store.
- WhatsApp Forms that look up live data during the form.

## Dependencies

- Feature 001: templates, sending, contacts and consent, roles and audit.
- Feature 002: live chat, the contact profile, notifications and the journey.
- Feature 003: the flow builder, its interpreter and test panel (commerce steps).
- Feature 005: campaign groups for retargeting non-payers.
- Feature 006: outbound webhooks, the public API with key permissions, Shopify and WooCommerce stores.
- The company's Stripe account (live and test keys, business verification by Stripe) and its notification (webhook) settings.
- A Meta catalog in Commerce Manager linked to the WhatsApp account, and the catalog permission on the company's Meta app.
- WhatsApp Forms available on the company's WhatsApp account, and Meta's approval of payment, catalog and multi-product templates.
