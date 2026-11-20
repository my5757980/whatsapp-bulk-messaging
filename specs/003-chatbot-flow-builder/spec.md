# Feature Specification: Chatbot Flow Builder

**Feature Branch**: `003-chatbot-flow-builder`
**Created**: 2026-11-20
**Status**: Draft
**Input**: User description: "Chatbot flow builder (feature 003, after 001 bulk messaging and 002 live chat). Admins and managers build automated WhatsApp conversations without code on a visual canvas of connected steps. A flow starts from a trigger: keywords or phrases in a customer message (exact or contains, ignoring case), a reply to a template quick-reply button, the first message of a new contact that matches a phrase (this also sets the contact's first-message tag, deferred from 002), or a member starting it from live chat. Steps: send a message (text with contact variables, image, video, document, audio from the media library); ask with up to 3 reply buttons or a list of up to 10 options and branch on the choice; ask for free text, number, email, phone or date, validate it, retry a set number of times, and save the answer to a contact attribute; add or remove tags; set attributes; branch on conditions (attribute value, tag, previous answer, inside or outside working hours); wait for a delay; call an external HTTPS API with the contact's data and save fields from the response, with a timeout and a failure branch; jump to another flow; hand over to a person (the chat moves to Waiting for agent in live chat); end. Running flows must respect the rules of 001 and 002: free-form messages only inside the 24-hour window, an opt-out keyword (STOP) ends the flow and is never answered, blocked contacts get nothing, a flow stops when a member takes the chat or sends a reply, and automatic welcome/off-hours messages do not fire while a flow is answering. Each contact runs at most one flow at a time; a flow waiting for an answer ends after a configurable timeout. Flows have a draft and a published version, can be tested on one phone number before publishing, and show per-step analytics (contacts that entered, continued, and dropped). Flow messages appear in the live chat timeline labelled automatic. Permissions extend the 001/002 roles: admins and managers edit and publish flows, agents can start a published flow from a chat. Same features and flows as the market leader, but original design and text."

**Context**: This follows the order the user chose on 2026-11-19 (live chat, then the chatbot flow
builder). It covers items 7.1–7.3 and 7.5–7.7 of `docs/research/aisensy/feature-inventory-2026-11-19.md`,
which listed the flow builder as "005" before that decision. We match the documented behaviour, not
the look: screens, labels and starter flows are our own (constitution Principle II).

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Flow** | An automated conversation: a set of steps joined by connections, with one or more triggers. |
| **Step** | One box on the canvas: send a message, ask a question, set data, check a condition, wait, call an API, jump, hand over or end. |
| **Branch** | A labelled exit of a step (for example each reply button, "valid answer", "timed out", "API failed"). Each branch connects to the next step. |
| **Trigger** | What starts a flow: a keyword or phrase, a pattern, a template button reply, a new contact's first message, or a member in live chat. |
| **Session** | One contact's run through one flow version: where they are, what they answered, and how it ended. |
| **Draft / Published** | Every flow has an editable draft. Publishing copies the draft into a new published version that customers meet. |
| **Test numbers** | Up to 3 phone numbers that can run the draft before it is published. |
| **Answers** | Values collected during a session (question answers, API results). They can be saved to contact attributes or used later in the same session. |

Live chat terms come from feature 002: *Open* (Active), *Waiting for agent* (Requesting), *Taken*
(Intervened) and *Past chats* (History). "Automatic" messages are the ones no member typed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build, publish and run a keyword flow with buttons (Priority: P1)

A manager opens **Flows**, creates "Opening hours", and adds a keyword trigger "hours" (matches
when the message contains the word, ignoring case). On the canvas they add a message step ("We
open 9–6, Monday to Saturday. Anything else?") with two reply buttons, "Location" and "Talk to us".
"Location" leads to a message step with the address and a map image from the media library; "Talk
to us" leads to a hand-over step. They publish the flow. A customer who writes "what are your
hours?" gets the message with both buttons; tapping "Location" sends the address and image. The
whole exchange appears in the customer's live chat timeline, labelled automatic.

**Why this priority**: Answering common questions automatically is the main reason to have a
chatbot. A trigger, a message with buttons, branches and publishing are the smallest useful flow.

**Independent Test**: Publish the flow above, then send "HOURS please" from a test phone. The reply
and buttons arrive within 3 seconds; tapping each button follows its branch; the live chat timeline
shows every step as automatic.

**Acceptance Scenarios**:

1. **Given** a published flow with the keyword trigger "hours" (contains), **When** a customer sends "What are your HOURS?", **Then** the flow starts and the first message with its 2 buttons is sent.
2. **Given** the flow is waiting on the buttons, **When** the customer taps "Location", **Then** the "Location" branch runs and the address and image are sent.
3. **Given** a step with reply buttons, **When** the manager adds a 4th button or a title longer than WhatsApp allows, **Then** the editor refuses it and explains the limit.
4. **Given** a draft with a step whose branch is not connected and a message step without text, **When** the manager publishes, **Then** publishing is refused with a list of the problems, each linked to its step.
5. **Given** a flow was published, **When** the manager edits the draft, **Then** customers keep meeting the published version until the draft is published again.
6. **Given** a customer finished the flow, **When** a member opens the chat in live chat, **Then** every message the flow sent and every button the customer tapped is in the timeline, the flow's messages labelled automatic with the flow's name.

---

### User Story 2 - Ask questions, validate answers and save them to the contact (Priority: P1)

A manager builds "Book a visit": the flow asks for the customer's name (text), preferred date
(date, today or later) and email (email). Each question saves the answer to a contact attribute
(`full_name`, `visit_date`, `email`). A wrong answer gets a short retry prompt; after 2 failed
retries the flow follows the "invalid" branch, which offers a person. A list question ("Which
branch?") offers up to 10 options and saves the choice to the attribute `branch`. If the customer
stops answering for 30 minutes, the "timed out" branch sends "No problem, write *visit* any time".
At the end a message confirms: "Thanks {full_name}, see you on {visit_date} at {branch}".

**Why this priority**: Collecting details (leads, bookings, orders) is the second most common use,
and it fills the contact attributes that campaigns from feature 001 use for targeting.

**Independent Test**: Run "Book a visit" from a test phone, answering one question wrongly twice
and the rest correctly. The retry prompts arrive, the contact's attributes hold the right values
afterwards, and the final message shows them.

**Acceptance Scenarios**:

1. **Given** a date question that accepts today or later, **When** the customer answers "yesterday" or "hello", **Then** the retry prompt is sent and the attribute is not changed.
2. **Given** a question allows 2 retries, **When** the third answer is still invalid, **Then** the "invalid" branch runs.
3. **Given** a valid email answer, **When** it is saved, **Then** the contact's `email` attribute holds it and the contact's profile in live chat shows it.
4. **Given** a list question with 10 options, **When** the customer picks one, **Then** the choice is saved and its branch (or the single "next" branch) runs.
5. **Given** a question waiting 30 minutes with a timeout of 30 minutes, **When** no answer arrives, **Then** the "timed out" branch runs if connected, otherwise the session ends quietly.
6. **Given** a message uses `{full_name}` and the attribute is empty, **When** it is sent, **Then** the step's fallback text is used instead (for example "there").
7. **Given** the customer sends a photo when a text answer is expected, **When** the question checks the answer, **Then** it counts as invalid and the retry prompt is sent.

---

### User Story 3 - Hand over to people and share the chat with live chat (Priority: P1)

The flow and the team must never talk over each other. A hand-over step moves the chat to
**Waiting for agent** in live chat with the flow's answers visible to the team, and the flow stops.
When a member takes the chat or sends any reply, a running flow stops at once. While a chat is
waiting for an agent or taken, no flow starts. When the member closes the chat, flows can answer the
customer again. A customer who writes the opt-out keyword ends the flow and gets no flow reply; a
blocked contact never meets a flow. Welcome and off-hours messages from 002 are not sent for a
message that a flow answers. Members (agents included) can also start a published flow for the
customer from the chat, for example "Collect delivery address".

**Why this priority**: Without these rules the bot would answer over a human, message opted-out
customers or double-reply with automatic messages. These are policy and trust issues, so they are
part of the minimum release.

**Independent Test**: A test phone runs a flow to its hand-over step: the chat appears under Waiting
for agent with the collected answers in the timeline. An agent takes it and replies; the customer's
next messages reach the agent, not the flow. After the agent closes the chat, the keyword starts
the flow again. Sending STOP during another flow ends it with no flow reply.

**Acceptance Scenarios**:

1. **Given** a flow reaches a hand-over step, **When** it runs, **Then** the chat moves to Waiting for agent, the team is alerted as in 002, and the session ends with the result "handed over".
2. **Given** a flow is waiting for an answer, **When** a member takes the chat or sends a reply, **Then** the session ends with the result "stopped by a member" and the customer's next message is not answered by the flow.
3. **Given** a chat is Waiting for agent or Taken, **When** the customer sends a flow keyword, **Then** no flow starts.
4. **Given** a member closed the chat (back to Open), **When** the customer sends a flow keyword, **Then** the flow starts.
5. **Given** a session is running, **When** the customer sends the opt-out keyword, **Then** the session ends, the opt-out is recorded as in 001, and the flow sends nothing more.
6. **Given** the contact is blocked, **When** they send a flow keyword, **Then** no flow starts.
7. **Given** a welcome message is on and a new customer's first message starts a flow, **When** the message is processed, **Then** only the flow answers; the welcome message is not sent.
8. **Given** a member in a chat opens **Start a flow**, **When** they pick a published flow while the 24-hour window is open, **Then** the flow starts for that customer and the member sees it in the timeline; if the window is closed, the action is refused with an explanation.
9. **Given** the customer sends the "talk to a person" keyword from 002 during a flow, **When** it is processed, **Then** the session ends and the chat moves to Waiting for agent.

---

### User Story 4 - Conditions, tags, attributes, delays and jumps (Priority: P2)

A manager makes flows behave differently per customer: a condition step checks whether the contact
has the tag "VIP", whether the attribute `city` equals "Dubai", what the customer answered earlier,
or whether it is inside working hours (from 002), and follows the matching branch. Other steps add
or remove tags, set an attribute to a fixed value or an answer, wait for a delay (for example 10
seconds before a follow-up), jump to another published flow (a shared "Main menu"), or end the flow.

**Why this priority**: Logic turns a fixed script into a useful assistant, but simple flows (US1–US3)
already work without it.

**Independent Test**: A flow branches on working hours and on the tag "VIP". With the tag set and
inside hours, the "VIP, open" branch runs; after removing the tag, the other branch runs. A jump step
continues in "Main menu", and the session's analytics show both flows.

**Acceptance Scenarios**:

1. **Given** a condition "tag VIP is present", **When** a contact with the tag reaches it, **Then** the "yes" branch runs; without the tag, the "no" branch runs.
2. **Given** a condition with several rules joined by "all" or "any", **When** it is evaluated, **Then** the branch matches the combined result.
3. **Given** a condition "inside working hours", **When** it runs outside the hours set in Settings → Live chat, **Then** the "outside" branch runs.
4. **Given** an "add tag" step, **When** it runs, **Then** the contact gets the tag and the customer journey in live chat records it as done by the flow.
5. **Given** a delay of 10 seconds, **When** it runs, **Then** the next step runs about 10 seconds later, unless a member took the chat meanwhile.
6. **Given** a jump to "Main menu", **When** it runs, **Then** the session continues in Main menu's published version and the original flow counts the session as "continued in another flow".
7. **Given** two flows jump to each other with no question in between, **When** the manager publishes, **Then** publishing is refused because the flows would loop.

---

### User Story 5 - Call an external system from a flow (Priority: P2)

A manager builds "Order status": the flow asks for the order number, then an API step sends it to
the company's order system over HTTPS, with a key in a header. Fields from the reply (status,
delivery date) are saved as answers and shown in the next message. If the order system does not
answer within the set timeout, or answers with an error, the "failed" branch sends "We can't check
right now; a person will help" and hands over.

**Why this priority**: Live data (orders, appointments, balances) makes flows much more useful, and
the market leader offers it, but it needs the basic steps first.

**Independent Test**: Point an API step at a test endpoint that returns `{"status":"shipped"}`.
The next message shows "shipped". Then make the endpoint slow or failing; the "failed" branch runs
within the timeout.

**Acceptance Scenarios**:

1. **Given** an API step with method, address, headers and a body using contact data and answers, **When** it runs, **Then** the request is sent with the values filled in.
2. **Given** the reply holds `status`, **When** the step maps `status` to the answer `order_status`, **Then** the next message can show `{order_status}` and it can be saved to an attribute.
3. **Given** a timeout of 5 seconds, **When** the system does not answer in time, **Then** the "failed" branch runs.
4. **Given** the address is not HTTPS, or points to a private or internal network address, **When** the manager saves or the step runs, **Then** it is refused.
5. **Given** a header holds a secret key, **When** anyone views the flow later, **Then** the value is hidden, and it never appears in logs or analytics.
6. **Given** the manager uses **Test request** in the editor with sample values, **When** it runs, **Then** they see the status and the reply, and can pick fields to map from it.

---

### User Story 6 - More triggers: template buttons, patterns and first messages (Priority: P2)

Flows start from more than keywords. A campaign template from 001 has a quick-reply button "Yes,
interested": a trigger links that button of that template to the flow "Lead follow-up", so every
customer who taps it enters the flow. A pattern trigger matches messages such as order numbers
("ORD-12345"). A first-message rule matches a new contact's very first message containing "saw your
ad for the sofa": it sets the contact's first-message tag (from 002) to "Sofa ad" and can start a
flow. When several triggers match one message, the most specific wins: an exact keyword beats a
"contains" keyword, a longer phrase beats a shorter one, and the manager's priority order breaks ties.

**Why this priority**: Template buttons connect campaigns to flows, and first-message rules finish
the first-message tag that 002 left manual. Both extend US1 rather than replace it.

**Independent Test**: Send a campaign with the button and tap it on a test phone: Lead follow-up
starts. From a new number, send "Hi, I saw your ad for the sofa": the profile shows the first-message
tag "Sofa ad" and the linked flow starts.

**Acceptance Scenarios**:

1. **Given** a trigger links the button "Yes, interested" of a template, **When** a customer taps that button on any message using the template, **Then** the linked flow starts.
2. **Given** a pattern trigger, **When** a message matches it, **Then** the flow starts and the matched text is available as an answer.
3. **Given** a first-message rule with a phrase and a tag, **When** a contact's first ever message contains the phrase, **Then** the contact's first-message tag is set and the rule's flow (if any) starts.
4. **Given** an exact trigger "menu" and a contains trigger "menu please", **When** a customer sends "menu", **Then** the exact trigger's flow starts.
5. **Given** a customer is in a session, **When** they send another flow's keyword, **Then** the running session keeps the message as its answer, unless that trigger is marked "can interrupt", in which case the old session ends and the new flow starts.
6. **Given** a manager adds a trigger keyword that is an opt-out, opt-in or "talk to a person" keyword, **When** they save, **Then** it is refused because those keywords are reserved.
7. **Given** two flows use the same exact keyword on the same number, **When** the second is published, **Then** publishing is refused and names the other flow.

---

### User Story 7 - Test drafts before publishing (Priority: P2)

Before going live, the manager adds up to 3 test numbers (their own phones) to the flow. Messages
from those numbers run the **draft**; everyone else still meets the published version (or nothing,
for a new flow). The editor's test panel lists the steps a test session passed through. When happy,
the manager publishes; they can also unpublish a flow, which stops new sessions and ends running
ones at their next step.

**Why this priority**: Testing on a real phone avoids sending broken flows to customers, but US1 can
already publish carefully.

**Independent Test**: Add a test number, change the draft's first message, and send the keyword from
the test phone (draft text arrives) and from another phone (published text arrives).

**Acceptance Scenarios**:

1. **Given** a draft and a test number, **When** the test number sends the trigger, **Then** the draft runs and its messages are marked "test" in live chat and left out of analytics.
2. **Given** a flow was never published, **When** a non-test number sends the trigger, **Then** nothing starts.
3. **Given** a flow is unpublished, **When** customers in a session send their next message, **Then** their sessions end with the result "flow unpublished" and no new sessions start.
4. **Given** sessions are running on version 3, **When** version 4 is published, **Then** running sessions finish on version 3 and new sessions start on version 4.
5. **Given** a manager tries to add a 4th test number, **When** they save, **Then** it is refused.

---

### User Story 8 - Flow analytics (Priority: P3)

Managers see how each flow performs for today, the last 7 days or the last 30 days: sessions
started, completed, handed over, timed out, stopped by a member or by an opt-out, and failed. On the
canvas each step shows how many sessions entered it, continued from it and dropped there, and each
button shows how often it was chosen. They can download the list of contacts who dropped at a step
to follow up with a campaign.

**Why this priority**: Analytics improve flows over time, but flows deliver value without them.

**Independent Test**: Run 10 test-free sessions through a flow where 4 customers stop answering at
the second question. The flow totals show 10 started and 4 timed out, the second question shows 4
dropped, and the downloaded list holds those 4 contacts.

**Acceptance Scenarios**:

1. **Given** sessions in the period, **When** a manager opens the flow's analytics, **Then** the totals match the sessions' results exactly.
2. **Given** a step, **When** the manager looks at it on the canvas in analytics mode, **Then** it shows entered, continued and dropped counts for the chosen period and version.
3. **Given** a step with drop-offs, **When** the manager downloads its list, **Then** the file holds those contacts with phone numbers masked for agents as in 001.
4. **Given** test sessions, **When** analytics are counted, **Then** they are excluded.

---

### User Story 9 - Start from a ready-made flow (Priority: P3)

A new user picks one of our starter flows (for example "FAQ menu", "Lead capture", "Book an
appointment", "Order status lookup", "Feedback rating" and "Business hours reply"), which creates a
draft they edit and publish. The starter flows are written by us.

**Why this priority**: Starters speed up the first flow, but building from scratch works without them.

**Independent Test**: Create a flow from "Lead capture", change its texts, publish it and run it
from a test phone.

**Acceptance Scenarios**:

1. **Given** the starter list, **When** a manager picks one, **Then** a new draft opens with its steps, texts and suggested attributes, and nothing is published until they publish it.
2. **Given** a starter uses attributes that do not exist yet, **When** the draft is created, **Then** the editor lists them and offers to create them.

---

### Edge Cases

- **Stale buttons:** a customer taps a button from an older message after the session moved on or
  ended. The tap does not resume the old step; it is handled like a new message (it may start a
  flow through a trigger).
- **Two messages at once:** two messages from the same customer arrive together. They are handled
  in order; the contact never has two sessions and never gets the same step twice.
- **24-hour window closes during a wait or delay:** the session ends with the result "window
  closed" instead of sending a free-form message. Flows do not send templates in this feature.
- **Number problems:** the WhatsApp number is disconnected or a send fails for good. The session
  ends with the result "send failed"; the failure shows in the chat as in 002.
- **Contact deleted:** the contact's sessions and answers are erased with the contact (001 FR-015,
  002 FR-042); flow analytics keep anonymous counts.
- **Endless loops:** a flow or a chain of jumps runs many automatic steps without waiting for the
  customer. Publishing refuses known loops; at run time a session that passes 50 steps without a
  customer reply ends with the result "failed: too many steps".
- **Steps sent too fast:** consecutive message steps are spaced so that they arrive in order.
- **Customer writes during a delay:** the message is kept in live chat; the flow continues after the
  delay and does not treat it as an answer unless the next step is a question.
- **Attribute type mismatch:** a question saves to an attribute of another type (for example text
  into a number attribute). The editor refuses this before publishing.
- **Large or odd API replies:** a reply that is not JSON, too large or missing a mapped field. The
  "failed" branch runs for errors; a missing field leaves the answer empty and the fallback is used.
- **Flow deleted:** only unpublished flows can be deleted; their analytics are kept for 12 months as
  read-only history, then removed by retention.
- **Media removed from the library:** a published flow that uses it keeps working with its copy; the
  editor marks the step so the draft can pick a new file.
- **Agent rules (002):** flows answer every chat on their numbers regardless of agent rules; agent
  rules only decide which members see the chat afterwards.
- **Several numbers:** a trigger applies to the numbers chosen for the flow (all connected numbers
  by default), and the same keyword may start different flows on different numbers.

## Requirements *(mandatory)*

### Functional Requirements

**Flows, versions and publishing**

- **FR-001**: Admins and managers MUST be able to create, rename, duplicate and delete flows (only
  unpublished flows can be deleted), and choose the WhatsApp numbers each flow serves (all connected
  numbers by default).
- **FR-002**: Every flow MUST have one editable draft. Publishing MUST create a new numbered,
  read-only published version from the draft; only one version is published at a time.
- **FR-003**: Publishing MUST be refused, with a list of problems linked to their steps, when: a
  step has missing content, a required branch is not connected, a step cannot be reached, a limit is
  broken, an attribute does not exist or has the wrong type, two published flows would share an exact
  trigger on the same number, or flows would loop without waiting for the customer.
- **FR-004**: Running sessions MUST finish on the version they started with. Unpublishing MUST stop
  new sessions and end running ones at their next step with the result "flow unpublished".
- **FR-005**: The editor MUST save the draft automatically and keep the last 20 saved drafts and all
  published versions, so a manager can restore an earlier one into the draft.

**Canvas and steps**

- **FR-006**: The editor MUST show the flow as boxes (steps) joined by lines (branches) that can be
  added, moved, connected, copied and deleted, with zoom and an undo of at least 20 actions.
- **FR-007**: A **message** step MUST send text (with variables) and/or one media file (image,
  video, document or audio) chosen from the media library of 002, within WhatsApp's size limits.
- **FR-008**: A **buttons** step MUST send a text with 1–3 reply buttons and give each button its own
  branch. A **list** step MUST send a text with a list of 1–10 options (optionally in sections) and
  give each option its own branch or one shared branch. Both MUST enforce WhatsApp's length limits
  for button titles, option titles, descriptions and the list button label (to be confirmed against
  Meta's current reference during planning).
- **FR-009**: A **question** step MUST ask for one answer of a type: text (with optional minimum and
  maximum length), number (optional minimum and maximum), email, phone (normalised like 001
  contacts), date (optional earliest and latest, including "today or later"), or one of the
  buttons/list options. It MUST validate the answer, send its retry prompt up to the configured
  number of retries (0–5, default 2), then follow the "invalid" branch; and it MUST have a timeout
  (1 minute to 23 hours, default 1 hour) with a "timed out" branch.
- **FR-010**: Valid answers MUST be stored in the session under a name, and MAY be saved to a contact
  attribute of a matching type; saving MUST record a journey entry as in 002 FR-033, attributed to
  the flow.
- **FR-011**: **Tag** steps MUST add or remove one or more tags; **attribute** steps MUST set or clear
  attributes using fixed values, answers or contact fields. Both MUST record journey entries.
- **FR-012**: A **condition** step MUST compare attributes, tags, answers, contact fields, the
  contact's consent status and "inside or outside working hours" (002 working hours), with rules
  joined by "all" or "any", and branch "yes"/"no". It MUST support equals, not equals, contains,
  starts with, is empty, is not empty, greater than, less than, and before/after for dates.
- **FR-013**: A **delay** step MUST wait 5 seconds to 23 hours before the next step.
- **FR-014**: An **API** step MUST send an HTTPS request (GET, POST, PUT, PATCH or DELETE) with
  headers, query values and a JSON body that can use variables; MUST wait at most the configured
  timeout (1–10 seconds, default 5); MUST map fields of a JSON reply into answers; and MUST branch
  "success" (2xx) or "failed" (any other status, timeout, invalid reply or reply over 100 KB).
- **FR-015**: API steps MUST refuse non-HTTPS addresses and addresses that resolve to private,
  loopback or link-local networks. Header values marked secret MUST be stored encrypted, shown
  masked after saving, and never written to logs, analytics or exports. The editor MUST offer a test
  request with sample values.
- **FR-016**: A **jump** step MUST continue the session in another published flow; a **hand-over**
  step MUST move the chat to Waiting for agent (002 FR-021 alerts included) and end the session; an
  **end** step MUST end the session. Any branch left out of the flow's last step ends it.
- **FR-017**: Variables in texts MUST include contact name, first name, phone (masked for agents in
  member views only, real in customer messages), attributes and session answers, each with an
  optional fallback; a missing value without a fallback MUST leave the space empty, never a raw
  placeholder.
- **FR-018**: Each flow MUST allow up to 200 steps.

**Triggers**

- **FR-019**: Flows MUST support these triggers: keyword or phrase (exact match or contains,
  ignoring case and extra spaces), pattern (a regular expression with a match-time limit), template
  quick-reply button (a chosen button of a chosen template), first-message rule (a phrase in a new
  contact's first ever message, with an optional first-message tag), and manual start from live chat.
- **FR-020**: When several triggers match, the system MUST choose one: exact keyword, then contains
  (the longest phrase first), then pattern, in each case by the flow priority set by managers; a
  first-message rule applies only to a contact's first ever message and may also set the tag.
- **FR-021**: Opt-out, opt-in and "talk to a person" keywords MUST NOT be usable as triggers, and the
  system MUST refuse two published flows with the same exact keyword on the same number.
- **FR-022**: A message from a contact in a session MUST go to that session, unless it matches a
  trigger marked "can interrupt", which ends the old session (result "interrupted") and starts the
  new flow.
- **FR-023**: First-message rules MUST set the contact's first-message tag (002 FR-033) when their
  phrase matches, even if they start no flow.

**Running flows with live chat, consent and policy**

- **FR-024**: Each contact MUST have at most one running session per number at a time, and messages
  from one contact MUST be handled in order, so no step is sent twice.
- **FR-025**: Triggers MUST start flows, and sessions MUST continue, only while the chat is *Open*
  (002 Active). A chat in Waiting for agent or Taken MUST NOT be answered by flows, except a session
  a member started from that chat (FR-031); closing the chat (002 resolve) makes it available to
  flows again.
- **FR-026**: A running session MUST end (result "stopped by a member") when a member takes the chat
  or sends any reply or template in it.
- **FR-027**: The opt-out keyword MUST end any session and get no flow reply (001 consent rules
  apply first); blocked contacts (002 FR-034) MUST NOT start or continue sessions; the "talk to a
  person" keyword MUST end the session and move the chat to Waiting for agent.
- **FR-028**: Flows MUST send free-form messages only inside the 24-hour window. A step that would
  send after the window closed MUST end the session with the result "window closed".
- **FR-029**: When a flow starts or continues on a customer message, the 002 welcome and off-hours
  messages MUST NOT be sent for that message.
- **FR-030**: Flow messages MUST appear in the live chat timeline, labelled automatic with the flow's
  name, MUST NOT count as a member's response in 002 team metrics, and MUST use the chat reply path
  of 002 (ahead of campaign sends).
- **FR-031**: Members with live chat reply permission MUST be able to start a published flow for the
  contact from an Open or Taken chat they may act on while the window is open; starting it from a
  Taken chat MUST keep the chat Taken and hand the conversation to the flow until it ends.
- **FR-032**: A session waiting longer than its timeout MUST follow the "timed out" branch or end;
  a session with no activity for 24 hours MUST end with the result "expired".
- **FR-033**: A session MUST end with the result "failed: too many steps" after 50 steps without a
  customer reply.

**Testing**

- **FR-034**: Each flow MUST accept up to 3 test numbers. Messages from them MUST run the draft
  instead of the published version, be marked "test" in live chat and be left out of analytics.

**Analytics**

- **FR-035**: For today, the last 7 days, the last 30 days or a chosen range (company time zone),
  managers MUST see per flow: sessions started, completed, handed over, timed out, stopped by a
  member, ended by opt-out, interrupted, and failed; and per step: entered, continued, dropped, and
  per button or option how often it was chosen.
- **FR-036**: Managers MUST be able to download the contacts who dropped at a step (CSV, phones
  masked for agents as in 001).

**Starter flows**

- **FR-037**: The system MUST offer at least 6 starter flows written by us (FAQ menu, lead capture,
  appointment request, order status lookup, feedback rating, business hours reply) that create an
  editable draft.

**Permissions, audit, retention**

- **FR-038**: A new permission MUST let admins and managers create, edit, test, publish, unpublish
  and delete flows and see analytics; every member with live chat reply permission (agents included)
  MUST be able to start a published flow from a chat. Viewing the list of published flows MUST be
  open to those members.
- **FR-039**: These MUST be recorded in the audit log without message content or secret values:
  flow created, renamed, duplicated, deleted, published, unpublished, restored; trigger and test
  number changes; API step secret changes.
- **FR-040**: Sessions and their answers MUST follow the 12-month retention of 001, and contact
  deletion MUST erase a contact's sessions and answers while keeping anonymous counts.

### Key Entities

- **Flow**: name, numbers it serves, priority, status (never published, published, unpublished),
  current published version, test numbers, created and updated by.
- **Flow version**: the draft or a numbered published copy of the canvas: steps, branches, triggers
  and settings, with who published it and when.
- **Step**: type (message, buttons, list, question, tag, attribute, condition, delay, API, jump,
  hand over, end), its settings, its branches and where it sits on the canvas.
- **Trigger**: type (keyword, pattern, template button, first-message rule, manual), match settings,
  "can interrupt", the first-message tag for first-message rules, and the flow it starts.
- **Session**: one contact on one number in one flow version: current step, answers, status,
  started and ended times, result (completed, handed over, timed out, stopped by a member, opted
  out, interrupted, window closed, send failed, flow unpublished, expired, failed), and whether it
  was a test.
- **Session step record**: each step a session entered, with the branch it left by and when, for
  analytics.
- **API secret**: an encrypted header value used by an API step, shown masked.
- **Starter flow**: a ready-made flow definition shipped with the product.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 95% of customer messages that start or continue a flow, the flow's next message is
  handed to WhatsApp within 3 seconds of the customer's message reaching the platform (delays and
  API waits excluded).
- **SC-002**: A manager who has not used the builder before can build and publish a 5-step lead
  capture flow (question, validation, attribute, buttons, hand-over) in under 15 minutes.
- **SC-003**: In a test of 1,000 sessions mixing opt-outs, blocked contacts, member takeovers and
  closed windows, zero flow messages go to opted-out or blocked contacts, after a member took the
  chat, or outside the 24-hour window.
- **SC-004**: With 100 messages from one contact arriving at once, the contact has one session and
  receives each step's message exactly once.
- **SC-005**: In a test of 500 sessions, every flow and step count in analytics equals the count from
  the session records.
- **SC-006**: A 200-step flow opens in the editor in under 2 seconds and publishes in under 5 seconds.
- **SC-007**: 100% of drafts with an unconnected required branch, a missing message or a known loop
  are refused at publishing with every problem listed.
- **SC-008**: An API step that times out or fails moves the customer to the "failed" branch within
  the configured timeout plus 1 second in 99% of cases.

## Assumptions

- One company uses the platform, as in 001 and 002; flows are shared by the whole team.
- Flows answer only within the 24-hour customer service window, so they never need templates. Flows
  that start later or send templates (drips, reminders) belong to a later feature.
- Timeouts: questions wait 1 hour by default (1 minute–23 hours); a session with no activity ends
  after 24 hours.
- Retries default to 2 per question.
- Up to 3 test numbers per flow, following the market leader's documented limit (the request said at
  least one).
- WhatsApp's limits for buttons and lists (3 buttons; 10 list options; short titles) are confirmed
  against Meta's current reference during planning.
- Pattern triggers are for advanced users; each pattern match is time-limited so a bad pattern cannot
  slow message handling.
- Flow steps that send several messages in a row space them so WhatsApp delivers them in order.
- Analytics periods use the company time zone, as the 002 team view does.
- The "automatic" label and timeline from 002 are reused for flow messages.

## Out of Scope

- An AI flow generator and AI steps (feature 007, AI agent).
- Commerce steps: product cards, catalog, cart, payments and WhatsApp Forms (feature 006).
- QR-code and Click-to-WhatsApp ad triggers (they need QR campaigns and the ads manager, features 004
  and 009); the trigger list is designed so they can be added.
- Sending templates from flows, and scheduled or drip flows that message customers outside the
  24-hour window.
- Connecting external bot platforms such as Dialogflow (feature 008).
- Multi-language flow variants (a flow can branch on a language attribute instead).

## Dependencies

- **001**: contacts, attributes, tags, consent and opt-out keywords, templates and their quick-reply
  buttons, WhatsApp numbers, roles, audit log, retention.
- **002**: live chat states and timeline, the "automatic" label, the chat reply path, media library,
  working hours, welcome and off-hours messages, the "talk to a person" keyword and Waiting for agent
  alerts, the first-message tag, the customer journey, blocking and team metrics.
