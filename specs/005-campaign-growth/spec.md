# Feature Specification: Campaign Growth

**Feature Branch**: `005-campaign-growth`
**Created**: 2026-11-23
**Status**: Draft
**Input**: User description: "Campaign growth: click tracking, retargeting, failed-message retries and drip campaigns (AiSensy inventory items 5.5, 5.7, 5.8 and 5.12; behaviour only, our own design and text, constitution Principle II). (1) Click tracking: links in template URL buttons and in message text can be tracked through our own short redirect links; each campaign shows who clicked, how many times and when, and a "Clicked" view. (2) Retargeting: from a campaign's results, start a new campaign to the contacts who clicked, replied, read, were delivered, failed or did not read, in one step. (3) Failed-message retries: a manager can set a campaign to retry its failed messages automatically, up to 3 times within 24 hours with set delays, only for errors that may pass, and see the scheduled retries. (4) Drip campaigns: a sequence of approved template messages sent to each enrolled contact with waits between steps; contacts enrol on a starting event (a tag added, opt-in, added by import or the public API, a click on a tracked link, or enrolled by hand); a contact leaves when they reply, opt out, are blocked, get a stop tag, or finish; quiet hours and the company time zone are respected; per-step reports (sent, delivered, read, clicked, replied, left). All sending follows the existing consent, number throughput and Meta frequency-cap rules, templates only outside the 24-hour window, with audit and 12-month retention like 001."

**Context**: This follows the order the user chose on 2026-11-19 (live chat, flows, the AI agent,
then click tracking, drips and integrations). It covers items 5.5, 5.7, 5.8 and 5.12 of
`docs/research/aisensy/feature-inventory-2026-11-19.md`; integrations follow as their own feature.
We match the documented behaviour, not the look: screens, labels and wording are our own
(constitution Principle II).

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Tracked link** | A short link on the company's own web address that stands in for a real address in a message. Each recipient gets their own, so a click tells who opened it. It holds a random code only. |
| **Destination** | The real web address a tracked link sends the person on to. |
| **Click** | A person opening a tracked link. Automatic link previews and robots are not clicks. |
| **Retarget** | Starting a new campaign to a group from an earlier campaign's results (001 already offers Failed, Not read, Read and Delivered). |
| **Replied** | The contact wrote to the campaign's number within 3 days after the campaign message was delivered. |
| **Retry round** | One planned re-send of a campaign's messages that failed for a reason that may pass. A campaign has up to 3, all within 24 hours. |
| **Drip campaign** | A sequence of template messages that each enrolled contact receives one by one, with waits between them. |
| **Step** | One message of a drip: an approved template, its variables and the wait before it. |
| **Enrolment** | One contact's journey through one drip, from joining to finishing or leaving. |
| **Starting event** | What puts a contact into a drip: a tag added, an opt-in, being added by import or the public API, a click on a tracked link, or a member enrolling them. |
| **Leaving rules** | What takes a contact out of a drip early: a reply, an opt-out, a block, a stop tag, deletion, or a member removing them. |
| **Quiet hours** | Times when a drip sends nothing; steps that fall due then wait until sending may start again. |

Campaign terms come from 001 (*draft*, *scheduled*, *running*, *paused*, consent and opt-in), live
chat terms from 002 (the timeline and the customer journey), and flow and AI terms from 003 and 004.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See who clicked the links in a campaign (Priority: P1)

A manager preparing a campaign marks its links as tracked: a template URL button whose address has a
variable part, or a template variable that holds a link. They enter where each link should lead.
When the campaign runs, every recipient gets their own short link on the company's web address. A
click sends the person straight on to the destination and is recorded. The campaign's results show
how many people clicked, the click rate, total clicks per link, and a **Clicked** view listing each
clicker with their first and last click and how many times they clicked.

**Why this priority**: Clicks show which campaigns bring people to the shop or the website, and
they feed retargeting and drips. Without them, a campaign's success is only "delivered" and "read".

**Independent Test**: Create a campaign with a URL button whose address has a variable part, mark it
as tracked to the shop's sale page and send it to three test contacts. Open the link from two of
them (one twice) and let WhatsApp fetch a link preview. The results show 2 clickers and 3 clicks, the
Clicked view lists both with their times, and the preview is not counted.

**Acceptance Scenarios**:

1. **Given** a template whose URL button has a variable part, **When** a manager marks it as tracked with a destination, **Then** each recipient's message carries their own short link, and the link holds no name, phone number or other personal data.
2. **Given** a recipient taps a tracked link, **When** the link opens, **Then** they land on the destination at once, and the click is recorded with its time against that recipient and campaign.
3. **Given** WhatsApp or another service fetches the link to build a preview, **When** results are shown, **Then** that fetch is not counted as a click.
4. **Given** a campaign with tracked links, **When** a member opens its results, **Then** they see unique clickers, the click rate (clickers out of delivered), total clicks per link, and a Clicked view with each clicker's first click, last click and number of clicks, exportable to a file.
5. **Given** a template whose link has no variable part, **When** a manager tries to track it, **Then** they are told it cannot be tracked per person and why.

---

### User Story 2 - Retarget clickers, repliers and others in one step (Priority: P1)

From a campaign's results, a member picks a group (Clicked, Not clicked, Replied, Not replied,
Read, Not read, Delivered or Failed), sees how many contacts are in it, and creates a new draft
campaign to exactly those contacts in one step.

**Why this priority**: Following up with the people who showed interest is the main use of click and
reply data; it turns results into the next campaign without exporting and re-importing lists.

**Independent Test**: After the campaign in User Story 1, choose **Retarget → Clicked**. A draft
campaign opens with exactly the two clickers, minus anyone who has opted out since, and names the
campaign it came from.

**Acceptance Scenarios**:

1. **Given** a campaign's results, **When** the member chooses a group, **Then** they see the number of contacts in it before anything is created.
2. **Given** the member confirms, **When** the draft is created and later launched, **Then** its audience is exactly the group as it stands at launch (as 001 retargeting works), minus contacts who have since opted out or been deleted, and it shows which campaign and group it came from.
3. **Given** the Replied group, **When** it is built, **Then** it holds the contacts who wrote to the campaign's number within 3 days after their campaign message was delivered.
4. **Given** a group with no contacts, **When** the member looks at it, **Then** retargeting that group is not offered.

---

### User Story 3 - Retry failed messages automatically (Priority: P2)

Before launching (or while a campaign is scheduled), a manager turns on **Retry failed messages**,
chooses up to 3 retry rounds and the delay before each (for example 1, 4 and 12 hours), all within 24
hours of the campaign's start. After the normal sending and its automatic short retries, messages
that failed for a reason that may pass are sent again in each round. Members see the scheduled
rounds, can cancel them, and see how many messages each round recovered.

**Why this priority**: Temporary problems (a busy WhatsApp service, sending-speed limits, too many
messages to one person in a short time) otherwise lose recipients for good; retrying later
recovers some of them without a new campaign. Messages held back by Meta's per-person limit on
marketing messages are not retried within the 24 hours, because Meta asks to wait at least 24
hours; the results list them apart so they can be retargeted later.

**Independent Test**: Launch a campaign of 20 recipients with retries set to 2 rounds after 1 and 3
hours, where 5 messages fail with a temporary error and 2 with an invalid number. The scheduled
retries show 5 recipients in round 1; after round 1 succeeds for 3, round 2 holds 2; the 2 invalid
numbers are never retried; nobody receives the message twice.

**Acceptance Scenarios**:

1. **Given** a draft or scheduled campaign, **When** a manager turns on retries, **Then** they can choose 1 to 3 rounds and a delay for each, and settings whose last round would start more than 24 hours after the campaign starts are refused.
2. **Given** a running campaign with retries, **When** its messages fail, **Then** only failures that may pass are put into the next round; invalid numbers, numbers not on WhatsApp, opted-out contacts and template problems are not.
3. **Given** a retry round starts, **When** it sends, **Then** it checks consent again, skips contacts who opted out meanwhile, and never sends to a recipient whose message already succeeded.
4. **Given** a campaign with scheduled rounds, **When** a member opens **Scheduled retries**, **Then** they see each round's time and number of recipients and can cancel a round or all of them; pausing or cancelling the campaign pauses or cancels its rounds.
5. **Given** a finished campaign with retries, **When** its results are shown, **Then** they show how many messages each round recovered, and its totals and cost estimate include the retried messages.

---

### User Story 4 - Build and run a drip campaign (Priority: P2)

A manager builds a drip: a name, the sending number, and steps. Each step is an approved template
with its variables (and tracked links if wanted) and the wait before it: the first step's wait is
counted from joining (or "right away"), later ones from the previous step. They can set quiet hours
(for example 9:00–21:00 in the company time zone) and the leaving rules, then activate it. They
enrol contacts by hand (chosen contacts or a filter). Each contact then receives the steps in order
until they finish or leave. Members can pause, resume, edit and archive the drip.

**Why this priority**: Follow-up sequences (welcome series, reminders after a first order, nurturing
new leads) bring more replies and sales than one-off campaigns, and they run without a member
sending each message.

**Independent Test**: Build a 3-step drip with waits of 10 minutes, 1 hour and 1 day and quiet hours
9:00–21:00, activate it and enrol two contacts by hand. Both get step 1 about 10 minutes later. One
contact replies, leaves the drip and gets nothing more. The other gets step 2 an hour later; step 3
falls due at 23:00, so it waits until 9:00.

**Acceptance Scenarios**:

1. **Given** a manager building a drip, **When** they add steps, **Then** each step takes an approved template from the drip's number, its variables, optional tracked links and a wait from 10 minutes to 30 days, up to 10 steps.
2. **Given** a drip is activated, **When** a step falls due, **Then** the contact gets that step's template unless they have left, and steps due in quiet hours wait until sending may start, keeping their order.
3. **Given** an enrolled contact replies to the drip's number, opts out, is blocked, is deleted, or gets one of the drip's stop tags, **When** that happens, **Then** they leave the drip at once and get no further steps; the reply rule and the stop tags can be switched off or changed, the others cannot.
4. **Given** a contact already in a drip, **When** they would be enrolled again, **Then** they are not added twice; after leaving or finishing they join again only if the drip allows joining again.
5. **Given** a step's template is paused, disabled or rejected, or the number is disconnected, **When** a step would be sent, **Then** the drip pauses itself and managers are alerted.
6. **Given** an active drip, **When** a manager edits it, **Then** the changes apply to steps contacts have not reached yet; pausing stops all sending until it is resumed, and steps that fell due meanwhile go out after resuming, outside quiet hours.
7. **Given** a contact receives a drip message, **When** a member opens the chat, **Then** the message shows in the chat timeline as an automatic template message from the drip, and the customer journey shows when the contact joined and left the drip and why.

---

### User Story 5 - Enrol contacts automatically on starting events (Priority: P2)

A manager chooses one or more starting events for a drip: a chosen tag is added to a contact, a
contact opts in, a contact is added by import or by the public API, or a contact clicks a tracked
link in a chosen campaign (or any campaign). From then on, matching contacts join the drip by
themselves.

**Why this priority**: Most follow-ups start from something the contact did; automatic enrolment
makes drips run without a member watching for those moments.

**Independent Test**: Set a drip to start when the tag "new lead" is added and when a contact clicks
the sale link of a campaign. Tag one contact and click the link as another. Both join the drip once
and get its first step; a contact who was already in the drip is not enrolled again.

**Acceptance Scenarios**:

1. **Given** a drip that starts on a tag, **When** that tag is added to a contact by a member, an import, a flow, the AI agent or the public API, **Then** the contact joins the drip.
2. **Given** a drip that starts on opt-in, **When** a contact's consent becomes opted in, **Then** they join.
3. **Given** a drip that starts on contacts added by import or by the public API, **When** such a contact is created, **Then** they join; contacts that already existed do not.
4. **Given** a drip that starts on a click, **When** a recipient clicks a tracked link of the chosen campaign, **Then** they join, once.
5. **Given** a paused or draft drip, **When** a starting event happens, **Then** nobody joins; events that happened while it was paused are not replayed later.

---

### User Story 6 - Drip results (Priority: P3)

Each drip shows how many contacts are in it now, finished and left (by reason), and for each step
how many were sent, delivered, read, clicked, replied, failed and skipped, with the list of
contacts behind each number, exportable to a file.

**Why this priority**: Results show which step loses people and which one brings replies, so
managers can improve the sequence; drips also work without this view.

**Independent Test**: After running the drip of User Story 4, its results show step 1 sent 2,
delivered 2, replied 1; 1 contact left (replied) and 1 still in the drip; the numbers match the
contacts listed under each.

**Acceptance Scenarios**:

1. **Given** a drip with enrolments, **When** a member opens its results, **Then** they see the contacts in the drip, finished and left by reason, and per-step sent, delivered, read, clicked, replied, failed and skipped counts.
2. **Given** a number in the results, **When** the member selects it, **Then** they see the contacts behind it and can export them to a file.
3. **Given** the results, **When** they are compared with the messages recorded, **Then** every count equals the underlying records.

---

### Edge Cases

- **Link previews and robots:** WhatsApp and other services fetch links to build previews, and
  security scanners open links. These visits are not counted as clicks, but the person still reaches
  the destination when they tap.
- **Forwarded messages:** someone else opens a forwarded tracked link → the click counts for the
  original recipient, as nothing tells them apart; the help text says so.
- **Expired or unknown links:** a link older than the 12-month retention, or a code that does not
  exist, shows a short page saying the link is no longer available, and never sends anyone to an
  address the platform did not store.
- **Destination changed after sending:** a manager corrects a tracked link's destination while the
  campaign runs → new clicks go to the new address; the change is audited.
- **Unsafe destinations:** only web addresses starting with `https://` or `http://` are accepted, and
  `http://` gets a warning. Links to the platform's own short-link address are refused.
- **Retry versus pause or cancel:** a paused campaign's retry rounds wait; a cancelled campaign's
  rounds are cancelled; a round that would start after the 24-hour limit is dropped with a note.
- **Retry after a template or number problem:** the template is paused or disabled, or the number is
  disconnected, when a round is due → the round does not send, and the reason is shown.
- **The per-person marketing limit:** Meta holds back a marketing message because the person
  already got many → it is not put into a retry round (Meta asks to wait at least 24 hours); the
  results show these recipients as their own group for a retarget the next day.
- **Retarget an old campaign:** a campaign whose messages were removed by the 12-month retention can
  no longer be retargeted, and the option says why.
- **Two starting events at once:** a contact is tagged and opts in at the same moment → they join
  the drip once.
- **Contact in several drips:** allowed; each drip runs its own steps. Meta's limits on marketing
  messages per person may make some steps fail, and the results show why.
- **No consent for a step:** a contact with no opt-in reaches a marketing step → that step is
  skipped and recorded with the reason, and the contact moves on; an opt-out ends the drip.
- **Failures in a drip:** an invalid number or a number not on WhatsApp ends the drip for that
  contact; other failures are recorded on the step, and the contact moves on to the next step.
- **Long waits and edits:** a contact waiting 20 days for step 3 when the manager deletes step 3 →
  they move on to step 4 at its own wait, counted from step 2.
- **Quiet hours across days:** a step due at 23:30 with quiet hours 21:00–9:00 goes out after 9:00;
  steps keep their order even when several are due when sending may start.
- **Sending limits:** many enrolments at once exceed the number's sending speed or Meta's messaging
  limit → steps go out later, in order, and the results show the delay.
- **The contact writes during a drip:** the reply reaches live chat as usual (002); flows and the AI
  agent answer it as for any customer message (003, 004); with the reply rule on, the contact leaves.
- **Deleted contact:** a contact deleted while in a drip leaves it; their enrolment and click
  records lose the link to them, and the counts stay.
- **Archived drip:** archiving stops it for everyone in it, keeps its results, and frees its name.

## Requirements *(mandatory)*

### Functional Requirements

**Tracked links and clicks**

- **FR-001**: Managers MUST be able to mark links as tracked when preparing a campaign or a drip
  step: a template URL button whose address has a variable part, or a template variable used as a
  link. For each, they MUST enter the destination address.
- **FR-002**: Each recipient MUST get their own tracked link on the company's own web address. The
  link MUST contain only a random code that cannot be guessed in practice, and no name, phone
  number or other personal data.
- **FR-003**: Opening a tracked link MUST send the person on to its destination at once and MUST
  record a click with its time, the recipient, the campaign or drip step, the link, and the device
  kind (phone or computer). It MUST NOT keep the visitor's internet address.
- **FR-004**: Link previews, robots and security scanners MUST NOT be counted as clicks.
- **FR-005**: Only `https://` and `http://` destinations MUST be accepted (with a warning for
  `http://`). Unknown or expired codes MUST show a page saying the link is not available and MUST
  NOT send anyone onward.
- **FR-006**: Managers MUST be able to change a tracked link's destination while it is in use; new
  clicks MUST go to the new address, and the change MUST be audited.
- **FR-007**: Managers MAY switch on standard campaign tags for a link (source "whatsapp", medium,
  and the campaign or drip name) added to the destination address, so web analytics can see the
  visits.
- **FR-008**: A campaign's results MUST show unique clickers, the click rate (clickers out of
  delivered), total clicks per link, and a Clicked view with each clicker's first click, last click
  and number of clicks. The view MUST be exportable to a file, with phone numbers masked as 001
  masks them for agents.
- **FR-009**: Each click MUST add an entry to the contact's journey (002) naming the campaign or
  drip, and the first click per message MUST be shown on that message in the chat timeline.

**Retargeting**

- **FR-010**: From a campaign's results, members with permission MUST be able to create a draft
  campaign for any of these groups: Clicked, Not clicked (delivered with no click), Replied, Not
  replied (delivered with no reply), Read, Not read, Delivered and Failed. This extends 001's
  retargeting (FR-031 there).
- **FR-011**: The group size MUST be shown before the draft is created. The draft's audience MUST be
  exactly that group as it stands when the campaign launches (as 001 retargeting works), minus
  opted-out and deleted contacts. It MUST name the source campaign and group.
- **FR-012**: Replied MUST mean a message from the contact on the campaign's number within 3 days
  after their campaign message was delivered.

**Failed-message retries**

- **FR-013**: Managers MUST be able to switch on retries for a draft or scheduled campaign, with 1
  to 3 rounds. Each round's delay is chosen from 30 minutes, 1, 2, 4, 8 or 12 hours after the
  previous attempt. The last round MUST start within 24 hours of the campaign's start.
- **FR-014**: Only messages that failed for a reason that may pass MUST go into a round: a
  temporary WhatsApp service error, a sending-speed limit, or too many messages to one person in a
  short time. Invalid numbers, numbers not on WhatsApp, opted-out contacts, template problems and
  account problems MUST NOT be retried. Messages held back by Meta's per-person limit on marketing
  messages MUST NOT be retried within the 24 hours (Meta asks to wait at least 24 hours, and early
  retries fail again); the results MUST show them as their own group, which can be retargeted the
  next day.
- **FR-015**: A round MUST check consent again, skip contacts who opted out meanwhile, and never
  send to a recipient whose message already succeeded. Nobody may receive the same campaign
  message twice (001 SC-004).
- **FR-016**: Members MUST be able to see each campaign's scheduled rounds (time, number of
  recipients) and a list of all scheduled rounds across campaigns, and to cancel a round or all of a
  campaign's rounds. Pausing a campaign MUST pause its rounds; cancelling it MUST cancel them.
- **FR-017**: A round that cannot send because the template is paused or disabled or the number is
  disconnected MUST be skipped with the reason shown.
- **FR-018**: Results MUST show how many messages each round recovered; campaign totals and the
  cost estimate MUST include retried messages.

**Drip campaigns: building**

- **FR-019**: Managers MUST be able to create drips with a name (unique among drips that are not
  archived), a sending number, 1 to 10 steps and leaving rules. Each step has an approved template
  of that number's account, its variable mapping (contact fields, attributes or fixed text, as in
  001), optional tracked links and a wait.
- **FR-020**: The first step's wait MUST count from joining and may be zero ("right away"); every
  other step's wait counts from the previous step's sending. Waits MUST be between 10 minutes and 30
  days, except a zero first wait.
- **FR-021**: Managers MUST be able to set optional quiet hours (a daily time range and days of the
  week, in the company time zone). Steps that fall due then MUST wait until sending may start, in
  their order.
- **FR-022**: Activating a drip MUST be refused, with each problem listed, when a step's template is
  not approved or not fully mapped, or the number is not connected. A drip with no starting event
  can be activated: its contacts are enrolled by hand (clarified during implementation, since
  manual enrolment needs an active drip).
- **FR-023**: Drips MUST have the states Draft, Active, Paused and Archived. Managers MUST be able
  to edit an active drip; changes apply to steps contacts have not reached. A contact waiting for a
  removed step moves on to the next step at its wait.

**Drip campaigns: joining and leaving**

- **FR-024**: Managers MUST be able to choose starting events:
  - a chosen tag added to a contact (by anyone or anything: members, imports, flows, the AI agent,
    the public API)
  - a contact's consent becoming opted in
  - a new contact added by import or by the public API
  - a click on a tracked link of a chosen campaign or of any campaign
- **FR-025**: Members with permission MUST be able to enrol contacts by hand, chosen one by one or
  by a contact filter. They MUST see how many will join and how many cannot (opted out, already
  in the drip).
- **FR-026**: A contact MUST be in a drip at most once at a time. They MAY join again after leaving
  or finishing only when the drip allows joining again (off by default).
- **FR-027**: Only active drips MUST enrol contacts; events while a drip is draft or paused MUST NOT
  be replayed later.
- **FR-028**: A contact MUST leave a drip at once, with the reason recorded, when they:
  - opt out (always)
  - are blocked (always)
  - are deleted (always)
  - are removed by a member (always)
  - write to the drip's number (on by default, can be switched off)
  - get one of the drip's stop tags (optional)
  - click a tracked link of the drip (optional, off by default)
  - receive the last step (finished)
  No step MAY be sent after the leaving event.

**Drip campaigns: sending**

- **FR-029**: Drip steps MUST be sent as template messages, with the consent rules of 001. Opted-out
  contacts get nothing. A marketing template needs an opt-in: without one the step is skipped and
  recorded, and the contact moves on.
- **FR-030**: Drip messages MUST share each number's sending speed with campaigns, after live chat
  replies (002), and MUST follow 001's automatic short retries for temporary errors.
- **FR-031**: A step that fails because the number is invalid or not on WhatsApp MUST end the drip
  for that contact. Other final failures MUST be recorded on the step, and the contact moves on.
- **FR-032**: A drip MUST pause itself, and managers MUST be alerted, when a step's template becomes
  paused, disabled or rejected or its number is disconnected.
- **FR-033**: Drip messages MUST appear in the contact's chat timeline (002) as automatic template
  messages labelled with the drip and step. Joining and leaving (with the reason) MUST appear in the
  customer journey.
- **FR-034**: Replies to drip messages MUST reach live chat, flows and the AI agent exactly as other
  customer messages do (002–004); quick-reply buttons of drip templates MUST start flows as 003's
  template-button triggers do.

**Results and exports**

- **FR-035**: Each drip MUST show the contacts in it now, finished and left by reason. Each step
  MUST show sent, delivered, read, clicked, replied, failed and skipped counts. Selecting a count
  MUST show the contacts behind it, exportable to a file.
- **FR-036**: All counts (clicks, replies, retry recoveries, drip steps) MUST equal the underlying
  records.

**Permissions, audit, retention and privacy**

- **FR-037**: Admins and managers MUST be able to:
  - set up tracked links and retries
  - build drips (`campaigns.manage`)
  - activate, pause and archive drips, enrol by hand and retarget (`campaigns.launch`)
  Agents MAY view results with masked phone numbers (`campaigns.view`), as in 001.
- **FR-038**: The audit log MUST record:
  - drip created, changed, activated, paused, resumed, archived and deleted
  - contacts enrolled or removed by hand
  - retry settings changed and rounds cancelled
  - tracked link destinations changed
- **FR-039**: Click records, enrolments and step results MUST follow the 12-month retention of 001.
  Tracked links of purged messages MUST stop working.
- **FR-040**: Deleting a contact MUST remove them from drips and remove the link between them and
  their clicks and enrolments, while keeping anonymous counts.
- **FR-041**: Logs MUST NOT contain tracked link codes together with phone numbers, or destination
  addresses with personal data.

### Key Entities

- **Tracked link**: one recipient's short link. It records its code, the destination, the message
  (campaign or drip step) and recipient it belongs to, and whether campaign tags are added.
- **Link destination**: the address and settings a manager gave for a tracked button or link
  variable in a campaign or drip step, shared by that message's tracked links.
- **Click**: one opening of a tracked link, with its time and device kind.
- **Retry plan**: a campaign's retry settings (rounds and delays).
- **Retry round**: one planned re-send, with its time, recipients, state and outcome per message.
- **Drip**: name, number, state, quiet hours, leaving rules, starting events, whether joining again is
  allowed, and its steps.
- **Drip step**: order, template, variable mapping, tracked links and wait.
- **Enrolment**: a contact in a drip. It records when they joined and how (event or member), the
  current step and when it is due, and when and why they left or finished.
- **Step send**: one step sent (or skipped) for one enrolment, linked to the 001 message record and
  its status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 95% of clicks, the person reaches the destination within 1 second of opening the
  tracked link, with 100 clicks a second.
- **SC-002**: In a test of 1,000 clicks mixed with 300 link-preview and robot fetches, the click
  counts shown equal the 1,000 clicks exactly.
- **SC-003**: A member creates a retarget campaign to a campaign's clickers in under 1 minute, and its
  audience equals the clickers minus opted-out contacts exactly.
- **SC-004**: In a campaign of 5,000 messages where 500 fail with temporary errors, every retry round
  starts within 2 minutes of its planned time. No recipient receives the message twice, and no retry
  goes to a contact who opted out meanwhile.
- **SC-005**: With 10,000 contacts in active drips, 95% of drip steps are sent within 5 minutes of
  falling due. This excludes quiet hours and waits caused by the number's sending limits.
- **SC-006**: In a test of 1,000 enrolled contacts mixing replies, opt-outs, blocks, stop tags,
  deletions and removals, zero drip messages are sent after a contact's leaving event.
- **SC-007**: A manager who has not used drips before builds and activates a 3-step drip in under 10
  minutes.
- **SC-008**: Every click, reply, retry and drip count on the results pages equals the underlying
  records exactly.
- **SC-009**: No tracked link contains personal data, and in a test of one million random codes, none
  opens a real link.

## Assumptions

- Tracked links use the company's own public web address: the server that already receives Meta's
  webhooks, on its own short path or subdomain. No outside link-shortening service is used. During
  planning, Meta's current rules for links in templates and URL buttons are checked, including how
  they treat link shorteners and redirects.
- Per-person tracking needs a variable part in the URL button, or a template variable used for the
  link. Fixed links in already approved templates are not tracked; a template must be created with
  a variable part to be trackable.
- "Replied" uses a 3-day window after delivery, and the Not clicked and Not replied groups count
  delivered messages only. These are defaults confirmed during planning.
- The list of failures that may pass is built from Meta's current error reference during planning:
  temporary service errors, sending-speed limits and too many messages to one person in a short
  time. Meta's per-person marketing limit needs a wait of at least 24 hours, so it is shown for a
  later retarget instead.
- The retry delays (30 minutes to 12 hours), the 24-hour limit, 10 steps per drip, waits of 10
  minutes to 30 days, and 20 active drips with up to 100,000 contacts in each are starting values
  confirmed during planning.
- Quiet hours are off by default. When switched on, they start as 21:00–9:00 every day in the company
  time zone, the same time zone used for usage periods.
- Drip messages are always templates, because their timing does not depend on an open 24-hour
  window.
- One company uses the platform, as in 001–004, with numbers in the UAE and costs in USD.

## Out of Scope

- Tracking links in messages typed in live chat, written by the AI agent or sent by flows (a later
  change).
- Branching drips (different steps by condition), A/B tests and per-contact send-time optimisation.
- Starting drips from Shopify, WooCommerce or other systems, outbound webhooks, and an API to enrol
  contacts (the Integrations feature).
- Email or SMS steps.
- QR codes, the website chat button, and carousel, limited-time offer and authentication templates
  (a later Templates and growth feature).
- Click-to-WhatsApp ads (the Ads feature).

## Dependencies

- **001**:
  - campaigns, their states and reports
  - templates and their approval, variable mapping
  - contacts, tags, attributes, consent and opt-in rules, contact filters, imports and the public
    API
  - WhatsApp numbers with their sending speed and messaging limits, the automatic short retries
  - the rate card and cost estimates, retargeting, roles, the audit log, retention and contact
    deletion
- **002**: the chat timeline, automatic messages, the customer journey, blocking, live chat states
  and alerts.
- **003**: template quick-reply button triggers and flows that answer customer replies.
- **004**: the AI agent answering customer replies.
- **External**:
  - a public HTTPS web address for tracked links (the one Meta's webhooks already use)
  - Meta's approval of templates whose URL buttons have a variable part
