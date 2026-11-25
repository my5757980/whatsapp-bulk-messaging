# Feature Specification: Integrations and Developer Platform

**Feature Branch**: `006-integrations-platform`
**Created**: 2026-11-24
**Status**: Draft
**Input**: User description: "Integrations and developer platform (feature 006) for the company's WhatsApp platform, the next row of the AiSensy-parity roadmap (docs/research/aisensy/feature-inventory-2026-11-19.md items 5.9, 7.8, 11.2-11.7, 1.1 and QR flow triggers from 7.2). Scope: (1) API campaigns: named, live API campaigns bound to one approved template that other systems trigger with parameters, media, tags and attributes, creating contacts when new, with per-campaign results; (2) a fuller public API for contacts, tags and attributes (create, update, look up, tag and untag) with the existing API keys, idempotency and rate limits; (3) outbound webhooks: members register HTTPS endpoints and choose events (message status, inbound messages, opt-ins and opt-outs, contact changes, clicks, drip events), signed deliveries with retries, a delivery log and a test send, so Zapier, Make, Pabbly, n8n and CRMs can connect without named connectors; (4) Shopify and WooCommerce stores: connect a store, then order notifications (confirmed, fulfilled or shipped, delivered, cancelled), cash-on-delivery confirmation with the customer's button reply updating the order, abandoned cart reminders (up to 3), each mapped to an approved template, with per-automation results; (5) QR codes and short wa.me links that start a chat with a pre-filled message and optionally a chosen flow, with scan-to-reply tracking; (6) a guided number connection wizard that checks each Meta setting step by step instead of pasting ids. Out of scope: Meta Embedded Signup (needs Tech Provider status), Dialogflow (optional, later on request), payments, ads, named CRM connectors. Same rules as 001-005: original design and wording (no copying AiSensy), Meta's rules (opt-in for marketing, the 24-hour window, template approval), secrets encrypted and never logged, audit of sensitive changes, roles admin/manager/agent."

**Context**: This is the next part of the order the user chose on 2026-11-19 (live chat, flows,
the AI agent, campaign growth, then integrations). It covers items 5.9, 11.2–11.7 and 1.1 and the
QR code part of 7.2 and 5.10 of `docs/research/aisensy/feature-inventory-2026-11-19.md`. Item 7.8
(Dialogflow) is left for later. We match the documented behaviour, not the look: screens, labels
and wording are our own (constitution Principle II).

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Webhook endpoint** | A web address of another system (a CRM, Zapier, Make, Pabbly, n8n or the company's own software) that the platform sends events to. |
| **Event** | Something that happened on the platform that other systems may want to know, such as a message being delivered, a customer writing or a contact opting out. |
| **Delivery** | One attempt to send one event to one endpoint, with the answer the endpoint gave. |
| **Signing secret** | A secret shared with one endpoint. Every delivery carries a signature made with it, so the receiver can check the event came from the platform and was not changed. |
| **API key permission** | What an API key may do: send messages (as today), read contacts, change contacts, or trigger API campaigns. |
| **API campaign** | A named, always-on campaign bound to one approved template and one number. Other systems trigger it for one person at a time through the API. |
| **Trigger** | One API call to an API campaign for one phone number, with its values. |
| **Store connection** | A link between the platform and one of the company's online stores (Shopify or WooCommerce). |
| **Store event** | What a store reports: an order placed, paid, shipped, delivered or cancelled, or a checkout started. |
| **Order notification** | A WhatsApp template message sent to the customer when a store event happens. |
| **Cash-on-delivery (COD) confirmation** | A message asking a customer who chose to pay on delivery to confirm or cancel the order with a button. |
| **Abandoned cart** | A checkout where the customer gave a phone number but did not place the order within a set time. |
| **Recovered order** | An order placed by a customer after a reminder about their abandoned cart. |
| **Chat link** | A short link, also offered as a QR code, that opens WhatsApp with a chat to the company's number and a pre-filled message ready to send. |
| **Opened** | Someone opened a chat link or scanned its QR code. |
| **Chat started** | The customer sent the chat link's pre-filled message, so the platform knows which link they came from. |
| **Connection wizard** | Guided steps that connect a WhatsApp number and check each Meta setting it needs. |

Campaign, template, contact and consent terms come from 001, live chat terms from 002, flow terms
from 003, AI agent terms from 004, and tracked links and drips from 005.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send platform events to other systems (Priority: P1)

An admin adds a webhook endpoint: its web address, a name and the events it should receive (message
statuses, customer messages, opt-ins and opt-outs, contact changes, clicks, and drip joining and
leaving). The platform shows a signing secret once and offers a test event. From then on, every
chosen event is sent to the endpoint with a signature. When the endpoint does not answer or answers
with an error, the platform tries again later. Each endpoint has a delivery log with the event, the
time, the answer and the attempts, and failed deliveries can be sent again by hand.

**Why this priority**: Webhooks let the company's CRM, Zapier, Make, Pabbly, n8n or its own
software follow what happens on WhatsApp without a named connector for each system. Most other
integrations build on them.

**Independent Test**: Add an endpoint that collects requests, choose message statuses and customer
messages, and send the test event. Send a template to two contacts and reply from one. The endpoint
receives a signed event for each sent, delivered and read status and for the reply, each once and
each with its own id. Stop the endpoint for 10 minutes and start it again: the events missed in
between arrive through retries, and the log shows every attempt.

**Acceptance Scenarios**:

1. **Given** an admin adds an endpoint with an `https://` address and chooses events, **When** they save it, **Then** the signing secret is shown once, and only the chosen events are sent to it from then on.
2. **Given** an endpoint, **When** the admin sends a test event, **Then** the endpoint receives a signed test event, and the answer (status and time) shows on the screen.
3. **Given** an event the endpoint chose happens, **When** it is delivered, **Then** the delivery carries the event's kind, id, time and details, plus a signature the receiver can check with the signing secret.
4. **Given** the endpoint answers with an error or does not answer in time, **When** the delivery fails, **Then** the platform tries again with growing waits for up to 24 hours, and every attempt is in the delivery log.
5. **Given** an endpoint keeps failing for 24 hours, **When** the last attempt fails, **Then** the endpoint is paused, admins are alerted, and the events are kept so they can be sent again after it is fixed.
6. **Given** a failed delivery in the log, **When** an admin chooses to send it again, **Then** it is delivered again with the same event id.
7. **Given** an address that is not `https://`, or one that points to a private or local network, **When** an admin saves it, **Then** it is refused with the reason.

---

### User Story 2 - Manage contacts from other systems through the API (Priority: P1)

A developer at the company uses an API key to keep contacts in step with the CRM or the shop. With
the right permissions, the key can create or update a contact by phone number, look one up by phone
number or id, set attributes, add and remove tags, record an opt-in (with where it came from) or an
opt-out, list contacts changed since a given time, and add a contact to a drip. Existing keys keep
only the permission to send messages until an admin gives them more.

**Why this priority**: With webhooks, this makes the platform a full partner for the company's
other systems. Contacts stay the same in both places without CSV files.

**Independent Test**: With a key allowed to change contacts, create a contact with two tags and an
attribute, then send the same phone number with a new name. The contact is updated, not
duplicated. Remove a tag, record an opt-out and look the contact up. The dashboard and the
contact's journey show each change as made by that API key. A key with only the send permission
gets a clear "not allowed" answer.

**Acceptance Scenarios**:

1. **Given** a key allowed to change contacts, **When** it sends a phone number that does not exist yet, **Then** a contact is created with the given name, tags and attributes, and the answer gives its id.
2. **Given** a contact exists with that phone number, **When** the key sends it again, **Then** the contact is updated, never duplicated. Phone numbers are matched in their international form.
3. **Given** a key, **When** it asks for a contact by phone number or id, **Then** it gets the contact's name, tags, attributes and consent status. Agents' masking rules do not apply to keys, but every read is limited to the key's permissions.
4. **Given** a request that records an opt-in, **When** it has no source note, **Then** it is refused, as in the dashboard. An opt-out is always accepted, and it always wins.
5. **Given** a request repeated with the same idempotency key, **When** it arrives again, **Then** the first answer is returned and nothing is changed twice.
6. **Given** a key sends more requests than its limit, **When** the limit is passed, **Then** it gets a "too many requests" answer with when to try again, as in 001.
7. **Given** a key with only the send permission, **When** it tries to read or change contacts, **Then** it gets a clear "not allowed" answer, and nothing changes.
8. **Given** a key allowed to change contacts and an active drip, **When** it adds a contact to the drip, **Then** the contact joins under the drip's usual rules (005): no opted-out or blocked contacts, and no second active enrolment.

---

### User Story 3 - Trigger named API campaigns from other systems (Priority: P2)

A manager creates an API campaign, for example "Order feedback". They pick one approved template
and one number, and map the template's variables to values the calling system sends, to contact
fields or to fixed text. They can add a header image or document, tags and attributes to set on
the contact, and choose whether new phone numbers become contacts. Then they set it live. The
company's other systems trigger it with a phone number and values. Each trigger sends one message,
and the campaign shows its results: triggers, sent, delivered, read, failed (with reasons) and
clicks, in total and per day.

**Why this priority**: Most automatic messages from other systems (order updates from a custom shop,
appointment reminders, feedback requests) are the same template again and again. A named campaign
keeps the template, mapping and rules in the dashboard, so developers send only a name, a phone
number and values, and managers see results per purpose.

**Independent Test**: Create a live API campaign with a template that has two variables. Trigger it
three times: for a new phone number, for an existing contact, and again with the same idempotency
key as the first call. Two messages are sent. The new number becomes a contact with the campaign's
tag. The repeated call returns the first answer. The campaign's results show 2 triggers and their
statuses.

**Acceptance Scenarios**:

1. **Given** a manager builds an API campaign, **When** they set it live, **Then** every template variable must have a value source, and the campaign has a stable name that the API uses.
2. **Given** a live API campaign, **When** a key allowed to trigger campaigns calls it with a phone number and values, **Then** one message is queued, and the answer gives the message id.
3. **Given** a value the mapping needs is missing from the call, **When** it is triggered, **Then** the call is refused, the reason names the missing value, and nothing is sent.
4. **Given** the campaign's template is a marketing template, **When** the contact has not opted in, **Then** no message is sent unless the call records an opt-in with a source note, as in 001.
5. **Given** a paused or stopped API campaign, **When** it is triggered, **Then** the call is refused with a clear "paused" or "stopped" answer.
6. **Given** a live API campaign, **When** a manager opens it, **Then** they see triggers, sent, delivered, read, failed with reasons and clicks, in total and per day, and can export the messages.
7. **Given** the campaign's template stops being approved, or the number disconnects, **When** that happens, **Then** the campaign pauses itself, calls are refused with the reason, and managers are alerted.

---

### User Story 4 - Send order notifications from the company's store (Priority: P2)

An admin connects the company's Shopify or WooCommerce store. They grant access from the store's
own admin, then choose the WhatsApp number and the default country for phone numbers. A manager
then turns on the order notifications they want: order confirmed, order shipped (with the tracking
link), order delivered and order cancelled. Each one uses an approved template, with its variables
mapped to order details such as the customer's name, the order number, the total and the tracking
link. When the store reports the event, the customer gets the message. Customers become contacts,
tagged with the store. Each notification shows its results.

**Why this priority**: Order updates are what customers expect most on WhatsApp, and they reduce
"where is my order" questions in live chat. They need the store connection that the COD and
abandoned cart stories reuse.

**Independent Test**: Connect a test store and turn on "Order confirmed" with a utility template.
Place a test order with a UAE mobile number. The customer gets one message within a minute with the
order number and total. The store sends the same event again: nothing more is sent. An order
without a valid phone number is skipped, with the reason in the results.

**Acceptance Scenarios**:

1. **Given** an admin connects a store, **When** the connection succeeds, **Then** the platform confirms it receives the store's order events, and the store shows as connected with its name.
2. **Given** a notification is turned on with a template and mapping, **When** the store reports that event for an order, **Then** the customer gets the message once per order and per notification, even when the store reports the event more than once.
3. **Given** an order's phone number is missing or not valid for WhatsApp, **When** the notification would go out, **Then** it is skipped, and the results show the reason.
4. **Given** a customer who opted out on WhatsApp, **When** their order is placed, **Then** no notification is sent, and the results show the reason.
5. **Given** a store event arrives for a new customer, **When** it is handled, **Then** the customer becomes a contact with the store's tag. They are never opted in unless the store's consent covers WhatsApp (see Assumptions).
6. **Given** the store connection stops working (access removed or the store unreachable), **When** this is noticed, **Then** the store shows the problem, admins are alerted, and events are fetched again once it is fixed, for up to 3 days back.
7. **Given** a manager opens a notification's results, **When** they look, **Then** they see the orders, sent, delivered, read, failed and skipped, each with reasons.

---

### User Story 5 - Confirm cash-on-delivery orders on WhatsApp (Priority: P2)

For orders that will be paid on delivery, the customer gets a confirmation message with buttons
to confirm or cancel. When they tap one, the order in the store is marked with their answer, and
they get a short reply. A customer who does not answer gets one reminder after a chosen time. If
there is still no answer, the order is marked as not confirmed. Cancelling the order in the store
automatically when the customer taps Cancel is a setting, off by default. The team sees each
order's confirmation status.

**Why this priority**: Unconfirmed cash-on-delivery orders cost the company shipping both ways. A
one-tap confirmation before shipping saves that cost. It builds on the store connection of User
Story 4.

**Independent Test**: Place three cash-on-delivery test orders. Tap Confirm on the first: within a
minute the store order shows the "confirmed on WhatsApp" mark, and the customer gets the thank-you
reply. Tap Cancel on the second: it shows the "cancelled on WhatsApp" mark, and with automatic
cancelling on, the order is cancelled in the store. Leave the third unanswered: the reminder goes
out, and later the order shows "no answer".

**Acceptance Scenarios**:

1. **Given** cash-on-delivery confirmation is on, **When** a cash-on-delivery order is placed, **Then** the customer gets the confirmation template with its two buttons, and the order is marked as waiting for confirmation.
2. **Given** the customer taps Confirm or Cancel, **When** the answer arrives, **Then** the store order is marked with the answer and the time within a minute, and the customer gets the chosen reply. The reply is inside the 24-hour window, so it is free text.
3. **Given** automatic cancelling is on, **When** the customer taps Cancel, **Then** the order is also cancelled in the store. When it is off, only the mark is added, and the team is told.
4. **Given** no answer within the chosen time (default 6 hours), **When** the time passes, **Then** one reminder is sent. When the second wait passes with no answer, the order is marked as not confirmed.
5. **Given** a customer taps a button again after answering, **When** it arrives, **Then** the first answer stays, and the customer is told the order was already confirmed or cancelled.
6. **Given** the order is cancelled or changed to prepaid in the store before the customer answers, **When** that event arrives, **Then** no reminder is sent, and later taps do not change the store order.
7. **Given** a manager opens the results, **When** they look, **Then** they see the orders asked, confirmed, cancelled, not confirmed and failed.

---

### User Story 6 - Remind customers about abandoned carts (Priority: P3)

A manager turns on cart reminders for a connected store. They choose up to three reminders, each
with an approved template and a wait (defaults: 1 hour, 24 hours and 3 days after the checkout).
When a checkout with a phone number is not followed by an order within the first wait, the
customer gets the first reminder with a link back to their cart. Reminders stop as soon as the
customer orders, opts out or writes to the company. Reminders go only to customers who agreed to
marketing messages on WhatsApp. The results show the carts, the reminders sent, clicks, recovered
orders and the value recovered.

**Why this priority**: Recovering carts brings direct revenue, but reminders are marketing messages
with stricter consent rules. They come after the order notifications that every store needs.

**Independent Test**: Start a test checkout with an opted-in phone number and do not order. After
the first wait, the customer gets reminder 1 with their cart link. Open the link and order before
the second wait. No further reminder goes out, and the results show one recovered order with its
value.

**Acceptance Scenarios**:

1. **Given** cart reminders are on, **When** a checkout with a phone number is not followed by an order within the first wait, **Then** reminder 1 is sent with the customer's own cart link.
2. **Given** the customer has not agreed to marketing messages on WhatsApp, **When** a reminder would go out, **Then** it is not sent, and the results count the cart as skipped for consent.
3. **Given** the customer orders, opts out or writes to the company after a reminder, **When** that happens, **Then** no further reminder is sent for that cart.
4. **Given** an order placed within 7 days after a reminder for the same customer and store, **When** it is reported, **Then** it counts as a recovered order with its value.
5. **Given** a checkout updated several times, **When** reminders are due, **Then** each cart gets each reminder at most once, with the latest cart contents and link.
6. **Given** a manager opens the results, **When** they look, **Then** they see carts, reminders sent per step, clicks, recovered orders and recovered value, with the reasons for skipped carts.

---

### User Story 7 - Start chats with QR codes and chat links (Priority: P3)

A manager creates a chat link for one of the numbers. They give it a name, a pre-filled message
(for example "Hi, I saw your poster at the mall"), and optionally a flow to start and a tag for the
people who come through it. The platform gives a short link and a QR code to download as an image
or as a printable poster. Scanning the code or opening the link opens WhatsApp with the message
ready. When the customer sends it, the chat starts in live chat, the chosen flow runs, and the
contact gets the tag. Each chat link shows how many times it was opened, how many chats started
and how many new contacts came, and the contacts can be exported, tagged or used as a campaign
audience.

**Why this priority**: QR codes on posters, packaging and shop counters bring customers into chats.
They need little set-up and use flows that exist already.

**Independent Test**: Create a chat link "Shop counter" with the flow "Welcome" and the tag
"counter". Open the link twice and send the pre-filled message from one phone. The results show 2
opens, 1 chat started and 1 new contact, the flow ran, and the contact has the tag.

**Acceptance Scenarios**:

1. **Given** a manager creates a chat link, **When** they save it, **Then** they get a short link on the company's web address, a QR code image and a printable poster of our own design.
2. **Given** someone opens the link or scans the code, **When** WhatsApp opens, **Then** the chat to the right number has the pre-filled message ready, and the opening is counted. Link previews and robots are not counted (as in 005).
3. **Given** the customer sends the pre-filled message, **When** it arrives, **Then** the chat counts as started for that link, the chosen flow starts (before keyword flows and the AI agent), and the contact gets the chosen tag.
4. **Given** the customer edits the message before sending, **When** the platform cannot tell which link it came from, **Then** the chat is handled as a normal customer message and is not counted for any link.
5. **Given** a chat link is turned off, **When** someone opens it, **Then** they see a short page saying the link is no longer in use, and nothing opens.
6. **Given** a manager opens a chat link's results, **When** they look, **Then** they see opens, chats started and new contacts per day, and can export, tag or retarget the contacts who started chats.

---

### User Story 8 - Connect a WhatsApp number with guided checks (Priority: P3)

An admin connecting a new WhatsApp number uses a wizard instead of pasting ids. They paste the
access token from Meta's business settings once. The platform checks it and lists the WhatsApp
accounts and numbers it can reach, and the admin picks one. The platform then checks each Meta
setting the number needs and shows a plain fix for each one that fails:
- the token's permissions and expiry
- the number's registration for sending, its two-step PIN and its display name status
- its quality rating and messaging limit
- the platform receiving the account's webhooks

Finally it sends a test message to the admin's own phone. The manual form stays for experts.

**Why this priority**: Connecting a number is done once per number. The manual form works today,
but the wizard prevents the most common set-up mistakes before go-live.

**Independent Test**: Run the wizard against the test Meta service with a token that lacks a
permission. The wizard names the missing permission and how to add it. Run it again with a correct
token: pick the number, every check passes, the test message arrives, and the number shows as
connected.

**Acceptance Scenarios**:

1. **Given** an admin pastes a token, **When** the platform checks it, **Then** it shows whether the token is valid, which needed permissions are missing, and when it expires (a token that expires is flagged, with how to make one that does not).
2. **Given** a valid token, **When** the platform lists accounts and numbers, **Then** the admin picks one, and no id needs to be typed.
3. **Given** the chosen number, **When** the checks run, **Then** each check shows passed, failed or warning, with a plain explanation and the fix.
4. **Given** the number is not yet registered for sending, **When** the admin enters the two-step PIN, **Then** the platform registers it and checks again.
5. **Given** webhook delivery is not set up for the account, **When** the admin confirms, **Then** the platform subscribes the account to the company's app and waits for a test event to arrive.
6. **Given** all checks pass, **When** the admin sends the test message to their own phone, **Then** they confirm it arrived, and the number is saved as connected. The token is stored encrypted, as in 001.

---

### Edge Cases

- **Endpoint slow or down:** an endpoint that does not answer within 10 seconds counts as failed for
  that attempt. Events keep queuing for it, and events for other endpoints are not held up.
- **Duplicate deliveries:** a retry after a timeout may reach an endpoint that did receive the
  first attempt. Each event has a fixed id, and the help text tells receivers to ignore repeats.
- **Order of events:** deliveries may arrive out of order (for example "read" before "delivered"
  after a retry). Each event carries its own time, and the help text says so.
- **Endpoint deleted with events waiting:** waiting events for it are dropped and stay in the log
  as cancelled.
- **Secret rotated:** for 24 hours after a new signing secret is made, deliveries carry signatures
  for both the old and the new secret, so the receiver can switch without missing events.
- **API contact with a phone in local form:** the number is read with the company's default country
  (001). A number that cannot be read is refused with the reason.
- **Two systems change one contact at once:** the last change wins for each field. Tags are added
  and removed one by one, so two systems adding different tags keep both.
- **API campaign triggered for an opted-out contact:** the call is answered as "not sent: opted out"
  and appears in the results. It is never queued.
- **Store reports events late or twice:** an order event older than 3 days is not sent (the order
  update would be stale), and each order event sends at most once.
- **Order cancelled before "order confirmed" goes out:** only the cancellation is sent, if it is on.
- **Order with two phone numbers:** the shipping phone is used, then the billing phone, then the
  customer's account phone. The one used is shown in the results.
- **Customer in another country:** phone numbers are read with the store's default country when
  they have no country code. Messages still follow Meta's pricing per country (001).
- **COD answer by text instead of a button:** a reply such as "yes" or "confirm" does not change the
  order. It reaches live chat (002) so a member can handle it.
- **Cart without a phone number:** no reminder is possible, and it is not counted as a cart.
- **Store disconnected while reminders are waiting:** waiting reminders and COD reminders pause.
  They are dropped with a note if the store is not back within 24 hours.
- **Chat link to a disconnected number:** the link page says the chat is not available and shows no
  WhatsApp button.
- **Chat link message sent by someone already in a flow or a live chat:** the chat link still
  counts the chat as started, but a running flow or a member's chat is not interrupted (003 rules).
- **Wizard with a token for several businesses:** all reachable accounts are listed with their
  business names, and the admin picks one.
- **Wizard on a number already connected:** the wizard says so and offers to run the checks only.
- **Deleted contact:** API reads no longer find them. Webhook deliveries already sent cannot be
  recalled, but no new events mention them. Store orders keep only their order numbers, not the
  person.

## Requirements *(mandatory)*

### Functional Requirements

**Outbound webhooks**

- **FR-001**: Admins MUST be able to add, edit, pause, resume and delete webhook endpoints, each with
  a name, an `https://` address and the events it receives. Addresses on private, local or reserved
  networks MUST be refused.
- **FR-002**: The events offered MUST include:
  - message statuses (sent, delivered, read, failed), for campaigns, API messages, API campaigns,
    drips, flows, the AI agent and live chat replies
  - customer messages received, with their content
  - opt-ins and opt-outs
  - contacts created, changed and deleted, and tags added and removed
  - tracked link clicks (005)
  - contacts joining, finishing and leaving drips (005)
  - live chats assigned and closed (002)
  - API campaign triggers
  - store notifications sent and COD answers
- **FR-003**: Each endpoint MUST have its own signing secret, shown in full once when created or
  renewed. Every delivery MUST carry a signature over its content and time, so the receiver can
  check it and refuse old or replayed deliveries.
- **FR-004**: Each event MUST carry a unique id, its kind, the time it happened and its details in a
  documented, versioned format. Phone numbers MUST be in international form.
- **FR-005**: Deliveries that fail (an error answer, no answer within 10 seconds, or an address that
  cannot be reached) MUST be tried again with growing waits for up to 24 hours. A delivery MUST
  count as done only when the endpoint answers with success.
- **FR-006**: An endpoint whose deliveries all fail for 24 hours MUST be paused, admins MUST be
  alerted, and its waiting events MUST be kept for 3 days so they can be sent after it is fixed.
- **FR-007**: Each endpoint MUST have a delivery log covering the last 30 days. For each event it
  shows the kind, time, state, attempts, and the answer's status and time. Admins MUST be able to
  send a delivery again and to send a test event.
- **FR-008**: One slow or failing endpoint MUST NOT delay deliveries to other endpoints or any
  sending, live chat or flow.
- **FR-009**: Admins MAY leave customer message content out of an endpoint's events. The setting
  MUST be shown when the endpoint is created.

**Public API for contacts**

- **FR-010**: API keys MUST have permissions:
  - send messages (the 001 behaviour)
  - read contacts
  - change contacts
  - trigger API campaigns
  - add contacts to drips
  Keys created before this feature MUST keep only "send messages" until an admin changes them.
- **FR-011**: A key allowed to change contacts MUST be able to create or update a contact by phone
  number (matched in international form) with name, tags and attributes. Attribute values MUST
  follow their types, as in imports.
- **FR-012**: A key allowed to read contacts MUST be able to:
  - look a contact up by phone number or id
  - list contacts, filtered by tag or by "changed since"
  - list tags and attribute definitions
- **FR-013**: A key allowed to change contacts MUST be able to add and remove tags and record an
  opt-out at any time. It MUST be able to record an opt-in only with a source note, as in the
  dashboard (001 FR-012).
- **FR-014**: A key allowed to add contacts to drips MUST be able to enrol a contact in an active
  drip by its name or id and remove them from it, under the drip's rules (005 FR-025, FR-027).
- **FR-015**: Every changing request MUST accept an idempotency key with the 001 rules. Every
  request MUST count against the key's rate limit (001 FR-037).
- **FR-016**: Changes made through the API MUST show in the contact's journey and the audit log as
  made by that API key. They MUST raise the same webhook events and drip starting events as
  changes made in the dashboard.

**API campaigns**

- **FR-017**: Managers MUST be able to create API campaigns, each with:
  - a unique name and a stable name for the API
  - one number and one approved template
  - a mapping for every template variable, from a value in the call, a contact field or fixed text
  - an optional header image, video or document
  - tags and attributes to set on the contact
  - whether new phone numbers become contacts
  - an optional daily limit
- **FR-018**: An API campaign MUST be able to be live, paused or stopped. Calls to a campaign that is
  not live MUST be refused with its state. Changing the template or mapping of a live campaign
  MUST take effect for new calls only.
- **FR-019**: A key allowed to trigger campaigns MUST be able to trigger a live API campaign for one
  phone number with named values, an optional media link and an optional opt-in with a source
  note. The answer MUST give the message id or the reason it was not sent.
- **FR-020**: Triggers MUST follow the 001 sending rules:
  - consent (marketing templates need an opt-in, opted-out contacts never get messages)
  - the number's sending speed and Meta's limits
  - pricing
  Triggers MUST count towards the daily limit when one is set.
- **FR-021**: An API campaign MUST pause itself when its template stops being approved or its number
  disconnects, refuse calls with the reason, and alert managers.
- **FR-022**: Each API campaign MUST show triggers, sent, delivered, read, failed (with reasons) and
  clicks on tracked links (005), in total and per day. Its messages MUST be exportable.

**Store connections**

- **FR-023**: Admins MUST be able to connect up to 5 online stores (Shopify or WooCommerce). For each
  store they choose the WhatsApp number, the default country for phone numbers, and the tag given
  to its customers. Access MUST be granted from the store's own admin, and the platform MUST
  confirm it receives the store's events.
- **FR-024**: Store access details MUST be stored encrypted, MUST never be shown again after saving,
  and MUST never appear in logs. Admins MUST be able to disconnect a store, which stops all its
  automations and asks the store to stop sending events.
- **FR-025**: The platform MUST check that each store event really comes from the store, and MUST
  ignore events it cannot check.
- **FR-026**: When a store connection stops working, the store MUST show the problem and admins MUST
  be alerted. Once it works again, events from up to the last 3 days MUST be fetched again.
- **FR-027**: Customers in store events MUST become or update contacts with the store's tag, name
  and phone number. A store's marketing consent MUST count as a WhatsApp opt-in only when an admin
  has confirmed that the store's consent text names WhatsApp. The opt-in source is then recorded as
  the store.
- **FR-028**: Store events MUST be able to start drips (005), for example "order placed" or "order
  delivered", as new starting events.

**Order notifications**

- **FR-029**: Managers MUST be able to turn on, for each store, notifications for:
  - order confirmed (placed)
  - order shipped, with the tracking number and link when the store has them
  - order delivered
  - order cancelled
  Each notification has an approved template and a mapping from order details: customer name, order
  number, total with currency, items summary, tracking number and link, and store name.
- **FR-030**: Each notification MUST be sent at most once per order. An event older than 3 days when
  it arrives MUST NOT be sent.
- **FR-031**: Orders without a valid WhatsApp phone number, and orders of customers who opted out,
  MUST be skipped with the reason. Marketing templates MUST NOT be used for order notifications
  without an opt-in, as in 001.
- **FR-032**: A tracking link in a notification MAY be a tracked link (005), so clicks are counted.
- **FR-033**: Each notification MUST show orders, sent, delivered, read, failed and skipped, with
  reasons.

**Cash-on-delivery confirmation**

- **FR-034**: Managers MUST be able to turn on COD confirmation for a store with:
  - a template that has two quick-reply buttons (confirm and cancel)
  - the replies sent after each answer
  - the reminder wait (default 6 hours)
  - the final wait before "not confirmed" (default 24 hours after the order)
  - whether cancelling in the store is automatic (off by default)
- **FR-035**: A tap on confirm or cancel MUST mark the store order with the answer and its time
  within a minute. It MUST send the matching reply, and it MUST show in live chat as automatic
  (002).
- **FR-036**: Only the first answer per order MUST count. Later taps get a reply naming the first
  answer.
- **FR-037**: Orders not answered within the reminder wait MUST get one reminder. Orders still
  unanswered at the final wait MUST be marked as not confirmed in the store. Orders cancelled or
  paid in the store first MUST get no reminder.
- **FR-038**: COD results MUST show orders asked, confirmed, cancelled, not confirmed and failed.

**Abandoned carts**

- **FR-039**: Managers MUST be able to turn on cart reminders for a store, with up to 3 reminders.
  Each has an approved template and a wait after the checkout (defaults: 1 hour, 24 hours and 3
  days; at least 30 minutes; at most 7 days).
- **FR-040**: A checkout with a phone number and no order within the first wait MUST count as an
  abandoned cart. Each reminder MUST be sent at most once per cart, with the customer's own cart
  link (a tracked link, 005).
- **FR-041**: Reminders MUST go only to contacts who agreed to WhatsApp marketing messages (FR-027,
  001 consent rules). Skipped carts MUST be counted with the reason.
- **FR-042**: Reminders for a cart MUST stop when the customer places an order, opts out, is blocked
  or writes to the company's number.
- **FR-043**: An order by the same customer at the same store within 7 days after a reminder MUST
  count as recovered, with its value.
- **FR-044**: Cart results MUST show:
  - carts
  - reminders sent per step
  - clicks
  - recovered orders and the value recovered (in the store's currency)
  - skipped carts by reason

**Chat links and QR codes**

- **FR-045**: Managers MUST be able to create, edit, turn off and delete chat links. Each has a name,
  a number, a pre-filled message (up to 500 characters), an optional flow to start and an optional
  tag.
- **FR-046**: Each chat link MUST have a short link on the company's public web address (the 005 link
  address), a QR code image to download (PNG and SVG), and a printable poster of our own design.
- **FR-047**: Opening the link MUST send the person on to WhatsApp with the chat and the pre-filled
  message ready, within 1 second. Openings MUST be counted, excluding link previews and robots
  (005 rules).
- **FR-048**: The pre-filled message MUST carry a short reference that lets the platform tell which
  link a chat came from. When it arrives, the chat MUST count as started for that link, the
  contact MUST get the link's tag, and the link's flow MUST start. A running flow or a member's
  chat MUST NOT be interrupted.
- **FR-049**: Each chat link MUST show opens, chats started and new contacts per day. The contacts
  who started chats MUST be exportable, taggable and usable as a campaign audience.
- **FR-050**: A turned-off or deleted chat link MUST show a short "no longer in use" page and send
  no one on.

**Number connection wizard**

- **FR-051**: Admins MUST be able to connect a number through a wizard that:
  1. checks a pasted access token (validity, needed permissions, expiry)
  2. lists the WhatsApp accounts and numbers the token can reach, and lets the admin pick one
  3. checks the chosen number
- **FR-052**: The wizard's checks MUST cover:
  - the token's permissions and expiry
  - the number's registration for sending and its two-step PIN
  - the display name status
  - the quality rating and messaging limit
  - the account's webhook subscription to the company's app, with a test event received
  Each check MUST show passed, failed or warning, with a plain fix.
- **FR-053**: The wizard MUST be able to register an unregistered number with the admin's two-step
  PIN, and subscribe the account to the company's app, when the admin confirms.
- **FR-054**: The wizard MUST end with a test message to the admin's own phone. The number is saved
  as connected only after the admin confirms it arrived, or chooses to save without the test. The
  token MUST be stored encrypted, as in 001.
- **FR-055**: The wizard MUST also run on a connected number as a health check, without changing it
  unless the admin confirms a fix.

**Permissions, audit, retention and privacy**

- **FR-056**: Permissions MUST be:
  - Only admins: webhook endpoints, API key permissions, store connections and the number wizard.
  - Admins and managers: API campaigns, store automations (notifications, COD, cart reminders) and
    chat links (`campaigns.manage` to build, `campaigns.launch` to set live, pause and stop).
  - Agents: results only, with masked phone numbers (`campaigns.view`).
- **FR-057**: The audit log MUST record:
  - endpoints added, changed, paused, resumed and deleted, secrets renewed, and deliveries resent
  - API key permissions changed
  - stores connected and disconnected, and store consent confirmed
  - API campaigns and store automations created, changed, set live, paused and stopped
  - chat links created, changed, turned off and deleted
  - numbers connected or fixed through the wizard
- **FR-058**: Secrets (signing secrets, store access details and Meta tokens) MUST be stored
  encrypted, MUST never be shown again after saving, and MUST never appear in logs, exports or
  audit details.
- **FR-059**: Retention:
  - delivery logs are kept 30 days
  - store orders, carts and COD answers follow the 12-month retention of 001
  - chat link openings follow the click retention of 005 (12 months)
- **FR-060**: Deleting a contact MUST:
  - remove them from waiting reminders and COD confirmations
  - remove the link between them and store orders, carts and chat link records
  - stop new webhook events about them
  Anonymous counts stay.

### Key Entities

- **Webhook endpoint**: name, address, chosen events, whether message content is included, state
  (active, paused by an admin, paused after failures), signing secret (encrypted), and when it last
  succeeded and failed.
- **Event**: one thing that happened, with its id, kind, time and details. It is shared by the
  deliveries of all endpoints that chose it.
- **Webhook delivery**: one event for one endpoint, with its state, attempts, next try, and the last
  answer's status and time.
- **API key permission**: the permissions of an existing 001 API key.
- **API campaign**: name and API name, number, template, mapping, media, tags and attributes to set,
  the new-contact rule, daily limit and state.
- **API campaign trigger**: one call, with its values, the resulting message (001) or the reason
  nothing was sent, and the idempotency key.
- **Store connection**: platform (Shopify or WooCommerce), address, name, access details
  (encrypted), number, default country, customer tag, consent setting, state and last event time.
- **Store automation**: one notification, COD confirmation or cart reminder set for a store, with
  its template or templates, mapping, waits, settings and state.
- **Store order**: the store's order id and number, customer, phone used, total and currency,
  payment kind, status, and the notifications and COD answer for it.
- **Abandoned cart**: the store's checkout id, customer phone, contents summary, value, cart link,
  reminders sent, and whether and when it was recovered.
- **Chat link**: name, number, pre-filled message and its reference, flow, tag, short link, state,
  and its openings and chats started.
- **Connection check**: one wizard run on a number, with each check's result, the time and the
  admin who ran it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a healthy endpoint, 99% of events are delivered within 10 seconds of happening. In
  a test where an endpoint is down for 1 hour, every event of that hour is delivered within 1 hour
  after it comes back, and none is lost.
- **SC-002**: Contact API requests are answered within 1 second for 95% of requests, at each key's
  default limit. In a test of 1,000 creates and updates of the same 200 phone numbers, there is
  exactly one contact per number.
- **SC-003**: For 95% of API campaign triggers, the message is handed to WhatsApp within 5 seconds.
  In a test of 500 triggers with 100 repeated idempotency keys, no message is sent twice.
- **SC-004**: For 95% of store order events, the customer's notification is handed to WhatsApp
  within 1 minute. In a test of 500 store events with 100 duplicates, every order gets each
  notification exactly once.
- **SC-005**: For 95% of COD answers, the store order shows the customer's answer within 1 minute.
- **SC-006**: In a test of 300 checkouts mixing orders, opt-outs, replies and missing consent, no
  reminder reaches a customer who ordered, opted out, wrote to the company or did not agree to
  marketing messages.
- **SC-007**: For 95% of chat link openings, the person reaches WhatsApp within 1 second. The opens
  and chats started shown equal the underlying records exactly.
- **SC-008**: An admin who has not connected a number before connects one with the wizard in under
  15 minutes. Every failed check names its fix.
- **SC-009**: No secret (webhook signing secrets, store access details, Meta tokens, API keys)
  appears in logs, exports, the audit log or the dashboard after saving. 100% of deliveries carry a
  signature that checks out with the endpoint's secret.

## Assumptions

- **Stores:**
  - Shopify and WooCommerce are supported; OpenCart is not.
  - The company connects its own stores (up to 5), not stores of other businesses. Planning chooses
    each platform's way of granting access for a single store owner from current Shopify and
    WooCommerce documentation.
  - Stores send order and checkout events as they happen. Planning also chooses how missed events
    are fetched again.
  - WooCommerce has no abandoned cart event of its own (research R8). For WooCommerce stores, cart
    reminders cover orders left unpaid, linking to the order's payment page. Carts that were never
    submitted are covered for Shopify only.
- **Template categories and consent:**
  - Order notifications and COD confirmations use utility templates. Meta decides the category at
    approval.
  - Abandoned cart reminders are marketing messages under Meta's rules, so they need an opt-in.
  - As in 001, utility templates go to contacts who have not opted out, and marketing templates
    only to contacts who opted in. The release checklist reminds the company to tell customers in
    the store that order updates come on WhatsApp, as Meta's opt-in policy requires.
- **Webhook deliveries:**
  - Deliveries reach each endpoint at least once.
  - Receivers must accept a repeated event id.
  - Retries use growing waits for up to 24 hours.
- **API:**
  - The public API keeps the 001 limits: 60 requests a minute per key by default, adjustable by
    admins.
  - API campaign triggers and contact requests count against the same limit.
- **No-code tools:** Zapier, Make, Pabbly and n8n connect through their generic webhook and web
  request steps. A short guide per tool is part of the documentation, and no listing in their app
  stores is planned.
- **Chat links:**
  - They use the company's public web address (the 005 tracked link address) to count openings.
  - They then send people on to WhatsApp's own chat link. The reference in the pre-filled message
    is short and readable, for example "(ref SHOP12)".
- **Number wizard:** it uses the same Meta access as the manual connection in 001. Meta's current
  permission names and checks are confirmed against Meta's documentation during planning.
- **Limits and defaults:** the 6-hour COD reminder, the 24-hour COD final wait, the cart waits, the
  7-day recovery window, the 3-day limit for stale events and the 30-day delivery log are starting
  values confirmed during planning.
- **Company:** one company uses the platform, as in 001–005, with numbers in the UAE and prices in
  USD. Store totals keep the store's own currency.

## Out of Scope

- Meta Embedded Signup and serving other businesses' numbers (needs Meta Tech Provider status).
- Connecting a Dialogflow bot (item 7.8), on request later.
- Payments and payment links (Razorpay, PayU), product catalogs and carts in WhatsApp (the Commerce
  feature).
- Named connectors in other companies' app stores (a Zapier or Make app), and named CRM connectors
  (WebEngage, CleverTap, LeadSquared and others). Webhooks and the API cover them.
- OpenCart and other store platforms.
- Starting flows or AI agent conversations from other systems through the API.
- Click-to-WhatsApp ads (the Ads feature).
- Email or SMS from store events.

## Dependencies

- **001**:
  - the public API with keys, idempotency and rate limits
  - campaigns, templates and their approval, variable mapping
  - contacts, tags, attributes, consent and opt-in rules
  - numbers with their Meta connection, sending speed and limits, and pricing
  - roles, the audit log, retention, contact deletion and the encrypted storage of secrets
- **002**: live chat, automatic messages in the timeline, the customer journey, button replies and
  the 24-hour window.
- **003**: flows, which a chat link starts, and the order in which flows answer customer messages.
- **004**: the AI agent, which answers after flows.
- **005**: tracked links and their public address (cart and tracking links, chat links), the rules
  for link previews and robots, drips and their starting events.
- **External**:
  - the company's Shopify or WooCommerce store, with admin access to grant
  - Meta's business settings for tokens, numbers and webhooks
  - the receivers of webhooks (the company's CRM or no-code tools)
  - the public HTTPS address used by 005
