# Feature Specification: More Template Types, Campaign Reports and the Website Chat Button

**Feature Branch**: `009-templates-growth`
**Created**: 2026-11-27
**Status**: Draft
**Input**: User description: "Templates and campaign growth (feature 009), following the AiSensy inventory row "Templates and campaign growth" (items 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9 and 4.11; 5.3, 5.6, 5.13 and 5.14; 12.1 and 12.2). Scope: (1) More template types: authentication (OTP) templates with a copy-code or one-tap button and a way for company systems to send codes through the API; carousel templates (up to 10 cards, each with an image or video, a card text and up to 2 buttons) with the card media chosen when sending; limited-time offer templates with an expiry countdown and an offer code; a time-to-live per template so delivery attempts stop after a window; media from a URL for campaigns and the API. (2) A library of our own original sample templates by industry and purpose that can be copied into a draft. (3) Help where it is needed: template guidelines, the meaning of each broadcast error, and Meta's limit on marketing messages per person (frequency capping) explained where it applies. (4) Campaigns: an option to message duplicate numbers in an uploaded CSV; replied counts and a reply rate in campaign results; downloadable reports for a campaign, for each team member, an overview across campaigns, and opt-ins and opt-outs. (5) A website chat button: number, colour, button text, position, margins, corner radius, pre-filled message, brand name, image and greeting, settings per page address, and a generated snippet to paste on the company website; plus a simple WhatsApp link and QR generator, reusing the 006 chat links where they fit. Reuse 001-008 patterns: test-first, mock-meta routes, audit entries, roles and retention. Public information only; our own design and wording."

**Context**: Features 001–008 are built. This feature covers the row "Templates and campaign growth"
of `docs/research/aisensy/feature-inventory-2026-11-19.md`: items 4.1 (authentication templates,
which the 001 editor refuses today), 4.3, 4.4, 4.5, 4.6, 4.7 (media from a URL; today media is
uploaded), 4.9, 4.11, 5.3 (today duplicates in an upload are always merged), 5.6 (replied exists
as a 005 retarget group but not as a results column), 5.13 (today only the campaign export
exists), 5.14, 12.1 and 12.2 (the 006 chat links already make tracked links and QR codes). We match
the documented behaviour, not the look: screens, labels, sample texts and help texts are our own
(constitution Principle II). Meta's rules for each template type are public and are checked against
Meta's current documentation during planning.

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Authentication template** | Meta's template type for one-time codes. Meta fixes its wording ("… is your verification code"); the company chooses a few options: a security note, how long the code is valid, and the button. |
| **One-time code (OTP)** | A short code that the company's own website or app makes when a person signs in or confirms an action, and asks the platform to send over WhatsApp. |
| **Copy-code button** | A button under the code message that copies the code so the person can paste it. |
| **One-tap button** | A button that fills the code straight into the company's Android app. Phones without the app see a copy-code button instead. |
| **Carousel template** | A marketing or utility template with a short text followed by up to 10 cards that the person swipes through. Each card has an image or video, a short card text and up to 2 buttons. |
| **Limited-time offer template** | A marketing template that shows an offer with a countdown to its end and an offer code the person can copy. |
| **Time-to-live** | How long WhatsApp keeps trying to deliver a template message. After it, a message that has not been delivered is dropped and reported as not delivered in time. |
| **Media from a URL** | A header image, video or document taken from a public web address instead of a file uploaded to the platform. |
| **Sample template** | A ready-made template written by us for an industry and purpose, which a member copies into a draft, adjusts and submits. |
| **Error meaning** | A plain explanation of a WhatsApp delivery error and what to do about it. |
| **Frequency capping** | Meta's limit on how many marketing messages one person receives from businesses in a period. Messages above the limit are not delivered (error 131049) and are not charged. |
| **Replied** | As defined in 005: the contact wrote to the campaign's number within 3 days after their campaign message was delivered. |
| **Reply rate** | Replied recipients divided by delivered recipients. |
| **Website chat button** | A floating WhatsApp button on the company's website. Visitors open a small greeting card and start a WhatsApp chat with a pre-filled message. |
| **Page rule** | A setting of the website chat button for some page addresses: hide the button there, or use another message or greeting. |
| **Snippet** | The few lines of code the company's web team pastes into the website to show the chat button. |
| **Chat link** | As in 006: a short link and QR code that open a WhatsApp chat with a pre-filled message, counting opens and chats started. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send one-time codes through WhatsApp (Priority: P1)

A manager creates an authentication template: they choose the language, whether to add the security
note ("do not share this code"), how many minutes the code stays valid, and the button (copy code,
or one-tap for the company's Android app with the app's details). They submit it to Meta, and its
approval status syncs like any other template. An admin gives an API key the permission to send
codes. When a person signs in on the company's website, the company's system asks the platform to
send a code it made to the person's number with that template. The code reaches WhatsApp at once,
ahead of campaign traffic, and the company's system can follow the delivery status. Nobody on the
team can read a sent code afterwards.

**Why this priority**: Codes are the most time-critical messages the company sends; a fast, reliable
code channel helps sign-ups and payments right away, and the 001 editor refuses this template type
today.

**Independent Test**: Create and approve an authentication template on mock Meta, create an API key
with the code permission, send a code to a test number through the API, and see the message
delivered with a copy-code button, its status available to the caller, and the code masked
everywhere in the platform.

**Acceptance Scenarios**:

1. **Given** the template editor, **When** a manager chooses the authentication type, **Then** the body is Meta's fixed wording (not editable), and they can set the security note, the code validity (within Meta's range) and a copy-code or one-tap button; one-tap asks for the app's package name and signature hash.
2. **Given** an approved authentication template and an API key with the code permission, **When** the company's system sends a code for a valid number, **Then** the platform accepts it at once, sends it ahead of campaign messages, and returns an id whose status (sent, delivered, read, failed with a reason) the caller can read and receive through the 006 outbound webhooks.
3. **Given** a sent code, **When** anyone looks at the message in the platform, its logs, exports or webhook events, **Then** the code is masked and cannot be recovered.
4. **Given** a number that asked for more codes than the limit in a short time, **When** another code is requested, **Then** it is refused with a clear "too many codes" error and nothing is sent.
5. **Given** a person who opted out of marketing messages, **When** the company's system sends them a code they asked for, **Then** the code is sent; a blocked number is refused.
6. **Given** an API key without the code permission, **When** it tries to send a code, **Then** it is refused, and keys with the code permission cannot send other templates unless they also have that permission.

---

### User Story 2 - Carousel templates with cards chosen at send time (Priority: P1)

A manager creates a carousel template: a short text, then 2 to 10 cards. Every card has the same
kind of media (all images or all videos), a short card text that may use variables, and the same set
of up to 2 buttons (quick replies, website or phone buttons). They upload sample media for each card
and submit it to Meta. When they build a campaign with it, they choose each card's media (from the
media library or a web address), fill the variables, and see a preview of the swipeable cards before
launch. Recipients get the carousel; quick replies from any card come back to the chat and to flows
like other buttons.

**Why this priority**: Showing several products or offers in one message is one of the most used
marketing formats, and campaigns are the platform's core.

**Independent Test**: Create a 3-card image carousel on mock Meta, approve it, launch a campaign to
test contacts with different media per card, and check that each recipient's message carries the
chosen media, card texts and buttons, and that a quick reply from card 2 is recorded against that
card.

**Acceptance Scenarios**:

1. **Given** the editor, **When** a manager builds a carousel, **Then** the platform enforces Meta's limits: 2–10 cards, one media type for all cards, the card text length, up to 2 buttons per card, and the same button layout on every card; problems show next to the card and field.
2. **Given** an approved carousel, **When** a member builds a campaign, **Then** they choose the media for each card (by default the sample given at creation), fill the message and card variables, and see a preview of the cards.
3. **Given** a card media file of the wrong type or too large, **When** it is chosen, **Then** it is refused before launch with the card number and the reason.
4. **Given** a sent carousel, **When** a recipient taps a quick reply on a card, **Then** live chat shows which card and button it came from, and flows triggered by template buttons (003) can start from it.
5. **Given** carousel messages, **When** the campaign results open, **Then** they count sent, delivered, read, replied, clicked (for tracked website buttons, 005) and failed like any campaign.

---

### User Story 3 - Limited-time offers with a countdown and a code (Priority: P2)

A manager creates a limited-time offer template: an optional image or video, the offer text, a short
offer heading, whether the offer shows an end time, a copy-code button with an example code and a
website button. In a campaign they set when the offer ends and the code (the same for everyone, or
each person's own code from the upload or a contact attribute). Recipients see the offer with a
countdown to its end and can copy the code.

**Why this priority**: Offers with a deadline drive sales; it builds on the carousel and campaign
work but is not needed for the first release of the feature.

**Independent Test**: Create and approve an offer template on mock Meta, launch a campaign with an
end time two days ahead and per-contact codes from an upload column, and check that each message
carries the end time and the person's own code.

**Acceptance Scenarios**:

1. **Given** the editor, **When** a manager builds an offer template, **Then** it is a marketing template with the offer heading, the copy-code and website buttons and no footer, within Meta's limits.
2. **Given** a campaign with an offer template, **When** the member sets the end time and code, **Then** the end time must be in the future and later than the scheduled start, and the code comes from one value or from an upload column or attribute for each recipient.
3. **Given** an offer whose end time passes while the campaign is still sending or paused, **When** more messages would be sent, **Then** they are not sent and are counted as "offer ended".
4. **Given** a recipient without a code value when per-recipient codes are used, **When** the campaign starts, **Then** that recipient is skipped with the reason "missing offer code", like other missing variables.

---

### User Story 4 - Stop late delivery, and send media from a web address (Priority: P2)

A manager sets a time-to-live on a template, within the range Meta allows for its category (short
for codes, longer for updates and offers). Messages that WhatsApp cannot deliver in that time are
dropped and shown as "not delivered in time" instead of arriving hours later. A member running a
campaign with a media header can take the media from a public web address, either one address for
everyone or each person's own address from the upload or a contact attribute (for example each
customer's invoice). The API accepts a media address too.

**Why this priority**: Late codes and late reminders confuse customers, and personal documents by
address save uploading files one by one; both are small additions to existing sending.

**Independent Test**: Set a short time-to-live on a utility template, send to a mock number that
holds delivery, and see the message reported as not delivered in time; then launch a document
campaign with a different address per recipient and check each message's media address.

**Acceptance Scenarios**:

1. **Given** the editor, **When** a manager sets a time-to-live, **Then** only values within Meta's range for the template's category are accepted, and the template shows its time-to-live.
2. **Given** a sent message whose time-to-live passed before delivery, **When** WhatsApp reports it, **Then** the message shows "not delivered in time" in results and reports, and retry rounds (005) do not retry it.
3. **Given** a paused or scheduled campaign, **When** it resumes after the template's time-to-live has passed for messages queued long ago, **Then** the platform's own queue drops those messages as "expired before sending" (a time-to-live counts from when the message was queued).
4. **Given** a campaign with media from a web address, **When** it is launched, **Then** each address is checked first (secure address, reachable, right type and size); problems block the launch with the rows and reasons, and an address that fails at send time fails only that message with a clear reason.
5. **Given** the public API, **When** a template with a media header is sent with a media address, **Then** it is sent with that address and the same checks apply.

---

### User Story 5 - Replies, duplicates and reports (Priority: P2)

A member sees how many recipients replied and the reply rate in each campaign's results, and can
filter the recipients to those who replied. When uploading a list where one number appears on
several rows (for example several orders of one customer), they can choose to send one message per
row instead of one per number. Managers download reports: a campaign report, a report for each team
member, an overview across all campaigns for a date range, and a report of opt-ins and opt-outs with
their sources.

**Why this priority**: Results and reports are how the company judges its messaging; most of the
data already exists and only needs to be counted and exported.

**Independent Test**: Run a campaign to test contacts where two reply, check the replied count and
rate, upload a list with repeated numbers with the option on and off, and download each report for a
date range, checking totals against the campaign results.

**Acceptance Scenarios**:

1. **Given** a campaign whose recipients replied, **When** its results open, **Then** they show the replied count and the reply rate (replied ÷ delivered) and a Replied filter, using exactly the 005 definition so the count matches the Replied retarget group.
2. **Given** an upload where a number appears on several rows, **When** the member turns on "send to every row", **Then** each row gets its own message with its own variables; opted-out, blocked and invalid numbers are still skipped; the estimate counts every message; with the option off, one message per number is kept as today.
3. **Given** a date range, **When** a manager opens the overview report, **Then** it shows totals for all campaigns in the range by day: sent, delivered, read, replied, clicked, failed (by reason) and estimated cost, with the same totals in the downloaded file.
4. **Given** a date range, **When** a manager opens the team member report, **Then** each member shows the campaigns they launched with their results and their live chat activity (chats closed and replies sent).
5. **Given** a date range, **When** a manager opens the opt-in and opt-out report, **Then** it lists each consent change with the contact, time and source (import, keyword, form, lead form, API, store or by hand) and counts by source and day; agents see phone numbers masked.
6. **Given** any report, **When** it is downloaded, **Then** the file matches what the screen shows, the download is recorded in the audit log, and only roles allowed to export can download.

---

### User Story 6 - A library of sample templates (Priority: P3)

A member opens the sample library, filters by industry (for example retail, food, health, education,
real estate, travel, services), purpose (welcome, order update, appointment reminder, payment
reminder, offer, feedback, one-time code) and type (text, media, carousel, offer, authentication),
previews a sample with example values, and copies it into a new draft for one of the company's
WhatsApp accounts. They adjust the text and submit it like any template.

**Why this priority**: Samples speed up writing templates that Meta approves, but the team can work
without them.

**Independent Test**: Filter the library to "food" and "order update", copy a sample into a draft,
and see the draft pre-filled with the sample's category, texts, buttons and example values, ready to
edit and submit.

**Acceptance Scenarios**:

1. **Given** the library, **When** a member filters and searches, **Then** they see matching samples with a preview, the category Meta is expected to give, and the type.
2. **Given** a sample, **When** the member copies it, **Then** a new draft is created with the sample's content and examples and a name they can change; the sample itself is unchanged and is never submitted on its own.
3. **Given** the library, **Then** every sample is our own original text, follows the template rules of this platform, and contains no other company's brand or wording.

---

### User Story 7 - Help where it is needed (Priority: P3)

While writing a template, a member can open short guidelines for the part they are editing (category,
variables, media, buttons, carousel, offer, code templates) and the common reasons Meta rejects
templates. In campaign results and message details, every failure reason shows what it means and
what to do. When a member prepares a marketing campaign, the platform explains Meta's per-person
limit on marketing messages; when results show messages held back by that limit, it says how many
and why, and that they are not charged.

**Why this priority**: Help reduces rejected templates and support questions, but every feature
works without it.

**Independent Test**: Open the guidelines from each editor section, view a campaign with failures of
several kinds and check each reason's explanation, and check the frequency capping notes in the
marketing campaign wizard and in results with error 131049.

**Acceptance Scenarios**:

1. **Given** the template editor, **When** a member opens help for a section, **Then** they see guidelines for that section in our own words, including common rejection reasons.
2. **Given** campaign results or a message with a failure, **When** the failure reason is shown, **Then** its meaning and suggested action appear next to it; an error code without an entry shows Meta's own text and general advice.
3. **Given** a marketing template in the campaign wizard, **When** the member reviews the campaign, **Then** a note explains the per-person limit on marketing messages and that held-back messages are not charged.
4. **Given** results with messages held back by the limit, **When** they open, **Then** the held-back count is shown with the explanation, and retry rounds (005) keep holding them back.

---

### User Story 8 - A WhatsApp chat button for the website, and a link and QR generator (Priority: P3)

A manager designs a chat button for the company's website: the WhatsApp number, the colour, the
button text, the corner (bottom left or right), the distance from the edges, the roundness, the
brand name and image, a greeting, and the pre-filled message. Page rules hide the button on some
pages (for example the checkout) or use another message on others (for example a product page
asks about that product). They copy the snippet and give it to the web team. Visitors who open the
greeting and start a chat arrive in live chat with the pre-filled message; the button shows how many
visitors opened it and how many chats started, by page. Separately, anyone on the team can make a
quick WhatsApp link and QR code for a number and message, download the QR, and save it as a tracked
chat link (006) if they want counts.

**Why this priority**: The website button brings new chats from the company's existing visitors; it
is independent of the other stories and builds on the 006 chat links.

**Independent Test**: Design a button with one page rule, open a test page with the snippet, check
the look and position, open the greeting and start a chat, and see the chat arrive with the page's
message and the button's counts rise; make a link and QR in the generator and save it as a chat link.

**Acceptance Scenarios**:

1. **Given** the button designer, **When** a manager changes a setting, **Then** a live preview shows the button and greeting as visitors will see them, on desktop and phone sizes.
2. **Given** a saved button, **When** the manager copies the snippet, **Then** pasting it on any web page shows the button with those settings, and later changes in the platform apply without changing the snippet.
3. **Given** page rules, **When** a visitor opens a page whose address matches a rule, **Then** the rule's choice applies (hidden, or another message or greeting); pages without a matching rule use the defaults.
4. **Given** a visitor who starts a chat, **When** their message arrives, **Then** live chat shows that it came from the website button and which page, and the counts of opens and chats started for that button and page go up.
5. **Given** the button's number is disconnected, **When** a visitor opens a page, **Then** the button is not shown, and the manager sees a warning.
6. **Given** the generator, **When** a member enters a number and a message, **Then** they get a WhatsApp link and a QR code to download, and can save them as a tracked chat link for a connected number.

---

### Edge Cases

- Meta changes the fixed wording or options of authentication templates: the editor offers only what Meta's current rules allow, and a template Meta refuses shows Meta's reason.
- The company's system sends a code longer or shorter than Meta allows, or with letters where only digits are expected: the request is refused with the rule broken, and nothing is sent.
- A code is requested for a number that is not on WhatsApp: the request is accepted, then the status becomes failed with the reason, so the company's system can offer another channel.
- A code request arrives while the number's quality or messaging limit stops sending: it fails at once with a clear reason rather than waiting in a queue.
- One-tap is chosen but the person's phone does not have the app: the message shows a copy-code button instead (Meta's behaviour), and the platform reports it as delivered normally.
- A carousel's cards do not all have the same buttons, or one card has a video while others have images: the editor shows the card and the rule before submission.
- A carousel's card media address fails at send time: the whole message fails with the card number and reason (a carousel is sent as one message).
- An offer's end time is earlier than the campaign's scheduled start: the launch is refused.
- A time-to-live is set below or above Meta's range for the category: it is refused; changing a template's category clears a time-to-live that no longer fits.
- A media address points to a page instead of a file, needs a login, or is not secure (http): it is refused at the launch check.
- With "send to every row", the same number appears on 500 rows: each row is a message, subject to the number's messaging limits and Meta's per-person limits; the estimate warns about repeated recipients.
- A reply arrives after 3 days: it does not count as replied (005 definition), so results and retarget groups agree.
- A report range is longer than the data kept (12 months for messages): the range is refused with the earliest available date.
- A team member was removed: their campaigns still appear in the team member report under their name.
- A page rule matches several patterns: the first matching rule in the manager's order applies.
- The website blocks outside scripts by its security settings: the snippet does not break the page; the setup guide explains what the web team must allow.
- Robots and link previews open the button's link: they are not counted as opens (as in 005 and 006).
- A sample is copied for a WhatsApp account whose language is not the sample's: the draft keeps the sample's language, which the member can change.
- An error code appears that has no explanation yet: Meta's text is shown with general advice, and the code is listed for the help to be extended.

## Requirements *(mandatory)*

### Functional Requirements

**Authentication templates and one-time codes**

- **FR-001**: Members who manage templates MUST be able to create authentication templates with Meta's fixed wording, choosing the language, the optional security note, the code validity within Meta's range, and a copy-code or one-tap button (one-tap needs the Android app's package name and signature hash).
- **FR-002**: Authentication templates MUST be submitted to Meta and have their approval status synced like other templates (001), and MUST NOT accept media, website buttons or other content Meta does not allow for this type.
- **FR-003**: The public API MUST let a company system send a one-time code it made to a phone number with an approved authentication template, returning an id at once, and MUST let it read the status and receive status changes through the 006 outbound webhooks.
- **FR-004**: Sending codes MUST need its own API key permission; a key with only that permission MUST NOT send other templates, and the code template to use MUST be chosen by the caller or by an admin default.
- **FR-005**: Codes MUST be sent ahead of campaign and drip messages on the same number and MUST NOT wait behind them.
- **FR-006**: The platform MUST limit how many codes one phone number can receive in a period (default 5 in 15 minutes, set by an admin) and refuse requests above it with a clear error.
- **FR-007**: A code MUST be sent to a person who asked for it even if they opted out of marketing, MUST NOT be sent to a blocked number, MUST NOT change the person's consent and MUST NOT add them to the contact list.
- **FR-008**: The code itself MUST NOT be stored or shown after sending: messages, logs, exports, audit entries and webhook events MUST show it masked.

**Carousel templates**

- **FR-009**: Members who manage templates MUST be able to create carousel templates with a message text and 2–10 cards, each card with an image or video (the same type on every card), a card text with optional variables, and up to 2 buttons in the same layout on every card, within Meta's limits.
- **FR-010**: The editor MUST check every carousel rule before submission and show each problem next to the card and field.
- **FR-011**: When a carousel template is used in a campaign, the member MUST choose each card's media (defaulting to the sample from creation, from the media library or a web address) and fill the message and card variables, with a preview of the cards before launch.
- **FR-012**: Button replies from carousel cards MUST arrive in live chat with the card and button they came from, and MUST be usable as template button triggers for flows (003).
- **FR-013**: Carousel campaigns MUST have the same results, retargeting, retry rounds and click tracking as other campaigns (001, 005).

**Limited-time offer templates**

- **FR-014**: Members who manage templates MUST be able to create limited-time offer templates (marketing) with optional image or video, the offer text, the offer heading, whether an end time is shown, a copy-code button with an example code and a website button, without a footer, within Meta's limits.
- **FR-015**: A campaign with an offer template MUST take the offer's end time (in the future and after the scheduled start) and the offer code (one value, or per recipient from an upload column or contact attribute).
- **FR-016**: Messages of an offer whose end time has passed MUST NOT be sent and MUST be counted as "offer ended".
- **FR-017**: Recipients without a code value when per-recipient codes are used MUST be skipped with the reason "missing offer code".

**Time-to-live**

- **FR-018**: Members who manage templates MUST be able to set a time-to-live on a template within the range Meta allows for its category; values outside the range MUST be refused.
- **FR-019**: Messages that WhatsApp reports as not delivered within their time-to-live MUST show "not delivered in time" in results and reports and MUST NOT be retried by retry rounds.
- **FR-020**: Messages still waiting in the platform's own queue when their template's time-to-live has passed since they were queued MUST NOT be sent and MUST be counted as "expired before sending".

**Media from a web address**

- **FR-021**: A campaign with a media header MUST accept media from a secure web address, one for all recipients or one per recipient from an upload column or contact attribute.
- **FR-022**: Before launch, the platform MUST check each media address (secure, reachable, the header's media type and within the size limit) and block the launch with the rows and reasons when any fail; an address that fails at send time MUST fail only that message with the reason.
- **FR-023**: The public API MUST accept a media address for templates with a media header, with the same checks.

**Sample templates**

- **FR-024**: The platform MUST offer a library of at least 60 sample templates written by us, covering at least 10 industries and the purposes welcome, order update, appointment reminder, payment reminder, offer, feedback and one-time code, across the types text, media, carousel, offer and authentication; at least 10 samples MUST also be offered in Arabic.
- **FR-025**: Members MUST be able to filter samples by industry, purpose, type and language, search them, and preview them with example values and the expected category.
- **FR-026**: Copying a sample MUST create a new draft for a chosen WhatsApp account with the sample's content, examples and a changeable name; samples MUST NOT be changed or submitted directly.

**Help**

- **FR-027**: The template editor MUST offer guidelines for each section (category, variables, media, buttons, carousel, offer, authentication) and the common reasons Meta rejects templates, in our own words.
- **FR-028**: Every failure reason shown in campaign results, reports and message details MUST show its meaning and a suggested action; at least the error codes the platform already handles (001–008) MUST have an entry, and codes without one MUST show Meta's text with general advice.
- **FR-029**: The campaign wizard MUST explain Meta's per-person limit on marketing messages when a marketing template is chosen, and results MUST show how many messages were held back by it, with the explanation and that they are not charged.
- **FR-030**: Help content MUST be editable by the platform's maintainers without changing the screens, and MUST state the date it was last checked against Meta's documentation.

**Campaign options and results**

- **FR-031**: Campaign results MUST show the replied count, the reply rate (replied ÷ delivered) and a Replied filter on the recipients, using the 005 definition of replied.
- **FR-032**: Uploads MUST offer "send to every row" so that a number on several rows gets one message per row with that row's variables; the default MUST stay one message per number, and opted-out, blocked and invalid numbers MUST still be skipped.
- **FR-033**: The campaign estimate and results MUST count messages per row when "send to every row" is on, and MUST show how many recipients received more than one message.

**Reports**

- **FR-034**: Managers and admins MUST be able to see and download an overview report for a date range: totals by day for all campaigns (sent, delivered, read, replied, clicked, failed by reason, estimated cost), also split by template category and by number.
- **FR-035**: Managers and admins MUST be able to see and download a team member report for a date range: for each member, the campaigns they launched with their results, and their live chat activity (chats closed and replies sent, from 002).
- **FR-036**: Managers and admins MUST be able to see and download an opt-in and opt-out report for a date range: each consent change with contact, time and source, and counts by source and day.
- **FR-037**: The campaign report download (001) MUST include replied, clicked and the new statuses (not delivered in time, expired before sending, offer ended).
- **FR-038**: Report downloads MUST match the screen, MUST need the export permission, MUST be recorded in the audit log, MUST mask phone numbers for roles that see them masked, and MUST refuse ranges older than the data kept.

**Website chat button**

- **FR-039**: Managers MUST be able to create website chat buttons with: the WhatsApp number (a connected number), the colour, the button text, the corner (bottom left or bottom right), the distance from the edges, the corner roundness, the brand name and image, the greeting and the pre-filled message.
- **FR-040**: The designer MUST show a live preview of the button and greeting at desktop and phone sizes.
- **FR-041**: Managers MUST be able to add page rules that match page addresses (exact, starts with, contains) to hide the button or to use another greeting or pre-filled message, in an order they choose, the first match applying.
- **FR-042**: The platform MUST generate a snippet for each button; the snippet MUST show the button on any web page, MUST pick up later setting changes without being pasted again, MUST NOT set cookies or collect personal data, and MUST NOT break the page when it cannot load.
- **FR-043**: Starting a chat from the button MUST go through a 006 chat link so that live chat shows the button and page it came from, and opens and chats started are counted per button and page, without robots and previews.
- **FR-044**: The button MUST hide itself while its number is disconnected, and the manager MUST be warned.

**Link and QR generator**

- **FR-045**: Members MUST be able to enter a phone number and a message and get a WhatsApp link and a QR code (downloadable as an image), without saving anything.
- **FR-046**: For a connected number, the generator MUST offer to save the link as a tracked chat link (006).

**Cross-cutting**

- **FR-047**: Roles: authentication, carousel and offer templates and time-to-live follow the template permissions (001); the code API needs its own key permission (FR-004); reports need manager or admin and the export permission for downloads; website buttons follow the chat link permissions (006); samples and help are open to every member.
- **FR-048**: Every change to templates, code settings, website buttons and page rules, every API key permission change and every report download MUST be recorded in the audit log.
- **FR-049**: Retention: code messages MUST be kept 30 days (with the code masked); website button opens and chats started 12 months like chat links; report files MUST be removed within 24 hours of being made; other data follows 001–006.
- **FR-050**: Deleting a contact MUST remove them from report data the same way as from campaign data (001, 005), and code messages to their number MUST lose the phone number.
- **FR-051**: New outbound webhook events MUST cover code status changes (sent, delivered, read, failed) without the code.
- **FR-052**: Every new screen and message MUST use our own design and wording; nothing may copy another company's screens, texts, samples or help.

### Key Entities

- **Template (extended)**: gains the authentication type (security note, code validity, button kind and app details), carousel cards (media type, card texts, buttons), offer details (heading, end time shown, code and website buttons) and an optional time-to-live.
- **Code message**: one one-time code sent for a company system: the phone number, the template, the API key, the status with its reason and times; the code is never kept.
- **Code limit**: the admin's limit of codes per phone number per period.
- **Campaign (extended)**: gains "send to every row", media from a web address (one or per recipient), card media for carousels, and the offer's end time and code source.
- **Sample template**: a read-only template written by us: industry, purpose, type, language, content, example values and expected category.
- **Error meaning**: a delivery error code with its meaning, suggested action and the date it was checked.
- **Report**: a requested overview, team member, opt-in and opt-out or campaign report: its type, date range, who asked and when, and its short-lived file.
- **Website chat button**: a design for the company's website: number, look, texts, image, pre-filled message, its chat link, snippet id and counts.
- **Page rule**: one rule of a website chat button: how it matches page addresses, its order, and whether it hides the button or changes the greeting or message.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A manager creates an authentication template and has it submitted in under 3 minutes, and a code requested through the API is handed to WhatsApp within 2 seconds in 95% of requests, even while a campaign is sending on the same number.
- **SC-002**: No sent code can be found in stored messages, logs, exports or webhook events (checked by scanning them after the test runs).
- **SC-003**: In a carousel campaign, 100% of delivered messages carry the card media and variables chosen for that recipient.
- **SC-004**: No message of an offer is sent after the offer's end time, and no message is sent from the platform's queue after its time-to-live (100% in tests with paused and resumed campaigns).
- **SC-005**: With "send to every row" on, an upload of 1,000 rows with 100 repeated numbers sends 1,000 messages; with it off, 900, as today.
- **SC-006**: The replied count in campaign results always equals the size of the 005 Replied retarget group for the same campaign.
- **SC-007**: Reports for a 30-day range covering 100,000 messages show on screen and download in under 30 seconds, and their totals match the campaign results.
- **SC-008**: A member finds a fitting sample and has it as an editable draft in under 1 minute; the library has at least 60 samples in at least 10 industries.
- **SC-009**: Every failure reason the platform shows has an explanation and a suggested action (100% of the codes handled in 001–008).
- **SC-010**: The website chat button adds less than 30 KB to a page, appears within 1 second of the page loading on a typical phone connection, and counts 100% of chats started from it (robots and previews excluded).
- **SC-011**: The template rejection rate for templates made from samples is lower than for templates written from scratch over the first 3 months (tracked on the templates page).

## Assumptions

- Meta's rules for authentication, carousel and limited-time offer templates, the time-to-live ranges per category and media by address are public and are checked against Meta's current documentation in planning; the platform follows whatever Meta allows at that time.
- One-time codes are made and checked by the company's own website or app; the platform only delivers them and reports delivery. Checking codes is not part of this feature.
- A person who asks for a code on the company's website or app has asked for that message, so a code is not marketing and is sent even after a marketing opt-out (blocked numbers excepted).
- Zero-tap codes (filled in with no tap) need extra terms with Meta and are not included.
- Samples are written in English, with Arabic versions of at least 10; more languages can be added later.
- The company's web team can paste the snippet into the website; the website is public and served over a secure address.
- The team member report uses who launched each campaign (001 records it) and the 002 live chat activity.
- Messages are kept 12 months (001), so reports cover at most the last 12 months.

## Out of Scope

- Checking one-time codes for the company's systems (a verification service).
- Zero-tap authentication.
- Chat buttons inside the company's mobile apps (websites only).
- Reports sent by email on a schedule.
- Automatic translation of templates or samples.
- Webviews and landing pages inside WhatsApp (inventory item 8.5).

## Dependencies

- 001 templates, campaigns, uploads, reports, the public API and consent; 002 live chat activity and
  the journey; 003 template button triggers for flows; 005 the replied definition, retarget groups,
  retry rounds and click tracking; 006 chat links, API key permissions and outbound webhooks.
- Meta's WhatsApp Cloud API template types and message parameters for authentication, carousel and
  limited-time offer templates, time-to-live and media by address; mock-meta routes for each in
  tests and local runs.
- The company's web team, to paste the website snippet.
