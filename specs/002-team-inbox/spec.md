# Feature Specification: Shared Team Inbox (Live Chat)

**Feature Branch**: `002-team-inbox`
**Created**: 2026-11-19
**Status**: Draft
**Input**: User description: "Shared team inbox (live chat) for our company's WhatsApp numbers — functionally equivalent to AiSensy's team inbox but with our own original design and wording. Every customer who messages us, and every message we send them (campaign templates, API messages, replies), appears in one conversation per contact and number. Team members see a conversation list they can filter by status (open, pending, resolved), by assignment (mine, unassigned, a teammate), by WhatsApp number and by tag, sorted by latest activity with unread counts. Opening a conversation shows the full history: inbound texts, media (image, video, audio, document, location, contacts), button and list replies, template broadcasts with their delivery ticks (sent, delivered, read, failed), and consent events such as STOP. Agents reply with free text, emojis, media files and saved quick replies while WhatsApp's 24-hour customer service window is open; outside the window only approved templates (with variables) can be sent, and the window countdown is visible. Conversations can be assigned, transferred, marked resolved or reopened, tagged, and carry internal notes the customer never sees; a new inbound message reopens a resolved conversation. Updates appear in real time without refreshing: new messages, delivery ticks, assignment changes, typing of other agents is not required. Business hours with an automatic away message outside them, plus an optional welcome message for first-time contacts. A contact panel shows name, attributes, tags, consent status and past campaigns; agents see masked phone numbers per the existing role rules, and only admins and managers can see every conversation while agents see their assigned and unassigned ones. Supervisors see basic team metrics: open conversations, first response time, resolution time per agent. Reuses existing roles, audit log, contacts, templates and numbers from feature 001. Out of scope for this feature: chatbot flows, AI agent, ads, payments, mobile app."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See and answer customer messages in one place (Priority: P1)

A customer replies to a broadcast or writes to one of the company's WhatsApp numbers. The message
appears at the top of the shared inbox for the team within moments, without anyone refreshing
the page. A team member opens the conversation and sees the whole history with this customer on
this number: the campaign messages we sent, with their delivery ticks, and everything the customer
sent, including pictures, voice notes, documents, locations, shared contacts and button choices.
The team member types a reply, with emojis if wanted. The customer receives it on WhatsApp, and
the reply shows when it is sent, delivered and read.

**Why this priority**: Today, customer replies to broadcasts go nowhere. Seeing and answering them
is the core value of a shared inbox, and every other story builds on it.

**Independent Test**: Send "Hi, is this available?" from a test phone to a connected number. The
conversation appears for a signed-in team member within 2 seconds, and the reply "Yes, it is"
reaches the phone with delivery ticks shown in the inbox. This works even if no other story of
this feature exists.

**Acceptance Scenarios**:

1. **Given** a team member has the inbox open, **When** a customer sends a message, **Then** the
   conversation moves to the top of the list within 2 seconds, with the message preview and an
   unread badge, without a page refresh.
2. **Given** an open conversation inside the 24-hour window, **When** the team member sends a text
   with emojis, **Then** the customer receives it, and the message shows sent, then delivered, then
   read as the customer's phone reports each step.
3. **Given** a contact who received a campaign earlier, **When** their conversation is opened,
   **Then** the campaign message appears in the timeline with the campaign name, the filled
   template text and its final status.
4. **Given** the customer sent an image, video, voice note or audio, document, location, contact
   card, sticker, reaction, button reply or list reply, **When** the conversation is shown, **Then**
   each appears in a readable form:
   - a picture preview
   - a playable video or audio
   - a downloadable document with its name and size
   - a map link with the address
   - the contact's name and number
   - the sticker
   - the reaction on the message it reacts to
   - the option the customer chose
5. **Given** an outgoing message that WhatsApp could not deliver, **When** the failure is reported,
   **Then** the message is marked failed with a plain-language reason.
6. **Given** a phone number that is not yet a contact, **When** it sends a message, **Then** a
   contact is created automatically, with consent unknown and the source "inbound message".

---

### User Story 2 - Respect the 24-hour window and send templates outside it (Priority: P1)

WhatsApp allows free-form replies only within 24 hours of the customer's last message. The team
member always sees how much of that window is left. Once it has closed, the reply box explains
why free text is unavailable and offers the approved templates instead. The team member picks
one, fills its variables, sees a preview and sends it. If the customer answers, the window opens
again and free replies are possible.

**Why this priority**: Without this, the team would try to send messages that WhatsApp rejects,
and could not re-engage customers after a day. It is a policy requirement for the inbox to be
usable at all.

**Independent Test**: Use a conversation whose last customer message is older than 24 hours. Free
text is blocked with an explanation. Sending an approved template with a filled variable
succeeds. After the customer replies, free text is enabled again.

**Acceptance Scenarios**:

1. **Given** the customer's last message was 23 hours ago, **When** the conversation is open,
   **Then** the reply box shows that the window closes in about 1 hour.
2. **Given** more than 24 hours have passed since the customer's last message, **When** a team
   member tries to reply, **Then** free text, media and quick replies are disabled with a short
   explanation, and an approved template can be chosen, filled, previewed and sent.
3. **Given** the window closes while a team member is typing, **When** they press send, **Then** the
   message is not sent, the draft is kept, and the template option is offered.
4. **Given** a contact who has opted out, **When** a team member tries to send a template, **Then**
   it is refused with the reason "This contact has opted out". Free replies inside an open window
   remain allowed.
5. **Given** a marketing template and a contact without opt-in, **When** a team member tries to send
   it, **Then** it is refused with the same opt-in rule as campaigns.
6. **Given** the customer replies after a template, **When** the reply arrives, **Then** the window
   restarts at 24 hours and free replies are enabled.

---

### User Story 3 - Assign, transfer, resolve and work together (Priority: P2)

Conversations can be assigned to a team member, transferred to another, unassigned, moved to
pending (waiting for the customer), resolved and reopened. Team members filter the list:
- by status
- by assignment (mine, unassigned, a specific teammate)
- by WhatsApp number
- by tag

They can also search by name or phone, and tag a conversation. They leave internal notes, which
the customer never sees, and can mention a teammate to get their attention. When a customer
writes again to a resolved conversation, it reopens on its own. Agents see only the
conversations assigned to them and the unassigned ones; admins and managers see everything.

**Why this priority**: With several people answering, the team needs ownership and hand-offs to
avoid double answers and forgotten customers. Basic replying (US1) still works without it.

**Independent Test**:
1. Assign a conversation to an agent: it shows under that agent's "Mine".
2. Add a note: the customer receives nothing.
3. Resolve the conversation, then send a new message from the customer: it reopens with the same
   assignee.
4. Sign in as another agent: the first agent's conversation is not visible.

**Acceptance Scenarios**:

1. **Given** an unassigned conversation, **When** a manager assigns it to an agent, **Then** it
   appears in that agent's "Mine" list, others see who owns it, and the timeline records the
   assignment.
2. **Given** an unassigned conversation, **When** an agent sends the first reply, **Then** the
   conversation is assigned to that agent.
3. **Given** a conversation, **When** a team member adds an internal note mentioning a teammate,
   **Then** the note is visible only to the team, looks clearly different from messages, is never
   sent to the customer, and the mentioned teammate is notified.
4. **Given** a resolved conversation, **When** the customer sends a new message, **Then** the
   conversation becomes open again and stays assigned to the same team member.
5. **Given** filters for status, assignment, number and tag, **When** they are combined, **Then** the
   list shows only matching conversations, and each status tab shows its count.
6. **Given** an agent, **When** they look for a conversation assigned to another agent, **Then** it
   is not listed and cannot be opened.
7. **Given** a team member is deactivated, **When** that happens, **Then** their open conversations
   become unassigned and visible to the team.

---

### User Story 4 - Send media and use quick replies (Priority: P2)

Inside the window, a team member can send pictures, videos, audio files and documents with an
optional caption. Admins and managers keep a list of saved quick replies, such as prices,
directions and opening hours. Any team member can insert one by typing its shortcut, adjust the
text and send it. Placeholders like the customer's name are filled in automatically.

**Why this priority**: Media and saved answers make replies fast and consistent, but text replies
(US1) already deliver the core value.

**Independent Test**:
1. Send a PDF inside the window: the customer receives it.
2. Try a file that is too large: it is blocked before sending, with the size limit shown.
3. Insert the quick reply "/hours": its saved text appears with the customer's name filled in,
   ready to edit.

**Acceptance Scenarios**:

1. **Given** an open window, **When** a team member attaches an allowed file with a caption, **Then**
   the customer receives the file and caption, and the timeline shows a preview.
2. **Given** a file of an unsupported type or above the size limit, **When** it is attached, **Then**
   sending is blocked with a message naming the allowed types and the limit.
3. **Given** a saved quick reply with the shortcut "hours" and the text "Hi {name}, we are open 9–6",
   **When** a team member types "/hours" and picks it, **Then** "Hi Sara, we are open 9–6" appears in
   the reply box, where it can still be edited before sending.
4. **Given** an agent, **When** they open the quick reply settings, **Then** they can use the
   replies but cannot create, edit or delete them.

---

### User Story 5 - Business hours, away message and welcome message (Priority: P3)

An admin sets the company's weekly business hours and time zone, an away message for customers
who write outside those hours, and a welcome message for people writing for the first time. The
platform sends these automatically and marks them as automatic in the timeline.

**Why this priority**: Automatic replies set expectations when nobody is available, but the inbox
works without them.

**Independent Test**:
1. Set business hours that exclude the current time.
2. Send a message from a test phone: the away message arrives once, and a second message a minute
   later gets no second away message.
3. Write from a brand-new number: the welcome message arrives once.

**Acceptance Scenarios**:

1. **Given** the away message is enabled and it is outside business hours, **When** a customer
   writes, **Then** the away message is sent once. It is not sent again to the same contact for 12
   hours.
2. **Given** the welcome message is enabled, **When** a phone number messages a company number for
   the first time ever, **Then** the welcome message is sent once.
3. **Given** a customer sends an opt-out or opt-in keyword, **When** it is processed, **Then** no away
   or welcome message is sent in reply. The keyword confirmation from feature 001 is the only
   reply.
4. **Given** automatic messages, **When** the timeline is shown, **Then** they are labelled automatic
   and do not count as a team member's first response.

---

### User Story 6 - Contact panel and team metrics (Priority: P3)

Next to the conversation, a panel shows who the customer is:
- name and phone, masked for agents as in feature 001
- attributes and tags
- consent status, its source and date
- their recent campaigns with each message's status

Team members with contact permissions can edit the name, attributes and tags there. Admins and
managers open a metrics view for today, the last 7 days or the last 30 days. It shows open
conversations per agent and unassigned, first response time and resolution time per agent, and
conversations resolved.

**Why this priority**: Context and oversight improve service quality, but they depend on
conversations existing (US1–US3).

**Independent Test**:
1. Open a conversation as an agent: the panel shows a masked phone, the tags and the last
   campaigns.
2. As a manager, open metrics for 7 days: the numbers match a manual count on a small sample.

**Acceptance Scenarios**:

1. **Given** an agent opens a conversation, **When** the contact panel loads, **Then** the phone
   number is masked to its last 4 digits, and attributes, tags, consent and up to 10 recent
   campaigns are shown.
2. **Given** a manager, **When** they edit a tag in the panel, **Then** the change is saved on the
   contact and is usable in campaign audiences.
3. **Given** a manager selects "last 7 days", **When** the metrics load, **Then** they show per
   agent:
   - open conversations
   - median and 90th-percentile first response time
   - median resolution time
   - conversations resolved

   Unassigned open conversations are shown as well.
4. **Given** an agent, **When** they try to open the metrics, **Then** access is refused.

---

### Edge Cases

- **Disconnected number:** a customer writes to a number that is disconnected or in error. The
  message is still stored and shown. Replies are blocked with a reason until the number works
  again.
- **Two company numbers:** the same customer writes to two company numbers. There are two separate
  conversations, one per number.
- **Simultaneous replies:** two team members reply at the same moment. Both messages are sent once
  each, in the order sent, and the conversation is assigned to whoever replied first.
- **Repeated or out-of-order webhooks:** each message appears exactly once, in the order of the
  customer's timestamps.
- **Media download fails:** WhatsApp media links expire. The platform retries, then shows "media
  unavailable" without blocking the rest of the conversation.
- **Very long conversations:** conversations with thousands of messages open at the newest message,
  and older messages load as the user scrolls up.
- **Opt-out inside a conversation:** the customer sends STOP. Consent updates as in feature 001, the
  event appears in the timeline, campaigns exclude the contact, and free replies inside the open
  window stay possible.
- **Deleted contact:** a contact is deleted under feature 001's rules. Their name, phone, message
  texts and media are erased from conversations. Counts used for metrics remain.
- **Unsupported message type:** shown as "message type not supported" with the type name, so
  nothing is silently lost.
- **Deleted or edited message:** when WhatsApp reports that the customer deleted or edited a
  message, the timeline shows that it was deleted or edited.
- **Agent offline:** an agent loses their connection for a few minutes. When it returns, the list
  and the open conversation catch up without missing messages or showing duplicates.
- **Removed quick reply:** a saved quick reply that is deleted while someone is using it. Text
  already inserted in the reply box stays and can still be sent.

## Requirements *(mandatory)*

### Functional Requirements

**Conversations and history**

- **FR-001**: The system MUST keep exactly one conversation per contact per company WhatsApp
  number. In time order, it holds:
  - every inbound message
  - every outbound message: campaign, API, inbox reply and automatic message
  - internal notes, assignment and status changes, and consent events
- **FR-002**: The system MUST store and display these inbound types: text, image, video, audio and
  voice note, document, sticker, location, contact card, reaction, button reply and list reply.
  Any other type MUST be shown as unsupported, with its type name.
- **FR-003**: The system MUST download inbound media and keep its own copy, because WhatsApp media
  links expire. Media is shown inline: picture, video or audio player, or document download with
  name and size.
- **FR-004**: A message from a phone number that is not a contact MUST create a contact with
  consent "unknown" and source "inbound message".
- **FR-005**: The conversation list MUST:
  - be sorted by latest activity
  - filter by status (open, pending, resolved), by assignment (mine, unassigned, a specific
    teammate, everyone the viewer may see), by WhatsApp number and by tag
  - be searchable by contact name or phone number
  - show a count for each status
- **FR-006**: The system MUST keep an unread count per conversation for each team member, clear it
  when that person opens the conversation, and show a total unread badge in the navigation.
- **FR-007**: New messages, delivery ticks, assignment and status changes, and notes MUST appear
  for everyone viewing the list or the conversation within 2 seconds, without a reload. After a
  dropped connection, the view MUST catch up without gaps or duplicates.
- **FR-008**: A conversation MUST open at its newest messages and load older history as the user
  scrolls up.
- **FR-009**: When a team member opens a conversation, the customer's unread messages MUST be
  marked as read on WhatsApp, so the customer sees that the company has read them.

**Replying and the 24-hour window**

- **FR-010**: Within 24 hours of the customer's last inbound message, a team member MUST be able to
  send:
  - free text of up to 4,096 characters, emojis included
  - media files with an optional caption
  - saved quick replies
- **FR-011**: The system MUST show the time left in the 24-hour window. Once it has closed, free
  text, media and quick replies MUST be disabled with an explanation, and only approved templates
  can be sent. Before sending, the template MUST have its variables filled and its header media
  provided when required, and a preview MUST be shown.
- **FR-012**: The system MUST check the window again at the moment of sending. A free-form message
  attempted after the window closed MUST NOT be sent, and the draft MUST be kept.
- **FR-013**: The system MUST enforce these media limits before sending, and name them when it
  blocks a file:

  | Type | Formats | Limit |
  |---|---|---|
  | Images | JPEG, PNG | 5 MB |
  | Video | MP4, 3GPP | 16 MB |
  | Audio | AAC, MP3, MPEG-4 audio, AMR, OGG | 16 MB |
  | Documents | PDF, Word, Excel, PowerPoint, text | 100 MB |

- **FR-014**: Outgoing inbox messages MUST show sent, delivered, read or failed with timestamps.
  Failures MUST show the same plain-language reasons as campaign messages.
- **FR-015**: Templates MUST NOT be sent from the inbox to opted-out contacts. Marketing templates
  require opt-in, as in campaigns. Free replies to opted-out contacts inside an open window remain
  allowed.
- **FR-016**: Sending MUST be refused, with a reason, when the conversation's number is
  disconnected, in error or has sending turned off.
- **FR-017**: A team member's reply to an unassigned conversation MUST assign it to them.
- **FR-018**: Admins and managers MUST be able to create, edit and delete quick replies, each with a
  title, a unique shortcut and text. The text may contain placeholders for the contact's name and
  attributes. All team members MUST be able to find a quick reply by its shortcut or title, insert
  it with placeholders filled, and edit it before sending.

**Assignment, status and collaboration**

- **FR-019**: Team members allowed to manage conversations MUST be able to assign a conversation to
  any active team member, transfer it or unassign it. Every change MUST appear in the timeline
  with who made it and when.
- **FR-020**: Conversations MUST have the statuses open, pending and resolved, and team members can
  change between them. A new inbound message to a pending or resolved conversation MUST set it to
  open and keep the current assignee.
- **FR-021**: Tagging a conversation MUST add or remove tags on its contact. These are the same
  tags used in contact management and campaign audiences.
- **FR-022**: Team members MUST be able to add internal notes that:
  - only the team sees
  - look clearly different from messages
  - are never sent to the customer
  - may mention a teammate, who is then notified
- **FR-023**: Admins and managers MUST see every conversation. Agents MUST see only conversations
  assigned to them and unassigned ones, can claim unassigned ones, and MUST NOT be able to open
  conversations assigned to someone else.
- **FR-024**: Phone numbers MUST be masked for agents to their last 4 digits, as in feature 001, in
  the list, the conversation header, the contact panel and notifications.
- **FR-025**: When a team member is deactivated, their open and pending conversations MUST become
  unassigned.

**Business hours and automatic messages**

- **FR-026**: An admin MUST be able to set the company's weekly business hours, as times per
  weekday, with a time zone.
- **FR-027**: When the away message is enabled and a customer writes outside business hours, the
  system MUST send the away message. It MUST NOT be sent to the same contact more than once in 12
  hours.
- **FR-028**: When the welcome message is enabled, the system MUST send it once to a phone number
  whose first-ever message to that company number has just arrived.
- **FR-029**: Automatic messages:
  - MUST NOT be sent in reply to opt-out or opt-in keywords
  - MUST appear in the timeline labelled as automatic
  - MUST NOT count as a team member's first response

**Contact panel, metrics, audit and permissions**

- **FR-030**: The contact panel MUST show:
  - the name
  - the phone, masked for agents
  - attributes and tags
  - consent status with its source and date
  - up to 10 recent campaigns with each message's status

  Team members with contact permissions can edit the name, attributes and tags there.
- **FR-031**: Admins and managers MUST be able to see, for today, the last 7 days or the last 30
  days:
  - open conversations right now, in total, per agent and unassigned
  - median and 90th-percentile first response time per agent
  - median resolution time per agent
  - conversations resolved per agent

  First response time runs from the first customer message of a conversation's opening (new or
  reopened) to the first reply by a person. Resolution time runs from that opening to its
  resolution.
- **FR-032**: These actions MUST be recorded in the existing audit log:
  - assignment and transfer
  - resolving and reopening
  - quick reply changes
  - business hours and automatic message changes

  Message content MUST NOT be copied into the audit log.
- **FR-033**: Inbox capabilities MUST follow this permission table, which extends feature 001's
  roles. Agents gain the ability to reply.

  | Capability | Admin | Manager | Agent |
  |---|---|---|---|
  | Open the inbox | ✅ all conversations | ✅ all conversations | ✅ assigned to them and unassigned |
  | Reply, add notes, change status, tag | ✅ | ✅ | ✅ (on visible conversations) |
  | Assign or transfer to any teammate | ✅ | ✅ | Claim unassigned; transfer their own |
  | Use quick replies | ✅ | ✅ | ✅ |
  | Create, edit and delete quick replies | ✅ | ✅ | – |
  | Business hours and automatic messages | ✅ | – | – |
  | Team metrics | ✅ | ✅ | – |
  | See full phone numbers | ✅ | ✅ | – |

- **FR-034**: Conversation messages and media MUST follow feature 001's retention of 12 months.
  Contact deletion MUST erase personal data from the contact's conversations, as described in the
  edge cases.

### Key Entities

- **Conversation**: the ongoing thread between one contact and one company WhatsApp number. It has:
  - status (open, pending, resolved) and assignee
  - when it was opened or last reopened, and the latest activity
  - when the 24-hour window closes
  - first-response and resolution moments for each opening
- **Conversation message**: one item in a conversation. It has:
  - direction (inbound or outbound)
  - source: customer, team member, automatic, campaign or API
  - type and content (text or a stored media file with name, type and size)
  - delivery status with timestamps, and a failure reason
- **Internal note**: team-only text in a conversation, with an author, a time and any mentioned
  teammates.
- **Timeline event**: an assignment, transfer, status change or consent change shown in the
  conversation, with who made it and when.
- **Read marker**: how far each team member has read in each conversation. Unread counts come from
  it.
- **Quick reply**: a saved answer with a title, a unique shortcut, text with placeholders, and its
  author.
- **Business hours and automatic messages**: the weekly schedule and time zone, the away message,
  the welcome message, and on/off switches for each.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 95% of incoming messages, the conversation appears or updates for every team
  member viewing the inbox within 2 seconds of the message reaching the platform.
- **SC-002**: A team member can find a new conversation, read it and send a reply in under 30
  seconds.
- **SC-003**: In a test of 1,000 incoming messages of every supported type, including repeated and
  out-of-order deliveries and a dropped connection, 100% appear exactly once and in the correct
  order.
- **SC-004**: Zero free-form messages are sent outside the 24-hour window, and zero templates are
  sent to opted-out contacts. Verified by automated tests and by the absence of window-closed
  errors from WhatsApp.
- **SC-005**: With 20 team members online, 10,000 conversations and conversations of 5,000
  messages, the list and an open conversation each appear in under 2 seconds.
- **SC-006**: Away and welcome messages are sent exactly once within their rules and never in reply
  to opt-out or opt-in keywords. Verified across 100 test conversations.
- **SC-007**: Team metrics match a manual calculation on a sample of 50 conversations, to within 1
  minute.
- **SC-008**: In a first-use check, at least 9 of 10 team members can claim, answer and resolve a
  conversation without help.

## Assumptions

- **Users and roles:** this remains a single company. Users, roles, contacts, consent, templates,
  numbers, media storage and the audit log are reused from feature 001. Agents, who were
  read-only in feature 001, can now reply in the inbox.
- **The 24-hour window** is WhatsApp's customer service window: 24 hours after the customer's last
  message. Replies inside it are free of Meta charges for service messages.
- **Volume:** 10–20 team members and up to a few thousand incoming messages a day per number.
- **Business hours:** one company-wide schedule in one time zone. A holiday calendar is not
  included.
- **Away message:** at most once per contact every 12 hours.
- **Welcome message:** only for a phone number's first-ever message to that company number.
- **Tags:** conversation tags are the contact's tags, so tagging in the inbox also shapes future
  campaign audiences.
- **Read receipts:** opening a conversation marks the customer's messages as read on WhatsApp, as
  the company's WhatsApp app would.
- **Voice:** agents send audio as files. Recording voice notes in the browser is not included.
- **Retention and erasure** follow feature 001: 12 months, and erasure on contact deletion.

## Out of Scope

- Chatbot flows and keyword automations beyond the away and welcome messages (next feature)
- AI agent and AI-suggested replies
- Click-to-WhatsApp ads, payments and a mobile app
- Automatic assignment rules (round-robin, by skill or load), SLA timers and customer satisfaction
  surveys
- Holiday calendars, other channels (email, SMS, Instagram), and voice or video calls
- Indicators showing that another team member is typing

## Dependencies

- **Feature 001 (bulk messaging):**
  - connected numbers and their status
  - contacts, tags, attributes and consent keywords
  - approved templates and the campaign message history
  - roles and phone masking, and the audit log
  - signed webhook intake and media storage
- **WhatsApp Business Platform:**
  - inbound message webhooks with media
  - media download
  - sending text and media messages inside the service window
  - marking messages as read
- **Live use** needs a real connected number (quickstart §5 of feature 001). Development and tests
  use the existing WhatsApp simulator, extended for inbound messages.
