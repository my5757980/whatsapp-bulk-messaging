# Feature Specification: Contacts, Settings and Security

**Feature Branch**: `010-contacts-settings-security`
**Created**: 2026-11-28
**Status**: Draft
**Input**: User description: "Contacts, settings and security (AiSensy inventory items 1.3, 1.4, 1.6, 2.3, 3.2, 3.3, 3.5, 3.8, 3.9, 3.10 and 5.11). Saved segments (lists) built from tags, attributes, consent, lead source and behaviour (delivered, read, replied, clicked, failed, from campaigns), with live counts, usable as audiences for campaigns, drips and retargeting. A full contacts export (CSV, the current filter or a segment, phones masked by role, audited). Bulk add and remove tags on selected or filtered contacts, and automatic tags (first message, API, broadcast, import). A lead source on every contact (organic, API, import label, chat link, ad, form, website button), shown and filterable. Global attributes: company-wide values (for example the support phone or store address) usable as template variables, in messages, flows and AI replies. Opt-in and opt-out keyword automation: up to 5 keywords each, with a reply chosen as text or an approved template. Date automations such as birthdays: any date attribute, a send time in the company time zone, skip opted-out contacts, a chosen approved template, and results. Two-factor authentication for team logins (an authenticator app with recovery codes; admins can require it for everyone). Editing the WhatsApp Business profile (logo, description, address, email, category, websites) through Meta, with the display name status and a guided Blue Tick (official business account) application checklist. In-app guides for moving a number from another provider and for moving it back to the WhatsApp Business app. Same features and flows as AiSensy's public docs, with our own design and wording."

**Context**: Features 001–009 are built. This feature covers the row "Contacts, settings and
security" of `docs/research/aisensy/feature-inventory-2026-11-19.md`. Some parts exist already and
are extended rather than rebuilt:
- Contacts have tags, typed custom attributes (text, number, date, yes/no), consent with its source
  and date, and a lead source field (002) that only some entry points fill today.
- Campaigns can already target contacts by tag and attribute rules, but the rules are not saved
  for reuse and cannot use behaviour such as replied or clicked (005 has these only as retarget
  groups of one campaign).
- Opt-in and opt-out keywords exist (001), but nothing is sent back to the person.
- Numbers already show their quality rating and messaging limit (001); the business profile cannot
  be edited and there is no team login protection beyond the password.

We match the documented behaviour, not the look: screens, labels and guide texts are our own
(constitution Principle II).

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Segment** | A saved, named audience: a set of rules over contacts (tags, attributes, consent, lead source, when they were added, and what they did with past campaigns). Its members are worked out again every time it is used, so it stays current. |
| **Behaviour rule** | A segment rule about campaign messages: the contact was sent, delivered, read, replied to, clicked a link in, or failed to get a message, from one chosen campaign or from any campaign in a recent period. |
| **Lead source** | Where a contact first came from: organic (they wrote first), API, import (with the import's label), campaign upload, chat link, ad, lead form, WhatsApp Form, website button, store, or a custom label. Set once, when the contact is created. |
| **Automatic tag rule** | A company setting that adds a tag when something happens: a contact is created from a given lead source, replies to a campaign, clicks a campaign link, or opts in or out. |
| **Global attribute** | A company-wide value with a name, such as the support phone, store address or opening hours. It can fill template variables and be inserted in chat replies, flows and AI agent replies, so a change is made once. |
| **Keyword reply** | The message sent back when a person opts in or out with a keyword (for example "Done, you will not get offers from us. Send START to join again."). It is either a plain text or an approved template. |
| **Date automation** | A rule that sends an approved template to each contact on a date stored in one of their date attributes (a birthday, a renewal date), on the day or a set number of days before or after, at a chosen time. |
| **Occurrence** | One date on which a date automation is due for one contact (for a birthday, once a year). Each contact gets at most one message per occurrence. |
| **Two-factor authentication (2FA)** | A second sign-in step: after the password, a six-digit code from an authenticator app on the member's phone. |
| **Recovery code** | A one-time code, given when 2FA is set up, that replaces the app code when the phone is lost. |
| **Business profile** | What customers see about the company's WhatsApp number: the profile picture, about text, description, address, email, category and websites. |
| **Display name status** | Meta's review state of the name shown on the number (approved, pending or declined). Only Meta changes it. |
| **Official business account (blue tick)** | A badge Meta may grant to a notable, verified business. The company applies through Meta; the platform only guides the steps. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Saved segments as audiences (Priority: P1)

A marketing manager builds a segment such as "Dubai customers who read our last two offers but did
not reply": city is Dubai, tag "customer", read a message from campaign A or B, and did not reply.
The segment shows how many contacts match now and how many of them can get marketing messages.
They save it and pick it as the audience of a new campaign, and later enrol its members in a drip.
Next week the same segment includes the new contacts that match.

**Why this priority**: targeting is the main reason teams keep contacts organised; today every
campaign rebuilds its filter by hand and behaviour cannot be used at all.

**Independent Test**: create a segment with tag, attribute, consent and behaviour rules; check its
count against the contacts seeded for each rule; launch a campaign to it; enrol it in a drip.

**Acceptance Scenarios**:

1. **Given** contacts with different tags, attributes and campaign history, **When** a manager
   combines rules with "all of" and "any of" groups, **Then** the count shown matches the contacts
   that fit, together with the count that can receive marketing messages.
2. **Given** a saved segment, **When** it is chosen as a campaign audience, **Then** the campaign's
   estimate and recipients come from the segment's members at launch, with opted-out and blocked
   contacts left out as for any campaign.
3. **Given** a saved segment, **When** a member is added to a drip from it, **Then** every current
   member who may join the drip is enrolled once, and those who cannot are counted with the reason.
4. **Given** a segment used by a draft or scheduled campaign, **When** someone deletes a tag or
   attribute it uses, **Then** the segment shows the broken rule and the campaign cannot launch
   until the segment is fixed.
5. **Given** an agent, **When** they open contacts, **Then** they can use segments to filter but
   cannot create, change or delete them.

---

### User Story 2 - Organise contacts at scale: bulk tags, automatic tags, lead source and export (Priority: P1)

An admin selects 3,000 contacts from a filter and adds the tag "VIP" in one action, then removes
the tag "trial" from everyone in a segment. They set rules so that contacts created from the
website button get the tag "web lead" and contacts who click a campaign link get "interested". Every
contact shows where it came from, and the list can be filtered by it. At the end of the month a
manager downloads all contacts of a segment as a spreadsheet.

**Why this priority**: tags and sources only help when they can be managed for many contacts at
once; the export is needed for reporting and for other systems.

**Independent Test**: bulk add and remove tags on a selection and on "all matching"; trigger each
automatic tag rule; check the lead source of contacts created from each entry point; download an
export of a filter and of a segment and compare it with the screen.

**Acceptance Scenarios**:

1. **Given** a filtered contact list, **When** a manager selects some rows, or chooses "all
   matching", and adds or removes tags, **Then** exactly those contacts change, the result says how
   many changed, and the action is in the audit log.
2. **Given** an automatic tag rule "lead source is website button → web lead", **When** a contact is
   created from the website button, **Then** it gets the tag at once; contacts that existed before
   the rule are not changed.
3. **Given** automatic tag rules for campaign replies, link clicks, opt-in and opt-out, **When** each
   event happens, **Then** the tag is added once, and removing it by hand is not undone until the
   event happens again.
4. **Given** contacts created by each entry point (they wrote first, API, import with a label,
   campaign upload, chat link, ad, lead form, WhatsApp Form, website button, store), **When** they
   are opened, **Then** each shows its lead source, which never changes later, and the list filters
   by it.
5. **Given** a filter or a segment, **When** a member with export permission downloads contacts,
   **Then** the file has one row per contact with name, phone, tags, attributes, consent, lead source
   and dates, matches the screen's count, masks phones for roles that see them masked, and is
   audited.

---

### User Story 3 - Global attributes (Priority: P2)

An admin adds global attributes: "support_phone", "store_address" and "opening_hours". A manager
maps a template variable to "store_address" in a campaign; an agent inserts "opening_hours" into a
chat reply; a flow message and the AI agent use "support_phone". When the store moves, the admin
changes the address once and every new message uses it.

**Why this priority**: it saves repeated edits and wrong details, but campaigns work without it.

**Independent Test**: create global attributes; use one in a campaign variable, a saved reply, a
flow message and an AI agent instruction; change the value; check that new messages use the new
value and earlier messages keep what was sent.

**Acceptance Scenarios**:

1. **Given** a global attribute, **When** a campaign maps a variable to it, **Then** every recipient
   gets the value in force when the campaign launches (when all its variables are filled), and the
   launch is refused while the value is empty.
2. **Given** a global attribute, **When** an agent inserts it into a reply or a saved reply uses it,
   **Then** the sent text contains the current value.
3. **Given** a global attribute used in a flow message and in an AI agent's instructions, **When**
   the flow runs or the agent replies, **Then** the current value is used.
4. **Given** a global attribute in use, **When** an admin tries to delete it, **Then** the places that
   use it are listed and the deletion is refused until they no longer do.

---

### User Story 4 - Keyword replies for opt-in and opt-out (Priority: P2)

An admin sets the reply for opt-out keywords to the text "You will not get offers from us any more.
Send START to join again." and the reply for opt-in keywords to an approved welcome template. A
customer sends "STOP": they are opted out and get the reply within seconds.

**Why this priority**: people expect a confirmation, and it lowers repeated STOP messages and
blocks, but consent already works without it.

**Independent Test**: set both replies (one text, one template); send each keyword from a test phone;
check consent, the reply and that no reply goes to a blocked contact.

**Acceptance Scenarios**:

1. **Given** keyword replies set, **When** a person sends an opt-out or opt-in keyword, **Then**
   their consent changes as today and the matching reply is sent once from the number they wrote
   to.
2. **Given** an opt-out reply set as a template, **When** an admin chooses the template, **Then**
   only approved utility templates can be chosen.
3. **Given** a person who sends the same keyword several times in a day, **When** each message
   arrives, **Then** only the first one in 24 hours gets a reply.
4. **Given** a blocked contact, **When** they send a keyword, **Then** nothing is sent back.
5. **Given** the keyword lists, **When** an admin edits them, **Then** each list holds up to 20
   keywords, a keyword cannot be in both lists, and the change applies to the next message.

---

### User Story 5 - Birthday and other date automations (Priority: P2)

A manager creates the automation "Birthday wishes": the date attribute "birthday", every year on the
day, at 10:00 company time, from the main number, with an approved template whose variable is the
contact's first name. Each morning the contacts with a birthday that day get the message once. A
second automation sends a renewal reminder three days before each contact's "renewal_date". The
automation page shows how many were sent, delivered, read, replied and failed per day.

**Why this priority**: a well-known retention tool; it builds on contacts, attributes and templates
that already exist.

**Independent Test**: create a yearly and a one-time date automation; seed contacts whose dates are
due today, tomorrow, on 29 February and empty; run the day; check who got a message, when, and the
results; pause and resume.

**Acceptance Scenarios**:

1. **Given** a yearly automation on a date attribute, **When** the send time comes on a day that
   matches a contact's day and month (ignoring the year), **Then** that contact gets the template
   once for this year.
2. **Given** an automation set to a number of days before or after the date, **When** the shifted
   day comes, **Then** the contact gets the message on that day, at the send time.
3. **Given** contacts who are opted out, blocked, without the date or without a value for a mapped
   variable, **When** the automation runs, **Then** they are skipped and counted by reason; marketing
   templates also need the contact to be opted in, as for campaigns.
4. **Given** an automation whose template is paused or rejected by Meta, or whose number is
   disconnected, **When** it is due, **Then** it pauses itself and admins are told.
5. **Given** a running automation, **When** a manager opens it, **Then** results per day show sent,
   delivered, read, replied, failed and skipped, and each recipient can be listed.

---

### User Story 6 - Two-factor authentication for team logins (Priority: P2)

A member turns on 2FA: they scan a code with an authenticator app, type a six-digit code to confirm,
and save ten recovery codes. From then on, signing in asks for the app code after the password. The
admin requires 2FA for everyone; members without it must set it up at their next sign-in. A member
who lost their phone signs in with a recovery code, and an admin can reset a member's 2FA.

**Why this priority**: the platform holds customer data and can message thousands of people; a
stolen password alone should not be enough. It is independent of the other stories.

**Independent Test**: set up 2FA, sign in with an app code, a wrong code and a recovery code; require
2FA for everyone and sign in as a member without it; reset a member's 2FA as admin.

**Acceptance Scenarios**:

1. **Given** a member with 2FA, **When** they sign in, **Then** after the right password they must
   enter a valid app code or an unused recovery code before any page or data is available.
2. **Given** wrong codes, **When** five are entered in a row, **Then** sign-in for that member is
   locked for 15 minutes, and the attempts are audited.
3. **Given** "require 2FA for everyone" is on, **When** a member without 2FA signs in, **Then** they
   can only set up 2FA before using the platform.
4. **Given** a member who lost their phone, **When** an admin resets their 2FA, **Then** the member
   sets it up again at the next sign-in, and the reset is audited; an admin cannot reset their own.
5. **Given** API keys used by other systems, **When** 2FA is turned on or required, **Then** the keys
   keep working; 2FA only applies to people signing in.

---

### User Story 7 - The WhatsApp Business profile, display name status and the blue tick checklist (Priority: P3)

An admin opens a number and edits its business profile: the profile picture, about text,
description, address, email, category and up to two websites. The changes are sent to Meta and the
page shows what Meta now holds. The same page shows the display name and its status, the quality
rating and messaging limit, and a checklist that guides the company through applying for the blue
tick.

**Why this priority**: useful and visible to customers, but rarely changed after setup.

**Independent Test**: edit each profile field on a connected number and read it back from Meta;
send a picture that is too large; check the display name status shown for approved, pending and
declined names; tick the checklist steps.

**Acceptance Scenarios**:

1. **Given** a connected number, **When** an admin saves profile changes, **Then** they are sent to
   Meta and the page shows the values Meta returns; refused values show Meta's reason next to the
   field.
2. **Given** a profile picture that is not a square image of at least 192×192 pixels or is over
   5 MB, **When** it is chosen, **Then** it is refused before sending, with the rule shown.
3. **Given** a number whose display name is pending or declined, **When** an admin opens it,
   **Then** the status and, for declined names, Meta's reason and the steps to request again in
   Meta's tools are shown.
4. **Given** the blue tick checklist, **When** an admin works through it, **Then** each step shows
   what is needed (business verification, an approved display name, two-step verification on the
   number, public articles about the business) with links to Meta's pages, and the admin can mark
   steps done and record the application date and result.

---

### User Story 8 - Guides for moving a number in and out (Priority: P3)

An admin whose number is with another WhatsApp provider follows a step-by-step guide to move it to
this platform, and a guide explains how to move a number back to the WhatsApp Business app if the
company ever stops using the platform.

**Why this priority**: needed once or twice in the company's life, but mistakes can lose the number
for days.

**Independent Test**: open both guides from the numbers page; check that each step, warning and
link is present.

**Acceptance Scenarios**:

1. **Given** the numbers page, **When** an admin opens "Move a number here", **Then** a guide lists
   the steps in order (what to ask the old provider, turning off the number's two-step PIN, keeping
   the same WhatsApp account or not, what moves and what does not), with warnings and links to
   Meta's documentation.
2. **Given** a connected number, **When** an admin opens "Move back to the WhatsApp Business app",
   **Then** a guide explains the steps, what is lost (templates, chat history in the platform) and
   that the number is first removed from the platform, which asks for a typed confirmation.

---

### Edge Cases

- **Segments:**
  - A segment with no rules is refused; a segment can hold up to 30 rules in up to 5 groups.
  - A behaviour rule naming a campaign that was deleted by retention shows as broken.
  - Counts are worked out when asked and are a few seconds old at most; a campaign uses the members
    at its launch, not at its creation.
  - A segment that matches no one can be saved but a campaign to it cannot launch.
- **Bulk tags:** "all matching" applies to the contacts that match when the action runs; an action
  on more than 100,000 contacts runs in the background with progress, and two bulk actions on the
  same contacts run one after the other.
- **Automatic tags:** a rule that names a deleted tag creates it again only if an admin confirms;
  rules never remove tags.
- **Lead source:** contacts that existed before this feature keep their current value; empty values
  show "unknown". Merged or updated contacts keep the first source.
- **Export:** an export of more than 100,000 rows is still streamed; deleted contacts are never in
  it; attribute columns follow the attribute definitions at export time.
- **Global attributes:** names are unique, use letters, digits and underscores, and are separate from
  contact attribute names; a value longer than 1,024 characters is refused; an empty value used by a
  flow or an AI reply is left out and logged rather than sent as a blank.
- **Keyword replies:** a keyword reply never goes to a blocked contact, never counts as a marketing
  message, and is not sent when the number is stopped; a template reply whose template was
  rejected falls back to no reply, and admins are told.
- **Date automations:**
  - 29 February dates are due on 28 February in years without it.
  - A contact whose date changes after today's run is due on the new date next time; a contact added
    after the send time is first due at the next occurrence.
  - A one-time date in the past is never sent.
  - A run that could not finish (number limits, outage) continues the same day; occurrences not sent
    by the end of the day are skipped as "too late", never sent the next day.
- **2FA:**
  - Codes from the app are accepted within one 30-second step either side of the server time.
  - A recovery code works once; when the last one is used the member is asked to make new ones.
  - The only admin who lost both phone and recovery codes is reset by the server operator with a
    documented command, which is audited.
- **Business profile:** edits are only possible while the number is connected; fields Meta does not
  accept for the number's category are shown as Meta's error; the profile picture is stored by Meta,
  not by the platform.

## Requirements *(mandatory)*

### Functional Requirements

**Segments (US1)**

- **FR-001**: Managers MUST be able to create, rename, copy and delete segments made of rule groups
  ("all of" or "any of"), combined with "all of" at the top, using: tags (has, has not), attributes
  (by type, as in campaigns today), consent status, lead source, date added, last message from the
  contact, blocked or not, and behaviour rules.
- **FR-002**: Behaviour rules MUST cover sent, delivered, read, replied (005 definition), clicked a
  tracked link (005), failed, and "did not" versions of each, for one chosen campaign or for any
  campaign in the last 7, 30 or 90 days.
- **FR-003**: The segment editor MUST show the number of matching contacts and the number that can
  receive marketing messages, updated as rules change, and a sample of up to 20 matching contacts
  with phones masked by role.
- **FR-004**: Campaigns MUST accept a segment as their audience; the estimate and recipients MUST be
  the segment's members at launch, with the existing consent, block and duplicate rules applied.
- **FR-005**: Drips MUST allow enrolling the current members of a segment once, with the counts of
  enrolled and skipped contacts and the reasons.
- **FR-006**: A segment whose rule refers to a deleted tag, attribute or campaign MUST show the
  broken rule, and campaigns or enrolments using it MUST be refused until it is fixed.
- **FR-007**: The contact list MUST filter by a saved segment for every role that can see contacts.

**Bulk tags, automatic tags, lead source and export (US2)**

- **FR-008**: Members who manage contacts MUST be able to add and remove one or more tags on selected
  contacts or on all contacts matching the current filter or segment, with a confirmation that shows
  the number of contacts, a result with the number changed, and an audit entry.
- **FR-009**: Bulk actions on more than 100,000 contacts MUST run in the background with visible
  progress, and MUST finish even if the member leaves the page.
- **FR-010**: Admins MUST be able to set automatic tag rules: when a contact is created with a given
  lead source, replies to a campaign, clicks a campaign link, opts in, or opts out, add a chosen tag.
  Rules MUST apply only to events after they are saved.
- **FR-011**: Every new contact MUST get a lead source when it is created: organic (they wrote
  first), API, import (with the import's label), campaign upload, chat link, ad, lead form, WhatsApp
  Form, website button, store, or a custom label given on import or through the API. The lead
  source MUST NOT change later.
- **FR-012**: The contact list and profile MUST show the lead source, and the list MUST filter by it.
- **FR-013**: Members with the export permission MUST be able to download contacts as CSV for the
  current filter, a segment or everyone: name, phone, tags, each attribute, consent status, source and
  date, lead source, date added and last message date. The download MUST be streamed, MUST mask
  phones for roles that see masked phones, and MUST be audited with the row count.

**Global attributes (US3)**

- **FR-014**: Admins MUST be able to create, edit and delete global attributes with a name, a
  description and a value (text up to 1,024 characters).
- **FR-015**: Global attributes MUST be usable as a source for campaign template variables, in live
  chat replies and saved replies, in flow messages and in AI agent instructions, using the value in
  force when the message is made.
- **FR-016**: A campaign MUST NOT launch while a mapped global attribute is empty; deleting a global
  attribute MUST be refused while campaigns, saved replies, flows or agents use it, listing them.

**Keyword replies (US4)**

- **FR-017**: Admins MUST be able to set one reply for opt-out keywords and one for opt-in keywords,
  each either a text (up to 1,024 characters) or an approved utility template, or no reply.
- **FR-018**: After applying the consent change, the platform MUST send the matching reply once from
  the number the person wrote to, at most once per person and kind in 24 hours, never to a blocked
  contact and never while the number is stopped.
- **FR-019**: The keyword lists MUST hold up to 20 keywords each and a keyword MUST NOT be in both.

**Date automations (US5)**

- **FR-020**: Managers MUST be able to create date automations with: a name, a date attribute, a
  timing (every year on the day and month, or once on the exact date), an offset of 0 to 30 days
  before or after, a send time in the company time zone, a number, an approved template with its
  variables mapped (contact fields, attributes, global attributes or fixed values), and an on or off
  switch.
- **FR-021**: Each due contact MUST get at most one message per occurrence; opted-out, blocked and
  invalid contacts, contacts without the date or a mapped value, and (for marketing templates)
  contacts not opted in MUST be skipped and counted by reason.
- **FR-022**: Messages due on a day MUST start at the send time and MUST NOT be sent on a later day;
  29 February dates MUST be due on 28 February in other years.
- **FR-023**: An automation MUST pause itself and notify admins when its template is paused, disabled
  or rejected, or its number is disconnected; resuming MUST NOT send occurrences of past days.
- **FR-024**: The automation page MUST show per day: due, sent, delivered, read, replied, failed and
  skipped by reason, and list the recipients of a day.

**Two-factor authentication (US6)**

- **FR-025**: Every member MUST be able to turn on 2FA with an authenticator app (scan a code or type a
  key, then confirm with a valid code) and MUST receive 10 one-time recovery codes, shown once, that
  can be made again later (replacing the old ones).
- **FR-026**: For a member with 2FA, sign-in MUST require a valid app code or an unused recovery code
  after the password; no session MUST exist before the second step succeeds.
- **FR-027**: Five wrong second-step codes in a row MUST lock that member's sign-in for 15 minutes.
- **FR-028**: Admins MUST be able to require 2FA for everyone; members without it MUST then set it up
  at sign-in before anything else.
- **FR-029**: Admins MUST be able to reset another member's 2FA; members MUST be able to turn off
  their own 2FA (asking for a current code) unless it is required.
- **FR-030**: 2FA MUST NOT affect API keys. Setting up, turning off, resetting, recovery code use,
  failed codes and lockouts MUST be audited; the app secret MUST be stored encrypted and recovery
  codes MUST be stored only in a form that cannot be read back.

**Business profile, display name and blue tick (US7)**

- **FR-031**: Admins MUST be able to edit a connected number's business profile (profile picture,
  about text, description, address, email, category and up to two websites) within Meta's limits;
  changes MUST be sent to Meta and the page MUST show the values Meta returns.
- **FR-032**: The number page MUST show the display name and its status (approved, pending,
  declined, with Meta's reason when given), the quality rating and the messaging limit, refreshed
  from Meta.
- **FR-033**: The platform MUST offer a blue tick checklist with each requirement explained in our own
  words and linked to Meta's pages; admins MUST be able to mark steps done and record the application
  date and Meta's answer.

**Guides (US8)**

- **FR-034**: The numbers page MUST offer two guides in our own words: moving a number here from
  another provider, and moving a number back to the WhatsApp Business app, each with ordered steps,
  warnings and links to Meta's documentation, and the date the guide was last checked.

**Cross-cutting**

- **FR-035**: Roles: managers and admins manage segments and date automations; members who manage
  contacts use bulk tags; admins manage automatic tag rules, global attributes, keyword replies,
  the 2FA requirement, the business profile and the blue tick checklist; exports need the export
  permission; agents can use segments as filters and insert global attributes in replies.
- **FR-036**: New audit actions MUST cover segments, bulk tag actions, automatic tag rules, global
  attributes, keyword replies, date automations, 2FA events, business profile changes and the blue
  tick checklist.
- **FR-037**: Contact erasure (001) MUST also remove the contact from date automation history and
  bulk action records, and exports MUST never include erased contacts.

### Key Entities

- **Segment**: name, description, rule groups, who made it and when; used by campaigns and drip
  enrolments; members are worked out when used.
- **Bulk tag action**: who, the tags added and removed, how contacts were chosen (selection, filter or
  segment), counts, status and progress.
- **Automatic tag rule**: the event (lead source, campaign reply, link click, opt-in, opt-out), the
  tag, on or off.
- **Lead source** (on the contact): the kind and a label, set at creation.
- **Global attribute**: a unique name, a description, a value, who changed it last and when.
- **Keyword reply setting**: for opt-in and for opt-out, the kind (none, text, template), the text or
  template, and its variables.
- **Date automation**: name, date attribute, timing, offset, send time, number, template and mapping,
  status, and its daily results.
- **Date automation occurrence**: one contact and one due date, with what happened (sent, skipped and
  why, failed) and the message sent.
- **Two-factor setup** (per member): the encrypted app secret, when it was turned on, recovery codes
  (unreadable form, used or not), failed attempts and lockout time; plus the company's "require
  2FA" setting.
- **Business profile** (per number): the fields as Meta returns them, when they were last read and
  changed.
- **Blue tick checklist**: each step's state, the application date and Meta's answer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The count of a segment with up to 10 rules over 200,000 contacts appears within 3
  seconds, and matches the contacts that fit the rules in every acceptance test.
- **SC-002**: Adding or removing a tag on 50,000 contacts finishes within 1 minute; on 500,000
  within 10 minutes, with progress shown.
- **SC-003**: An export of 100,000 contacts starts downloading within 5 seconds and finishes within 2
  minutes, with the same count as the screen.
- **SC-004**: 99% of date automation messages for a day are handed to Meta within 15 minutes of the
  send time (within the number's sending limits), and no contact ever gets two messages for one
  occurrence.
- **SC-005**: Keyword replies arrive within 10 seconds of the keyword message in 95% of cases.
- **SC-006**: In testing, no sign-in of a member with 2FA succeeds without a valid second step, and
  every 2FA event is in the audit log.
- **SC-007**: A changed global attribute is used by every message made after the change, with no
  message using the old value more than 1 minute after it.
- **SC-008**: Business profile changes are shown as Meta returns them within 1 minute of saving, and
  every refused change shows a reason the admin can act on.

## Assumptions

- The company time zone (001 settings) is used for send times and "per day" results.
- Attribute types and rules are those of 001; date automations use date attributes only.
- Keyword replies use the 24-hour window opened by the person's keyword message, so a text reply is
  allowed; template replies use utility templates, never marketing or one-time code templates.
- The keyword lists keep their current limit of 20 keywords each (AiSensy documents 5), so existing
  settings stay valid.
- Lead sources of contacts created before this feature are kept as they are; no back-filling is
  attempted beyond values that already exist.
- Authenticator apps use the common time-based six-digit codes (30-second steps), which every major
  authenticator app supports.
- Meta exposes the business profile, display name status, quality rating and messaging limit for
  numbers on the company's WhatsApp account; the blue tick decision and display name changes stay
  with Meta.
- Segments and exports respect existing retention (campaign data older than 12 months is gone, so
  behaviour rules look back at most 90 days or at a campaign that still exists).

## Out of Scope

- Single sign-on, passkeys, and codes by SMS or email; "remember this device" for 2FA.
- Automatic drip enrolment when a contact enters a segment later (segments enrol their current
  members once).
- Changing the display name itself or applying for the blue tick from inside the platform (Meta's
  tools do this; the platform guides).
- Moving numbers automatically between providers; the guides are instructions only.
- Mobile apps (a separate feature).

## Dependencies

- **001:** contacts, tags, attributes, consent, opt-in/opt-out keywords, imports, campaigns and their
  audiences, templates, roles, audit and retention.
- **002:** live chat replies and saved replies, the contact profile and the lead source field.
- **003:** flow messages and their placeholders.
- **004:** AI agent instructions.
- **005:** the replied definition, tracked link clicks and drips.
- **006–009:** the entry points that set lead sources (API, chat links, stores, ads and lead forms,
  WhatsApp Forms, the website button) and the number connection details.
