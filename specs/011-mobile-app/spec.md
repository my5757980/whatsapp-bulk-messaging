# Feature Specification: Installable Mobile App for the Team

**Feature Branch**: `011-mobile-app`
**Created**: 2026-11-28
**Status**: Draft
**Input**: User description: "Installable mobile app for the team (inventory item 12.4, "installable web app with push first"): members install the platform on Android and iOS home screens and work on the go - live chat optimized for phones (chat list, a chat with the composer, saved replies, templates, media, notes, take over/resolve/transfer), push notifications for new chats, messages, chats waiting for an agent and assignments (the 002 Web Push, also on iOS home screen apps), an app shell that opens fast and shows a clear offline state, quick views of campaigns, drips, ads and AI agents with their key results, starting a broadcast from a template, contacts lookup with call and WhatsApp actions, and the device's contacts optionally imported as contacts with consent. Same accounts, roles, 2FA and permissions as the web app; no separate backend."

**Context**: Features 001–010 are built. This feature covers inventory row 12.4 ("Android and iOS
apps") of `docs/research/aisensy/feature-inventory-2026-11-19.md`, as an installable app built on the
existing platform rather than separate store apps. Some parts exist already and are extended rather
than rebuilt:
- Live chat (002) has the chat list, chats, saved replies, templates, media, notes, take over,
  resolve and transfer, with live updates. Its screens are built for desktop widths.
- Browser alerts (002) already push new-message and waiting-for-agent alerts to up to 5 devices per
  member, with sound and per-device pause. They work in desktop and Android browsers; iOS only
  delivers them to apps added to the home screen.
- Accounts, roles, two-factor sign-in (010), segments (010), campaigns (001, 005, 009), drips (005),
  ads (007) and AI agents (004) all exist; this feature adds phone-sized ways to use them.

## Concepts used in this spec

- **The app**: the platform installed on a phone's home screen. It opens full screen, has its own
  icon and name, and uses the same accounts and data as the web app on a computer.
- **App shell**: the frame of the app (navigation, headers, empty states) that opens straight away
  from the phone, before fresh data arrives.
- **Offline state**: what the app shows when the phone has no connection: a clear banner, the last
  loaded lists and messages to read, and no sending until the connection is back.
- **Alert**: a push notification on the phone about a chat event, which opens the right chat when
  tapped.
- **Phone contacts**: the people saved in the phone's own address book, which a member may pick and
  import as platform contacts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install the app and sign in (Priority: P1)

A member opens the platform on their phone and installs it to the home screen. On Android the app
offers an *Install app* button; on iPhone it shows the two steps to add it from the Share menu. The
installed app opens full screen with the company's app name and icon, signs in with the same email,
password and two-factor code as on a computer, and lands on live chat.

**Why this priority**: Every other story needs the app on the phone and a signed-in member.

**Independent Test**: On an Android phone and an iPhone, install the app, sign in (with and without
two-factor sign-in), close it, and open it again from the home screen.

**Acceptance Scenarios**:

1. **Given** a member opens the platform in a supported phone browser, **When** the browser allows
   installing, **Then** an *Install app* action is offered and installing puts the app on the home
   screen with its name and icon.
2. **Given** an iPhone, **When** the member opens the install help, **Then** it shows how to add the
   app from the Share menu, and once added the app opens full screen without browser bars.
3. **Given** a member with two-factor sign-in, **When** they sign in from the app, **Then** the code
   step appears exactly as on the web, and a password alone never opens the app.
4. **Given** a signed-in member, **When** they reopen the app later within their session, **Then**
   it opens on live chat without signing in again; after the session ends it asks to sign in.
5. **Given** a new version of the platform is released, **When** a member next opens the app,
   **Then** they get the new version without reinstalling, and are told it was updated.

---

### User Story 2 - Live chat on the phone (Priority: P1)

An agent away from the desk answers customers from the phone. The chat list shows the same tabs,
counts and filters as on a computer, sized for one hand. Opening a chat shows the conversation, the
reply window countdown and a composer with saved replies, templates, files from the camera, gallery
or media library, and internal notes. The agent can take over, resolve and transfer the chat, and
sees the contact's profile in a sheet instead of a side panel.

**Why this priority**: Answering customers on the go is the main reason to install the app.

**Independent Test**: On a 360-pixel-wide phone screen, receive a customer message, reply with text,
a saved reply, a photo from the camera and a template after the window closes, add a note, take
over, transfer and resolve the chat, and check the same chat on a computer.

**Acceptance Scenarios**:

1. **Given** chats waiting in the member's tabs, **When** they open the app, **Then** the chat list
   shows each chat's contact (masked for roles that see masked phones), last message, time, unread
   count and state, with the same tabs and filters as the web.
2. **Given** an open chat, **When** a customer writes, **Then** the message appears within the
   live-update time of the web app without refreshing.
3. **Given** the reply window is open, **When** the member sends text, a saved reply ("/" or a
   button), a photo taken with the camera, a picture from the gallery or a library file, **Then**
   each is sent with the same checks and limits as on the web.
4. **Given** the reply window has closed, **When** the member opens the composer, **Then** only
   sending an approved template is offered, as on the web.
5. **Given** a chat, **When** the member takes over, transfers to a colleague or resolves it, **Then**
   the change follows the live chat rules of feature 002 and shows on every member's screen.
6. **Given** an agent with chat visibility rules, **When** they use the app, **Then** they see only
   the chats they may see on the web.
7. **Given** a long conversation, **When** the member scrolls up, **Then** older messages load as on
   the web, and the composer stays usable with the phone keyboard open.

---

### User Story 3 - Alerts on the phone (Priority: P1)

The member turns on alerts in the app. When a new chat arrives, a customer writes in one of the
member's chats, a chat starts waiting for an agent, or a chat is assigned or transferred to them,
the phone shows an alert even if the app is closed. Tapping it opens that chat. The member chooses
which kinds of alerts they get and whether alerts show the message text.

**Why this priority**: Without alerts, members have to keep the app open to notice customers.

**Independent Test**: With the app closed on an Android phone and on an iPhone with the app on the
home screen, trigger each alert kind, tap the alert and land in the chat; turn one kind off and
check it stops.

**Acceptance Scenarios**:

1. **Given** alerts are allowed on the phone, **When** each alert kind happens for the member,
   **Then** one alert appears within the target time and tapping it opens that chat in the app.
2. **Given** an iPhone, **When** the member tries to turn on alerts in the browser without adding
   the app to the home screen, **Then** the app explains that iPhone alerts need the app on the home
   screen and how to add it.
3. **Given** the member turned off an alert kind, **When** that event happens, **Then** no alert is
   sent to any of their devices for it; the other kinds still arrive.
4. **Given** *Hide message text* is on, **When** an alert arrives, **Then** it names the contact
   (or the masked phone) and the event, without the message text.
5. **Given** several messages arrive in the same chat, **When** alerts are shown, **Then** the newer
   alert replaces the older one for that chat instead of stacking.
6. **Given** a member already has 5 devices, **When** they turn on alerts on a sixth, **Then** they
   are asked to remove one first, as in feature 002.

---

### User Story 4 - Fast start and a clear offline state (Priority: P2)

The member opens the app on a slow or missing connection. The app frame appears at once with the
last loaded chat list. Without a connection, a banner says the phone is offline, sending is paused,
and drafts are kept; when the connection returns, the app refreshes by itself.

**Why this priority**: Phones lose connection often; a blank screen or lost reply makes the app
untrustworthy.

**Independent Test**: Open the app, load chats, switch the phone to airplane mode, browse the cached
chats, type a draft, switch the connection back and send it.

**Acceptance Scenarios**:

1. **Given** the app was used before, **When** it is opened, **Then** the app frame and the last
   loaded chat list appear before fresh data arrives, and fresh data replaces them when it comes.
2. **Given** the phone goes offline, **When** the member uses the app, **Then** an offline banner
   shows, the last loaded chats and messages can be read, and send buttons are disabled with a short
   reason.
3. **Given** a draft typed while offline, **When** the connection returns, **Then** the draft is
   still there, nothing was sent twice, and the chat list and open chat refresh without a reload.
4. **Given** the member signs out, **When** the app is opened by someone else on the phone, **Then**
   no chat content from the previous session is shown.

---

### User Story 5 - Quick views of campaigns, drips, ads and AI agents (Priority: P2)

A manager checks how the business is doing from the phone: today's and the last 7 days' key results
for campaigns, drips, ads and AI agents, each in a compact card, with a link to the full page on the
web. Where their role allows, they can pause or resume a running campaign, drip, ad campaign or AI
agent.

**Why this priority**: Managers want to keep an eye on results and stop a mistake quickly, even when
away from a computer.

**Independent Test**: As a manager, open each quick view and compare its numbers with the web pages;
pause and resume a campaign from the phone; check an agent sees only what their role allows.

**Acceptance Scenarios**:

1. **Given** running and finished campaigns, **When** the manager opens *Campaigns*, **Then** each
   shows its state and sent, delivered, read, replied and failed counts matching the web.
2. **Given** drips, ad campaigns and AI agents, **When** their quick views open, **Then** they show
   the key results of the web pages (drips: in it now, finished, left; ads: spend against the cap,
   chats and leads; AI agents: conversations, answered and handed over) for today and the last 7
   days.
3. **Given** a member allowed to pause, **When** they pause or resume an item from the phone,
   **Then** it follows the same rules and confirmations as on the web, and the audit log records it.
4. **Given** a member without the permission, **When** they open a quick view, **Then** pause and
   resume are not offered, and views they may not see are not listed.

---

### User Story 6 - Start a broadcast from a template (Priority: P2)

A manager sends an announcement from the phone: they choose an approved template, an audience (a
saved segment, a tag, or all opted-in contacts), fill the template's variables, see the estimate
with exclusions and cost, and send now or schedule.

**Why this priority**: Time-sensitive messages (a closed shop, a flash offer) cannot always wait
for a computer.

**Independent Test**: From the phone, create and send a campaign to a segment with one variable
mapped to the contact name and one fixed; check it on the web and in the results.

**Acceptance Scenarios**:

1. **Given** approved templates and a connected number, **When** the manager starts *New broadcast*,
   **Then** they can choose the number, the template, the audience and the variables on phone-sized
   steps.
2. **Given** a complete draft, **When** they review it, **Then** the estimate shows recipients,
   exclusions (opted out, no opt-in for marketing, invalid) and the estimated cost, as on the web.
3. **Given** they confirm, **When** the broadcast launches or is scheduled, **Then** the same launch
   checks, limits and audit entries as on the web apply.
4. **Given** a template needs something the phone steps do not offer (for example an uploaded list
   or carousel cards), **When** it is chosen, **Then** the app says to finish it on a computer and
   keeps the draft for the web.

---

### User Story 7 - Contacts on the go, and importing phone contacts (Priority: P3)

A member finds a contact by name or phone, sees their profile (tags, attributes, consent, lead
source, recent chats), calls them, or opens their chat in the app (or sends a template when the
window is closed). They can also pick people from the phone's address book and add them as contacts,
confirming whether each person agreed to receive WhatsApp messages.

**Why this priority**: Useful for sales staff in the field, but the core work happens in live chat.

**Independent Test**: Search a contact, call them, open their chat; on an Android phone pick three
phone contacts and import them with and without consent confirmation; on a phone without picking,
import a contact card file instead.

**Acceptance Scenarios**:

1. **Given** contacts exist, **When** the member searches by name or phone, **Then** matching
   contacts appear with masked phones for roles that see masked phones.
2. **Given** a contact profile, **When** the member taps *Call*, **Then** the phone's dialler opens
   with the number (only for roles that see full phones); **When** they tap *Chat*, **Then** the
   contact's chat opens, or the template step if the window is closed.
3. **Given** a phone that lets the browser pick address-book contacts, **When** the member picks
   people, **Then** each mobile number is checked and shown with the name before importing, and
   existing contacts are matched, not duplicated.
4. **Given** the member confirms the picked people agreed to receive messages, **When** the import
   finishes, **Then** they are opted in with that confirmation recorded; otherwise their consent
   stays unknown and marketing is not sent to them.
5. **Given** a phone that cannot pick contacts, **When** the member opens the import, **Then** they
   can choose a contact card file (vCard) exported from the phone instead, with the same checks.

---

### Edge Cases

- A member installs the app on a phone browser that cannot be installed: the platform still works in
  the browser, and the install action is hidden.
- The phone's alert permission is denied: the alerts page explains how to allow it in the phone's
  settings; nothing else breaks.
- The member signs in on a new phone while 5 devices already receive alerts: they choose a device to
  remove (feature 002 rule).
- An alert arrives for a chat the member may no longer see (transferred away, visibility rules
  changed): tapping it opens live chat with a message that the chat is not available.
- The session expires while the app is in the background: the next action asks the member to sign
  in, and the draft in the open chat is kept on the phone until they return.
- Two-factor sign-in becomes required while the member is signed in on the phone: they keep the
  session and see the reminder, as on the web (feature 010).
- A photo from the camera is larger than WhatsApp's limit: the app refuses it before uploading, with
  the limit in the message (feature 002 limits).
- The connection drops while a message is being sent: the message shows as not sent with a retry
  action, and is never sent twice.
- A picked phone contact has several numbers: each valid mobile number can become its own contact;
  landlines and invalid numbers are listed as skipped.
- A picked phone contact already exists: the existing contact is kept, and its consent is never
  lowered by an import.
- The app is updated while a member is typing: the update waits until the app is next opened, and
  the draft is kept.
- The phone is shared: signing out removes cached chats and alerts for that member from the phone.

## Requirements *(mandatory)*

### Functional Requirements

**Installing and signing in**

- **FR-001**: The platform MUST be installable to the home screen of current Android phones and
  iPhones from their main browsers, with the company's app name, an icon and a full-screen window.
- **FR-002**: The platform MUST offer an *Install app* action where the browser allows installing,
  and step-by-step install help where it does not (iPhone).
- **FR-003**: The app MUST use the same accounts, sessions, roles, permissions and two-factor sign-in
  as the web app; no new kind of account or login is introduced.
- **FR-004**: The app MUST open on live chat for members who may use it, and on the first page their
  role allows otherwise.
- **FR-005**: A new platform version MUST reach installed apps without reinstalling, at the latest
  the next time the app is opened, without losing drafts.

**Live chat on phones**

- **FR-006**: Every live chat action of feature 002 that members use daily MUST work on screens
  360 pixels wide without sideways scrolling: the chat list with its tabs, counts and filters; a chat
  with its history, reply window countdown and composer; saved replies; templates; files from the
  camera, gallery or media library; notes; take over, resolve and transfer; the contact profile.
- **FR-007**: The phone screens MUST apply the same rules as the web: chat visibility for agents,
  masked phones by role, the 24-hour reply window, file types and limits, and the audit entries.
- **FR-008**: The chat list and open chats MUST update live while the app is open, within the same
  time as the web app.
- **FR-009**: Tap targets MUST be at least 44 by 44 points, and the composer MUST stay visible above
  the phone keyboard.

**Alerts**

- **FR-010**: Members MUST be able to turn alerts on for the phone they are using, and see and remove
  the devices that receive their alerts (at most 5, as in feature 002).
- **FR-011**: The platform MUST send alerts for: a new chat the member may see, a new customer
  message in a chat the member has taken or is assigned to, a chat starting to wait for an agent, and
  a chat assigned or transferred to the member.
- **FR-012**: Members MUST be able to choose which of these alert kinds they receive, and to hide
  the message text in alerts.
- **FR-013**: Tapping an alert MUST open the app (or bring it to the front) on that chat.
- **FR-014**: A newer alert for the same chat MUST replace the older one on the phone.
- **FR-015**: On iPhones, the app MUST explain that alerts need the app on the home screen, and offer
  turning alerts on only from the installed app.
- **FR-016**: Alerts MUST never include more than the contact's name or masked phone, the event and,
  unless hidden, the first 100 characters of the message; never full phone numbers for roles that see
  masked phones, and never secrets or codes.

**Fast start and offline**

- **FR-017**: After the first use, the app frame MUST open from the phone before network data
  arrives, showing the last loaded chat list until fresh data replaces it.
- **FR-018**: Without a connection, the app MUST show an offline banner, keep the last loaded chats
  and messages readable, disable sending with a reason, and keep drafts.
- **FR-019**: When the connection returns, the app MUST refresh what is on screen by itself, and a
  message MUST never be sent twice because of a dropped connection.
- **FR-020**: Signing out MUST remove the member's cached chats, drafts and alert subscription for
  that phone.

**Quick views**

- **FR-021**: The app MUST show compact quick views of campaigns, drips, ad campaigns and AI agents
  with the key results of their web pages, for today and the last 7 days, each linking to the full
  web page.
- **FR-022**: Members allowed to pause or resume (the same permissions as on the web) MUST be able
  to pause and resume a running campaign, drip, ad campaign or AI agent from its quick view, with the
  same confirmation and audit entry.
- **FR-023**: Quick views MUST list only what the member's role may see.

**Broadcast from a template**

- **FR-024**: Members allowed to create and launch campaigns MUST be able to create a broadcast on
  the phone: number, approved template, audience (a saved segment, a tag, or all opted-in contacts),
  variables (contact field, attribute, global attribute or fixed text, with fallbacks), estimate, and
  send now or schedule.
- **FR-025**: The phone broadcast MUST use the same launch checks, estimate, exclusions, limits and
  audit entries as the web campaign wizard.
- **FR-026**: Templates or audiences that need steps the phone does not offer MUST be saved as a
  draft with a note to finish on a computer.

**Contacts**

- **FR-027**: Members MUST be able to search contacts by name or phone and open a contact profile
  (tags, attributes, consent, lead source, recent chats) on the phone.
- **FR-028**: The contact profile MUST offer *Call* (opening the phone's dialler, only for roles that
  see full phones) and *Chat* (opening the contact's chat, or the template step when the window is
  closed).
- **FR-029**: Where the phone lets the browser pick address-book contacts, members allowed to manage
  contacts MUST be able to pick people and import them; elsewhere they MUST be able to import a
  contact card file (vCard).
- **FR-030**: Imported phone contacts MUST be checked like other imports (valid mobile numbers in
  the company's default country rules, duplicates matched to existing contacts), get the lead source
  *Import* with the label "Phone contacts", and be opted in only when the member confirms the people
  agreed to receive WhatsApp messages, with that confirmation and the member recorded; otherwise
  their consent stays unknown.
- **FR-031**: An import MUST never lower the consent of an existing contact, and the platform MUST
  read only the names and phone numbers the member picked, nothing else from the address book.
- **FR-032**: Phone contact imports MUST be audited with the number imported, matched and skipped,
  never with the people's details.

### Key Entities

- **Alert device**: a phone or browser that receives a member's alerts (feature 002), now with the
  kind of device (installed app or browser) and the alert kinds the member chose. At most 5 per
  member.
- **Alert preferences**: per member, which alert kinds they receive (new chats, messages in their
  chats, waiting for an agent, assigned or transferred to them) and whether alerts hide the message
  text.
- **Phone contact import**: one import of picked phone contacts or a contact card file by a member,
  with counts of imported, matched and skipped people and whether consent was confirmed; the created
  contacts carry the lead source *Import* with the label "Phone contacts".
- **Broadcast draft from the phone**: an ordinary campaign draft (feature 001) created on the phone,
  marked so the web can show it was started there.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can install the app and reach live chat on a current Android phone and iPhone
  in under 2 minutes, including sign-in with two-factor sign-in.
- **SC-002**: After the first use, the app frame and the last loaded chat list appear within
  2 seconds of tapping the icon on a mid-range phone, even on a slow connection (3G speed) or none.
- **SC-003**: 95% of alerts reach the member's phone within 10 seconds of the event while the phone
  is online.
- **SC-004**: From an alert, a member can open the chat and send a saved reply in under 15 seconds.
- **SC-005**: Every daily live chat action of FR-006 can be completed on a 360-pixel-wide screen
  without sideways scrolling or zooming.
- **SC-006**: When the connection drops and returns, no message is lost or sent twice, and the
  screen is current again within 5 seconds of the connection returning.
- **SC-007**: A manager can create and launch a broadcast to a saved segment from the phone in under
  2 minutes.
- **SC-008**: Importing 200 picked phone contacts takes under 30 seconds, with every skipped number
  listed with its reason.
- **SC-009**: The quick views show the same numbers as the matching web pages at the time they are
  opened.

## Assumptions

- "Installable web app first" means the platform itself becomes installable; Play Store and App
  Store apps are a later step if ever needed.
- iPhones deliver alerts only to apps added to the home screen (iOS 16.4 or later); this is an Apple
  rule the app explains rather than works around.
- Picking address-book contacts is only possible in browsers that offer it (today mainly Chrome on
  Android); other phones use a contact card (vCard) file exported from the phone's Contacts app.
- Sessions follow the existing rules (7 days at most, 12 hours idle); the app does not add a
  "remember me" that would weaken them.
- Offline means reading what was already loaded; composing works, but sending, actions and new data
  wait for the connection. No messages are queued to send later without the member.
- The app keeps the web app's design system and wording style, sized for phones; it is not a copy
  of any other product's screens.
- Who sees full phone numbers follows the existing role permission for full numbers; *Call* is hidden
  for roles that see masked phones.
- Heavy editors (the flow builder, AI agent setup, template creation, ad creation, website button
  design and reports) stay computer-first; the app links to them instead of reshaping them.

## Out of Scope

- Separate native apps in the Play Store or App Store, and native features they would bring (home
  screen widgets, background contact sync, call logs).
- Sending messages or running actions while offline, and syncing them later.
- Phone-sized versions of the flow builder, AI agent setup, template editor, ad creation, website
  button designer and reports.
- Voice or video calls through WhatsApp, and recording calls.
- Reading anything from the phone's address book except the people a member picks.

## Dependencies

- Feature 002 (live chat, browser alerts, devices and preferences), feature 001 (campaigns,
  templates, contacts, roles), feature 005 (drips), feature 007 (ads), feature 004 (AI agents),
  feature 009 (template kinds and their phone limits) and feature 010 (segments, global attributes,
  lead sources and two-factor sign-in).
- A secure public address (HTTPS) for the platform, which installing and alerts require; the same
  address the web app already uses in production.
