# Feature Specification: Live Chat (Shared Team Inbox)

**Feature Branch**: `002-team-inbox`
**Created**: 2026-11-19
**Revised**: 2026-11-19. Aligned to the documented AiSensy live-chat flow; see docs/research/aisensy/feature-inventory-2026-11-19.md, items 2.4, 2.5, 3.11 and 6.1–6.14.
**Status**: Draft
**Input**: User description: "Shared team inbox (live chat) for our company's WhatsApp numbers — functionally equivalent to AiSensy's team inbox but with our own original design and wording. Every customer who messages us, and every message we send them (campaign templates, API messages, replies), appears in one conversation per contact and number. Team members see a conversation list they can filter by status (open, pending, resolved), by assignment (mine, unassigned, a teammate), by WhatsApp number and by tag, sorted by latest activity with unread counts. Opening a conversation shows the full history: inbound texts, media (image, video, audio, document, location, contacts), button and list replies, template broadcasts with their delivery ticks (sent, delivered, read, failed), and consent events such as STOP. Agents reply with free text, emojis, media files and saved quick replies while WhatsApp's 24-hour customer service window is open; outside the window only approved templates (with variables) can be sent, and the window countdown is visible. Conversations can be assigned, transferred, marked resolved or reopened, tagged, and carry internal notes the customer never sees; a new inbound message reopens a resolved conversation. Updates appear in real time without refreshing: new messages, delivery ticks, assignment changes, typing of other agents is not required. Business hours with an automatic away message outside them, plus an optional welcome message for first-time contacts. A contact panel shows name, attributes, tags, consent status and past campaigns; agents see masked phone numbers per the existing role rules, and only admins and managers can see every conversation while agents see their assigned and unassigned ones. Supervisors see basic team metrics: open conversations, first response time, resolution time per agent. Reuses existing roles, audit log, contacts, templates and numbers from feature 001. Out of scope for this feature: chatbot flows, AI agent, ads, payments, mobile app." The user then asked for complete parity with the AiSensy live chat flow (2026-11-19).

## Concepts used in this spec

- **Chat**: the conversation between one contact and one company WhatsApp number. It holds every
  message either way (campaigns, API messages, replies, automatic messages) and the events that
  happen in it.
- **Live chat**: chats where the customer wrote within the last 24 hours, so free replies are
  possible. Each live chat is in exactly one state:
  - **Active**: new or ongoing chats that no team member has taken over. Once the chatbot exists
    (feature 005), these are the chats it is handling.
  - **Requesting**: chats waiting for a human. In this feature they come from a "talk to a person"
    request; the chatbot will add its own handoff later.
  - **Intervened**: a team member has taken the chat over. Only that member (plus admins and
    managers) sees it.
- **Resolve**: ends an intervention. The chat goes back to Active, which is the bot once one exists.
- **History**: chats whose customer has not written for 24 hours. Free replies are impossible
  there (WhatsApp's 24-hour rule), but a template can be sent to restart the conversation. When the
  customer writes again, the chat returns to live chat.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive and answer customers in live chat (Priority: P1)

A customer writes to a company number or replies to a campaign. The chat appears in **Active**
within moments for everyone allowed to see it, without anyone refreshing. A team member opens it
and sees the whole history with this customer on this number: our campaign messages with their
delivery ticks, and everything the customer sent, including pictures, videos, voice notes,
documents, locations, contact cards, stickers, reactions and button or list choices. The team
member presses **Intervene** to take the chat over, then replies with text and emojis. The chat
moves to **Intervened**, and the customer receives the replies on WhatsApp with sent, delivered and
read ticks. When done, the team member presses **Resolve** and the chat returns to Active.

**Why this priority**: Customer replies to broadcasts currently go nowhere. Answering them is the
core of live chat, and every other story builds on it.

**Independent Test**: A test phone sends "Is this available?". The chat appears in Active within 2
seconds. A team member intervenes and replies "Yes", and the phone receives it with ticks shown.
After Resolve, the chat is back in Active.

**Acceptance Scenarios**:

1. **Given** a team member has live chat open, **When** a customer sends a message, **Then** the chat
   appears or moves to the top of Active within 2 seconds, with a preview and an unread badge, and
   no page refresh is needed.
2. **Given** a chat in Active, **When** a team member presses Intervene, **Then** it moves to
   Intervened under that member, other agents no longer see it, and the customer journey records
   who intervened and when.
3. **Given** an intervened chat inside the 24-hour window, **When** the member sends text with emojis,
   **Then** the customer receives it, and the message shows sent, then delivered, then read.
4. **Given** a contact who received campaigns, **When** their chat opens, **Then** each campaign
   message appears with its campaign name, the filled template text and its final status.
5. **Given** the customer sent an image, video, voice note or audio, document, location, contact card,
   sticker, reaction, button reply or list reply, **When** the chat is shown, **Then** each appears in
   a readable form: preview, player, download with name and size, map link, contact details, the
   reaction on its message, or the chosen option.
6. **Given** an intervened chat, **When** the member presses Resolve, **Then** the chat returns to
   Active, and the resolution is recorded in the customer journey.
7. **Given** a phone number that is not yet a contact, **When** it writes, **Then** a contact is
   created with consent unknown and source "Organic".
8. **Given** an outgoing message WhatsApp could not deliver, **When** the failure is reported, **Then**
   it is marked failed with a plain-language reason.

---

### User Story 2 - The 24-hour window, History and restarting with a template (Priority: P1)

Free replies are possible only within 24 hours of the customer's last message, and every open chat
shows how much of that time is left. When 24 hours pass without a customer message, the chat leaves
live chat and moves to **History**. From History, a team member can choose the contact, pick an
approved template, fill its variables, preview and send it to restart the conversation. When the
customer answers, the chat comes back to live chat.

**Why this priority**: This is WhatsApp policy. Without it, replies would be rejected and quiet
customers could never be re-engaged.

**Independent Test**:
1. Take a chat whose customer wrote more than 24 hours ago: it is in History and free text is
   impossible.
2. Send an approved template with a filled variable from History: it is delivered.
3. Have the customer reply: the chat is live again and free replies work.

**Acceptance Scenarios**:

1. **Given** the customer's last message was 23 hours ago, **When** the chat is open, **Then** it shows
   that free replies end in about 1 hour.
2. **Given** 24 hours have passed since the customer's last message, **When** the time is reached,
   **Then** the chat moves from live chat to History.
3. **Given** a chat in History, **When** a team member opens it, **Then** free text, media and canned
   messages are unavailable with a short explanation, and "Send template" is offered: choose an
   approved template, fill its variables and header media, preview, send.
4. **Given** the window closes while a member is typing, **When** they press send, **Then** nothing is
   sent, the draft stays, and "Send template" is offered.
5. **Given** an opted-out contact, **When** someone tries to send them a template, **Then** it is
   refused with "This contact has opted out". Free replies inside an open window remain possible.
   Marketing templates also need opt-in, as for campaigns.
6. **Given** a chat in History, **When** the customer writes again, **Then** it returns to live chat as
   Active, and a resolved intervention does not come back by itself.

---

### User Story 3 - Team routing: requesting, transfer, auto-resolve, agent rules and filters (Priority: P2)

Customers can ask for a person by sending one of the company's "talk to a person" keywords. Their
chat then moves to **Requesting** and the team is alerted. Team members intervene, and managers or
the intervening agent can **transfer** a chat to another agent.

Admins can turn on **auto-resolve**, which resolves intervened chats after 24 hours without
activity. Chats no longer stay hidden with an absent or removed agent.

Admins can give an agent **agent rules**: tag or attribute values (for example tag "Demo", or
Industry = Ecommerce). The agent then sees, intervenes in and resolves only chats whose contact
matches.

Everyone can filter chats by tags, attributes, campaigns and number, and search by name or phone.

**Why this priority**: With several agents, routing prevents double answers and lost chats. Basic
answering (US1) works without it.

**Independent Test**:
1. Send "agent" from a test phone: the chat moves to Requesting and an alert appears.
2. Intervene as agent A, then transfer to agent B: B sees it and A no longer does.
3. Turn on auto-resolve, then simulate 24 hours of inactivity: the chat is resolved.
4. Give agent C the rule tag = "Demo": C sees only Demo-tagged chats.

**Acceptance Scenarios**:

1. **Given** "talk to a person" keywords are configured, **When** a customer sends one, **Then** the
   chat moves to Requesting, team members who can see it are notified, and the contact's
   unresolved-requests count goes up by one.
2. **Given** an intervened chat, **When** its agent or a manager transfers it to another agent,
   **Then** it moves to the new agent's Intervened list, disappears from the old agent's list, and
   the journey records the transfer.
3. **Given** auto-resolve is on, **When** an intervened chat has had no activity for 24 hours, **Then**
   it is resolved automatically and any team member can intervene when the customer writes next.
4. **Given** auto-resolve is off, **When** an intervened chat goes quiet, **Then** it stays with its
   agent, and when the customer writes again it goes straight back to that agent.
5. **Given** agent C has the rule tag = "Demo", **When** C opens live chat, **Then** only chats whose
   contact has the Demo tag are listed, and C cannot open other chats. Agents without rules see every
   live chat that is not intervened by someone else.
6. **Given** filters for tag, attribute value, campaign received and number, **When** they are
   combined, **Then** only matching chats are listed, and each state tab shows its count.
7. **Given** a team member is deactivated, **When** that happens, **Then** their intervened chats are
   resolved back to Active so others can pick them up.

---

### User Story 4 - Canned messages, media and the media library (Priority: P2)

Admins and managers create **canned messages**, each with:
- a name
- a type (text or media)
- text of up to 4,096 characters with WhatsApp formatting (*bold*, _italic_)
- personalisation variables: first name, full name, last name, mobile number, any custom attribute
- numbered parameters to fill in when sending

Media canned messages carry an image, video, audio or document from the **media library** or a
public link. In a chat, anyone types "/" or opens the canned-message picker, chooses one (personal
**favourites** pinned on top), fills any parameters, checks the preview and sends. Team members can
also attach files directly from their computer or the media library.

**Why this priority**: Saved answers and media make replies fast and consistent. Text replies (US1)
already deliver the core value.

**Independent Test**:
1. Create the canned text message "Hi {first name}, we open at 9" and insert it with "/": it shows
   "Hi Sara, we open at 9" and can be sent.
2. Send a PDF from the media library: the customer receives it.
3. Attach a file that is too large: it is blocked with the limit named.

**Acceptance Scenarios**:

1. **Given** a canned message with variables, **When** it is inserted in a chat, **Then** the variables
   are filled from the contact. Any empty value falls back to the text set on the canned message, or
   blanks the variable if none is set.
2. **Given** a canned message with numbered parameters, **When** it is chosen, **Then** the member must
   fill each parameter before the preview allows sending.
3. **Given** a member marks canned messages as favourites, **When** they open the picker, **Then**
   their favourites appear first. Other members' favourites are unaffected.
4. **Given** 200 canned messages exist, **When** someone tries to create another, **Then** it is
   refused with the limit named.
5. **Given** an allowed file inside the window, **When** it is sent with a caption, **Then** the
   customer receives it and the chat shows a preview. A file of the wrong type or above the size
   limit is blocked before sending, with the allowed types and limit named.
6. **Given** an agent, **When** they open canned-message management, **Then** they can use and favourite
   canned messages but not create, edit or delete them.

---

### User Story 5 - Chat profile, customer journey and blocking (Priority: P2)

Beside each chat, a profile panel shows:
- **About the chat:** state, last active time, number of template and session messages, number of
  unresolved requests for a person, and source (Organic, API, campaign upload or a custom import
  label)
- **First-message tag:** editable
- **Campaigns:** each with its read tick
- **Attributes:** editable
- **Tags:** add existing ones or create new ones
- **Customer journey:** a time-stamped log of who intervened, transferred, resolved or tagged, which
  campaigns were sent, and consent changes

Team members can **block** a contact who sends spam. Their new messages are then no longer shown in
live chat or alerted. Campaigns can still be sent to them. A blocked contact can be unblocked.

**Why this priority**: Context improves service, and blocking keeps spam out of the team's way. Both
depend on chats existing (US1).

**Independent Test**:
1. Open a chat as an agent: the panel shows a masked phone, counts, source, tags, campaigns with
   ticks, and the journey entries from US1 and US3.
2. Block the contact and send a message from the phone: nothing appears in live chat.
3. Unblock: new messages appear again.

**Acceptance Scenarios**:

1. **Given** an agent opens a chat, **When** the panel loads, **Then**:
   - the phone is masked to its last 4 digits
   - state, last active, template and session counts, unresolved requests and source are shown
   - tags, attributes and up to 10 recent campaigns with their read status are listed
2. **Given** a team member with contact permission, **When** they edit an attribute or add a tag in
   the panel, **Then** the contact is updated, the change is usable in campaign audiences, and the
   journey records who changed what.
3. **Given** a blocked contact, **When** they send a message, **Then** it is stored but not shown in
   live chat, no alert or automatic reply goes out, and the chat profile says the contact is blocked.
4. **Given** a blocked contact, **When** a campaign is sent to an audience including them, **Then**
   they still receive it unless they opted out. Blocking only filters incoming messages.
5. **Given** the customer journey, **When** it is viewed, **Then** each entry shows the time, the actor
   (team member, customer, campaign, automatic) and what happened, newest first.

---

### User Story 6 - Working hours, welcome and off-hours messages (Priority: P3)

An admin sets working hours for each weekday, with a time zone, and switches on:
- **Welcome message:** sent when a customer starts a conversation during working hours
- **Off-hours message:** sent when a customer writes outside working hours

Each can be an approved template, or a regular text, image or file message.

**Why this priority**: Automatic replies set expectations, but live chat works without them.

**Independent Test**:
1. Set hours that exclude now and enable off-hours: a test message gets the off-hours reply once,
   and a second message a minute later gets none.
2. Set hours that include now and enable welcome: a customer starting a new conversation gets the
   welcome message once.

**Acceptance Scenarios**:

1. **Given** the off-hours message is on and it is outside working hours, **When** a customer writes,
   **Then** the off-hours message is sent. It is not sent again to the same contact for 12 hours.
2. **Given** the welcome message is on and it is within working hours, **When** a customer starts a
   new conversation (first message, or first after 24 hours of silence), **Then** the welcome
   message is sent once for that conversation.
3. **Given** a customer sends an opt-out, opt-in or "talk to a person" keyword, **When** it is
   processed, **Then** no welcome or off-hours message is sent in reply.
4. **Given** automatic messages, **When** the chat is shown, **Then** they are labelled automatic and do
   not count as a team member's response.
5. **Given** a template is chosen as the welcome or off-hours message, **When** it is sent, **Then** its
   variables are filled from the contact, with configured fallbacks.

---

### User Story 7 - Notifications: sound and push (Priority: P3)

Each team member chooses whether a sound plays for new customer messages. They can also register up
to 5 browsers or devices for push notifications, so they are alerted with live chat closed. Devices
can be removed or paused. Requesting chats, transfers to them and mentions always notify the people
concerned.

**Why this priority**: Alerts shorten response times, but the inbox already updates live (US1).

**Independent Test**:
1. Enable sound: a new message plays a chime.
2. Register a browser for push, close the tab and send a message: a push alert appears.
3. Pause the device: no alert.

**Acceptance Scenarios**:

1. **Given** sound is on, **When** a new customer message arrives in a chat the member can see, **Then**
   a short sound plays once.
2. **Given** a registered device, **When** a chat the member can see receives a message or moves to
   Requesting while the member has no tab open, **Then** a push notification shows the contact name
   and a preview. The number is masked for agents.
3. **Given** 5 registered devices, **When** the member adds a sixth, **Then** it is refused until one is
   removed.
4. **Given** a paused device, **When** messages arrive, **Then** it receives no push. Unpausing restores
   alerts.

---

### User Story 8 - Internal notes and team monitoring (Priority: P3)

Team members can leave internal notes in a chat. Notes are visible only to the team, never sent to
the customer, and can mention a teammate, who is notified. Admins and managers can see every chat
(monitoring) and a team view for today, 7 days or 30 days:
- live chats by state
- requesting chats waiting
- per agent: chats intervened and resolved, median first response time, median resolution time

**Why this priority**: Notes and oversight help larger teams. They go slightly beyond what AiSensy
documents, but do not change its flow.

**Independent Test**:
1. Add a note mentioning a teammate: the customer receives nothing and the teammate is notified.
2. As a manager, open the team view for 7 days: numbers match a manual count on a small sample.

**Acceptance Scenarios**:

1. **Given** a chat, **When** a member adds a note with a mention, **Then** the note is shown only to the
   team, styled differently from messages, and the mentioned teammate is notified.
2. **Given** a manager, **When** they open any intervened chat, **Then** they can read it and transfer or
   resolve it.
3. **Given** the team view, **When** a period is chosen, **Then** per-agent counts and times match the
   definitions in FR-037.
4. **Given** an agent, **When** they try to open the team view, **Then** access is refused.

---

### Edge Cases

- **Disconnected number:** a customer writes to a number that is disconnected or in error. The
  message is stored and shown, and replies are refused with a reason.
- **Two company numbers:** the same customer writes to two company numbers. There are two chats, one
  per number.
- **Simultaneous Intervene:** two members press Intervene at the same moment. Only the first
  succeeds, and the second is told who took it.
- **Repeated or out-of-order webhooks:** each message appears exactly once, in the order of the
  customer's timestamps.
- **Expired media links:** WhatsApp media links expire. Media is fetched and kept when the message
  arrives; if that fails after retries, the chat shows "media unavailable".
- **Long chats:** chats with thousands of messages open at the newest message, and older ones load
  while scrolling up.
- **Opt-out inside a chat:** consent updates as in feature 001, the journey records it, campaigns
  exclude the contact, and free replies inside the open window remain possible.
- **Deleted contact:** a contact is deleted under feature 001's rules. Their name, phone, message
  texts and media are erased from the chat. Anonymous counts for team metrics remain.
- **Unsupported type:** an unsupported message type is shown as "message type not supported", with
  the type name.
- **Deleted or edited message:** a customer deletes or edits a message and WhatsApp reports it. The
  chat shows that the message was deleted or edited.
- **Reconnect:** a member's connection drops and returns. Lists and the open chat catch up without
  gaps or duplicates.
- **Removed canned message:** text already inserted in the reply box can still be sent.
- **Agent rule with no matches:** the agent sees an empty list with a note explaining their rules.
- **Customer keeps writing in History:** every new customer message moves the chat back to live
  chat (Active), and the 24-hour window restarts.

## Requirements *(mandatory)*

### Functional Requirements

**Chats and history**

- **FR-001**: The system MUST keep exactly one chat per contact per company WhatsApp number. In time
  order, it holds:
  - every inbound message
  - every outbound message: campaign, API, team reply and automatic message
  - internal notes
  - journey events: interventions, transfers, resolutions, tag and attribute changes, consent
    changes, and blocking
- **FR-002**: The system MUST store and display these inbound types: text, image, video, audio and
  voice note, document, sticker, location, contact card, reaction, button reply and list reply.
  Other types MUST be shown as unsupported, with their type name.
- **FR-003**: Inbound media MUST be downloaded and kept by the platform when it arrives, because
  WhatsApp links expire. It is shown inline as a picture, a player, or a download with name and
  size.
- **FR-004**: A message from a phone number that is not a contact MUST create a contact with consent
  "unknown" and source "Organic".
- **FR-005**: The system MUST track each chat's live state:
  - **Active, Requesting and Intervened** for chats inside the 24-hour window
  - **History** once 24 hours pass without a customer message
- **FR-006**: The system MUST move a chat into History exactly when 24 hours pass after the customer's
  last message. Any new customer message MUST bring it back to live chat.
- **FR-007**: Live chat MUST:
  - show one tab per state with counts, sorted by latest activity
  - filter by tag, attribute value, campaign received and number, with filters that can be combined
  - be searchable by contact name or phone
- **FR-008**: The system MUST keep an unread count per chat for each team member, clear it when that
  member opens the chat, and show a total unread badge in the navigation.
- **FR-009**: New messages, delivery ticks, state changes, transfers and notes MUST reach every member
  viewing them within 2 seconds, without a reload. After reconnecting, the view MUST catch up without
  gaps or duplicates.
- **FR-010**: Chats MUST open at their newest messages and load older history while scrolling up.
- **FR-011**: When a member opens a chat, the customer's unread messages MUST be marked as read on
  WhatsApp.

**Replying, the 24-hour window and templates**

- **FR-012**: Within 24 hours of the customer's last message, a member who may reply in the chat MUST
  be able to send:
  - free text of up to 4,096 characters, with emojis and WhatsApp formatting
  - media files with an optional caption
  - canned messages
- **FR-013**: Every chat MUST show the time left in the window. Outside the window, free text, media
  and canned messages MUST be disabled with an explanation, and "Send template" MUST be offered:
  - choose an approved template
  - fill its variables and header media
  - preview, then send
- **FR-014**: The window MUST be checked again at the moment of sending. A free-form message attempted
  after the window closed MUST NOT be sent, and the draft MUST be kept.
- **FR-015**: These media limits MUST be enforced before sending, and named when a file is blocked:

  | Type | Formats | Limit |
  |---|---|---|
  | Images | JPEG, PNG | 5 MB |
  | Video | MP4, 3GPP | 16 MB |
  | Audio | AAC, MP3, MPEG-4 audio, AMR, OGG | 16 MB |
  | Documents | PDF, Word, Excel, PowerPoint, text | 100 MB |

- **FR-016**: Outgoing chat messages MUST show sent, delivered, read or failed with timestamps.
  Failures MUST show the same plain-language reasons as campaign messages.
- **FR-017**: Templates MUST NOT be sent from a chat to opted-out contacts. Marketing templates require
  opt-in, as in campaigns. Free replies inside an open window are allowed even after an opt-out.
- **FR-018**: Sending MUST be refused, with a reason, when the chat's number is disconnected, in error
  or has sending turned off.

**Taking over, requesting, transfer and resolving**

- **FR-019**: A member who may see a live chat MUST be able to **Intervene**. Intervene MUST succeed for
  exactly one member when several try at once. The chat then becomes Intervened under that member.
- **FR-020**: A member sending a reply in an Active or Requesting chat MUST intervene automatically, so
  replies always have an owner.
- **FR-021**: An admin MUST be able to configure up to 5 "talk to a person" keywords. A customer
  message matching one MUST:
  - move the chat to Requesting
  - add one to the contact's unresolved-requests count
  - notify the members who may see the chat
- **FR-022**: The intervening member, admins and managers MUST be able to **transfer** an intervened chat
  to another active member who may see it. The new owner MUST be notified.
- **FR-023**: **Resolve** MUST end the intervention and return the chat to Active.
- **FR-024**: An admin MUST be able to switch on **auto-resolve**, which resolves intervened chats after
  24 hours without activity. With it off, a quiet intervened chat stays with its member and returns
  to them when the customer writes again.
- **FR-025**: When a member is deactivated, their intervened chats MUST be resolved back to Active.

**Visibility and agent rules**

- **FR-026**: Admins and managers MUST see every chat, including other members' intervened chats, and be
  able to transfer or resolve them.
- **FR-027**: Agents MUST see live chats that are Active or Requesting, plus chats intervened by
  themselves. They MUST NOT see chats intervened by others.
- **FR-028**: An admin MUST be able to give an agent **agent rules**: one or more tag values or attribute
  values. The agent then sees, intervenes in and resolves only chats whose contact matches at least
  one rule. An agent without rules is unrestricted under FR-027.
- **FR-029**: Phone numbers MUST be masked for agents to their last 4 digits, in lists, headers, the
  profile and notifications.

**Canned messages and media library**

- **FR-030**: Admins and managers MUST be able to create, edit and delete canned messages, up to 200.
  Each has:
  - a name
  - a type: text or media
  - text of up to 4,096 characters with WhatsApp formatting
  - variables: first name, name, last name, mobile number, custom attributes, each with an optional
    fallback
  - numbered parameters
  - for media messages, a file from the media library or a public link, with an optional file name
- **FR-031**: All members MUST be able to:
  - find canned messages by typing "/" or through a picker
  - mark personal favourites, which are listed first
  - fill parameters and preview before sending
- **FR-032**: The system MUST keep a **media library** of uploaded images, videos, audio and documents that
  members can reuse in chats and canned messages. Admins and managers can remove items.

**Chat profile, customer journey and blocking**

- **FR-033**: The chat profile MUST show:
  - state and last active time
  - counts of template messages and session messages
  - unresolved-requests count
  - source: Organic, API, campaign upload or a custom import label
  - first-message tag, editable
  - up to 10 recent campaigns with read status
  - attributes and tags, editable by members with contact permission
  - the customer journey, newest first
- **FR-034**: Members MUST be able to **block** and **unblock** a contact. While blocked, the contact's
  incoming messages:
  - are stored but not shown in live chat
  - trigger no notifications and no automatic replies

  Campaigns are unaffected, apart from opt-out.

**Working hours and automatic messages**

- **FR-035**: An admin MUST be able to set working hours per weekday with a time zone, and enable:
  - a **welcome message**, sent once when a customer starts a conversation during working hours (first
    message, or first after 24 hours of silence)
  - an **off-hours message**, sent when a customer writes outside working hours, at most once per
    contact every 12 hours

  Each can be an approved template, or a regular text, image or file message.
- **FR-036**: Automatic messages:
  - MUST NOT be sent in reply to opt-out, opt-in or "talk to a person" keywords, or to blocked contacts
  - MUST be labelled automatic in the chat
  - MUST NOT count as a member's response

**Notifications, notes, monitoring, audit, permissions, retention**

- **FR-037**: Members MUST be able to switch a new-message sound on or off. They MUST be able to register
  up to 5 browsers or devices for push notifications, and remove or pause each one. These MUST
  notify the members concerned:
  - new customer messages in chats they may see
  - chats moving to Requesting
  - transfers to them
  - mentions
- **FR-038**: Members MUST be able to add internal notes that:
  - only the team sees
  - look clearly different from messages
  - are never sent
  - may mention teammates, who are then notified
- **FR-039**: Admins and managers MUST have a team view for today, the last 7 days or the last 30 days:
  - live chats by state, and requesting chats waiting
  - per member: chats intervened, chats resolved, median first response time, median resolution
    time

  First response time runs from the customer's first message of a conversation (new or returning
  from History) to the first reply by a person. Resolution time runs from intervention to
  resolution.
- **FR-040**: These MUST be recorded in the existing audit log:
  - intervene, transfer and resolve
  - blocking and unblocking
  - canned-message changes and media library removals
  - working hours and automatic-message changes, agent rules, keywords and auto-resolve settings

  Message content MUST NOT be copied into the audit log.
- **FR-041**: Live chat capabilities MUST follow this table, which extends feature 001's roles. Agents
  gain replying.

  | Capability | Admin | Manager | Agent |
  |---|---|---|---|
  | See live chat and History | ✅ all | ✅ all | ✅ Active and Requesting within their rules, plus their own Intervened |
  | Intervene, reply, resolve, send templates, notes, block | ✅ | ✅ | ✅ on chats they may see |
  | Transfer | ✅ any chat | ✅ any chat | ✅ their own intervened chats |
  | Use and favourite canned messages, media library | ✅ | ✅ | ✅ |
  | Create, edit and delete canned messages; remove library media | ✅ | ✅ | – |
  | Working hours, automatic messages, "talk to a person" keywords, auto-resolve, agent rules | ✅ | – | – |
  | Team view | ✅ | ✅ | – |
  | See full phone numbers | ✅ | ✅ | – |

- **FR-042**: Chat messages and media MUST follow feature 001's 12-month retention. Contact deletion MUST
  erase personal data from chats, as described in the edge cases.

### Key Entities

- **Chat**: one contact on one company number. It has:
  - live state (Active, Requesting, Intervened) or History
  - the intervening member
  - the time of the customer's last message, which sets the 24-hour window
  - last activity, and the unresolved-requests count
- **Chat message**: one item in a chat. It has:
  - direction (inbound or outbound)
  - origin: customer, team member, automatic, campaign or API
  - type and content: text, or a stored media file with name, type and size
  - delivery status with timestamps, and a failure reason
- **Journey event**: an intervention, transfer, resolution, tag or attribute change, campaign sent,
  consent change, block or unblock, with actor and time.
- **Internal note**: team-only text with author, time and mentions.
- **Read marker**: how far each member has read in each chat. Unread counts come from it.
- **Canned message**: name, type, text with variables, fallbacks and parameters, an optional media
  file, and its author. Favourites are kept per member.
- **Media library item**: a stored file with name, type, size and uploader.
- **Agent rule**: tag or attribute values that limit which chats an agent sees.
- **Live chat settings**:
  - working hours and time zone
  - welcome and off-hours messages, each with an on/off switch and content
  - "talk to a person" keywords
  - auto-resolve switch
- **Notification preferences**: per member, the sound setting and up to 5 push devices, each active or
  paused.
- **Block entry**: a blocked contact, with who blocked them and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 95% of incoming messages, the chat appears or updates for every member viewing live
  chat within 2 seconds of the message reaching the platform.
- **SC-002**: A team member can find a new chat, intervene and send a reply in under 30 seconds.
- **SC-003**: In a test of 1,000 incoming messages of every supported type, including repeated and
  out-of-order deliveries and a dropped connection, 100% appear exactly once and in order.
- **SC-004**: Zero free-form messages are sent outside the 24-hour window, zero templates go to
  opted-out contacts, and zero automatic replies go to blocked contacts or in reply to keywords.
- **SC-005**: A chat moves to History within 1 minute of its 24-hour mark, and returns to live chat
  within 2 seconds of a new customer message.
- **SC-006**: With 20 members online, 10,000 chats and chats of 5,000 messages, live chat and an open
  chat each appear in under 2 seconds.
- **SC-007**: Exactly one member wins every simultaneous Intervene, verified with 50 concurrent
  attempts.
- **SC-008**: Agents with agent rules see only matching chats, verified on 100 chats with mixed tags and
  attributes.
- **SC-009**: In a first-use check, at least 9 of 10 team members can intervene, reply, use a canned
  message and resolve a chat without help.

## Assumptions

- **Users and data:** single company. Users, roles, contacts, consent, templates, numbers, media
  storage and the audit log come from feature 001. Agents, read-only in feature 001, can now
  intervene and reply.
- **The 24-hour window** is WhatsApp's customer service window. Messages inside it are free of Meta
  charges for service conversations.
- **Before the chatbot exists**, new chats sit in Active until a member intervenes. Requesting comes
  from the "talk to a person" keywords. Feature 005 will make the bot handle Active chats and hand
  over to Requesting.
- **Welcome message** follows AiSensy's documented behaviour: sent during working hours. Our default is
  once per new conversation, meaning a first message or the first after 24 hours of silence.
- **Off-hours message:** at most once per contact every 12 hours. This is our default; AiSensy does not
  document a frequency.
- **Volume:** 10–20 members and up to a few thousand incoming messages per day per number.
- **Business hours:** one company-wide schedule. A holiday calendar is not included, matching
  AiSensy's documentation.
- **Push notifications** use the browser's standard notification permission. Some browsers or systems
  may not support them, as AiSensy notes for Mac and iOS.
- **Voice:** voice notes are sent as audio files. Recording in the browser is not included.
- **Retention and erasure** follow feature 001.

## Out of Scope

- **Later features:** chatbot flows and their handoff logic (005), AI agent and AI replies (007),
  catalog, payments and forms in chat (006), ads (009), and the mobile app (010)
- **Not part of AiSensy's documented live chat:** automatic round-robin assignment, SLA timers, holiday
  calendars and satisfaction surveys
- **Not supported:** other channels (email, SMS, Instagram), voice or video calls, and showing that
  another member is typing

## Dependencies

- **Feature 001 (bulk messaging):**
  - numbers and their status
  - contacts, tags, attributes and consent keywords
  - approved templates and the campaign message history
  - roles, masking and the audit log
  - signed webhook intake and media storage
- **WhatsApp Business Platform:**
  - inbound message webhooks with media
  - media download
  - sending text and media messages inside the service window
  - marking messages as read
- **Research reference:** docs/research/aisensy/feature-inventory-2026-11-19.md. AiSensy's flow is
  matched in behaviour; the design and wording are our own.
