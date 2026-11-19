# Feature Specification: WhatsApp Bulk Messaging Core

**Feature Branch**: `001-whatsapp-bulk-messaging`
**Created**: 2026-11-16
**Status**: Draft
**Input**: User description: "WhatsApp bulk messaging core for our company. Team members log in with roles (admin, manager, agent). Admin connects our WhatsApp Business number(s) using Meta Cloud API credentials and sees each number's quality rating and messaging limit. Users manage contacts: import from CSV, add manually, tags, custom attributes, opt-in source and date, and automatic opt-out when a contact replies STOP. Users create WhatsApp template messages (text, media, buttons, variables), submit them to Meta and see the approval status synced. Users create bulk broadcast campaigns: choose an approved template, pick the audience by tags/attributes or upload a CSV, map template variables to contact fields with fallback values, then send now or schedule for later. Sending is throttled, can be paused and resumed, and failed messages retry automatically. Each recipient shows a status: queued, sent, delivered, read, or failed with reason. The campaign report shows counts, delivery and read rates, and estimated cost in USD; users can retarget the failed or unread recipients of a campaign with one click. Our other systems can send a template message through a REST API using an API key. Out of scope for now: shared inbox/live chat, chatbot flow builder, AI agent, ads, payments."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send a broadcast to an uploaded contact list (Priority: P1)

An admin connects the company's WhatsApp Business number. They see the message templates that
are already approved for that number. They upload a list of opted-in customers, pick a template,
fill its variables from the list's columns, and send. Afterwards they watch each recipient's
delivery status.

**Why this priority**: This is the core business value: reaching many customers on WhatsApp in one
action. With only this story, the company can already run promotions and notifications.

**Independent Test**: Use a test WhatsApp number with one approved template. Upload a 10-row list
and send. Verify that every row ends as delivered/read or failed with a reason, and that the
campaign totals match the rows.

**Acceptance Scenarios**:

1. **Given** valid credentials issued by Meta, **When** the admin connects a number, **Then** the
   number appears as "Connected" with its display name, quality rating and messaging-limit tier.
2. **Given** invalid or expired credentials, **When** the admin tries to connect, **Then** a clear
   error explains the problem and nothing is saved.
3. **Given** a connected number, **When** templates are synced (automatically on connect or by
   clicking refresh), **Then** all of the account's templates are listed with name, category,
   language, status and variables.
4. **Given** a list file with name, phone and custom columns, **When** it is uploaded in the
   campaign wizard and the user confirms the opt-in source, **Then** valid rows become recipients.
   Invalid numbers, duplicates and opted-out contacts are skipped, and each skip reason is counted.
5. **Given** a template with variables, **When** the user maps each variable to a list column or
   contact field and sets fallback values, **Then** a preview shows the final message for sample
   recipients.
6. **Given** a ready campaign, **When** the user clicks "Send now", **Then** every eligible
   recipient receives exactly one message. Each recipient's status moves through queued → sent →
   delivered → read, or ends as failed with a readable reason.
7. **Given** a recipient whose mapped variable is empty and no fallback is set, **When** the
   campaign runs, **Then** that recipient is skipped with the reason "missing variable value".

---

### User Story 2 - Manage contacts, tags, attributes and consent (Priority: P2)

A manager keeps the customer list in the platform:
- import contacts in bulk and add or edit single contacts
- group contacts with tags
- store custom details (for example city or last order date) as attributes
- see each contact's opt-in status

When a customer replies "STOP", they are unsubscribed automatically. Campaigns can then target
saved contacts by tags and attributes instead of re-uploading lists.

**Why this priority**: Repeat campaigns need a reliable, consent-aware contact base. It also
protects the WhatsApp number from complaints and bans.

**Independent Test**: Import 100 contacts with tags and attributes. Send "STOP" from one test
phone. Build an audience filter. Verify the counts, and verify that the unsubscribed contact is
excluded.

**Acceptance Scenarios**:

1. **Given** a contact file, **When** the user maps its columns (phone, name, tags, attributes,
   opt-in source, opt-in date) and imports it, **Then** contacts are created or updated (matched by
   phone number). A downloadable row-level error report lists the rejected rows.
2. **Given** selected contacts, **When** the user adds or removes a tag or sets an attribute value,
   **Then** all selected contacts are updated.
3. **Given** an opted-in contact, **When** they send a message matching an opt-out keyword (default
   "STOP" or "UNSUBSCRIBE", any letter case), **Then** within 1 minute they are marked opted-out,
   with the source "keyword" and a timestamp.
4. **Given** an opted-out contact, **When** they send an opt-in keyword (default "START"),
   **Then** they are marked opted-in again, with the source "keyword" and a timestamp.
5. **Given** a campaign audience defined by tags and attributes (e.g. tag "VIP" AND city =
   "Dubai"), **When** the user builds the audience, **Then** the eligible count is shown before
   sending, with opted-out and non-opted-in contacts excluded.
6. **Given** a deletion request for a contact, **When** an admin deletes the contact, **Then**
   their personal data is removed. Campaign totals stay correct, but the person is no longer
   identifiable.

---

### User Story 3 - Create and submit message templates (Priority: P2)

A manager writes a new WhatsApp template inside the platform: header, body with variables,
footer and buttons. They submit it to Meta for review and follow its approval status without
leaving the platform.

**Why this priority**: New offers need new templates. Creating them in-platform removes the
dependency on Meta's own tools and speeds up campaign launches.

**Independent Test**: Create a marketing template with one variable and one URL button, then
submit it. Confirm that its status appears as pending and later changes to approved or rejected
without manual refresh.

**Acceptance Scenarios**:

1. **Given** the template editor, **When** the user fills in the template parts, **Then** a live
   preview shows how the message will look on a phone. The parts are:
   - name, category (marketing, utility or authentication) and language
   - optional header (text, image, video or document)
   - body with numbered variables and sample values
   - optional footer
   - optional buttons (quick reply, website link, phone call)
2. **Given** a template that breaks WhatsApp rules (e.g. invalid name format, missing sample
   values, too-long text, too many buttons), **When** the user submits it, **Then** submission is
   blocked and each problem is shown next to the field.
3. **Given** a submitted template, **When** Meta approves or rejects it, **Then** the status updates
   automatically within 15 minutes, and a rejection shows Meta's reason.
4. **Given** a rejected template, **When** the user chooses "duplicate and edit", **Then** a
   corrected copy can be submitted.
5. **Given** a template that is not approved (pending, rejected, paused or disabled), **When** a
   user builds a campaign or calls the API, **Then** that template cannot be selected or used.

---

### User Story 4 - Schedule and control running campaigns (Priority: P3)

A manager schedules a campaign for a future date and time. They can pause it if something looks
wrong, then resume or cancel it. Temporary sending failures are retried automatically.

**Why this priority**: Timing matters for promotions. A pause button and automatic retries protect
against mistakes and short outages.

**Independent Test**: Schedule a 1,000-recipient campaign 5 minutes ahead, pause it midway, then
resume. Verify that it started on time, that no recipient got two messages, and that simulated
temporary failures were retried.

**Acceptance Scenarios**:

1. **Given** a campaign scheduled for a time in a chosen timezone, **When** that time arrives,
   **Then** sending starts within 1 minute.
2. **Given** a running campaign, **When** the user clicks "Pause", **Then** no new messages go out
   after at most 10 seconds and the campaign shows "Paused".
3. **Given** a paused campaign, **When** the user clicks "Resume", **Then** sending continues only
   for recipients not yet sent, so nobody receives a duplicate.
4. **Given** a running or scheduled campaign, **When** the user clicks "Cancel", **Then** no
   further messages are sent and unsent recipients are marked "cancelled".
5. **Given** a temporary failure (e.g. WhatsApp briefly unavailable), **When** a message fails,
   **Then** it is retried up to 3 times with increasing delay. A permanent failure (e.g. number not
   on WhatsApp) is not retried.
6. **Given** the number gets disconnected or the template is paused/disabled by Meta during a
   campaign, **When** this is detected, **Then** the campaign pauses automatically with the reason
   shown and admins are notified.

---

### User Story 5 - Campaign reports, cost estimate and retargeting (Priority: P3)

A manager opens a campaign report and sees totals, delivery and read rates, failure reasons and
the estimated cost in USD. With one click they create a follow-up campaign for the recipients who
failed or did not read the message.

**Why this priority**: Results and cost visibility decide whether a campaign worked. Retargeting
turns non-responders into a second chance at low effort.

**Independent Test**: After a test campaign, compare the report totals with the recipient export.
Check the cost estimate against the rate card, and retarget "not read" recipients into a new
draft.

**Acceptance Scenarios**:

1. **Given** a sent campaign, **When** the user opens its report, **Then** the report shows:
   - totals for queued, sent, delivered, read, failed and skipped
   - delivery rate and read rate
   - a breakdown of failure reasons
   - the estimated cost in USD
2. **Given** a USD rate card maintained by an admin (price per message category per recipient
   country), **When** a report is shown, **Then** the cost is calculated as billable messages ×
   matching rate and is clearly labelled as an estimate.
3. **Given** a campaign, **When** the user chooses "Retarget → Not read" (or Failed, Delivered,
   Read), **Then** a new draft campaign is created with exactly those recipients, minus anyone
   who has since opted out.
4. **Given** an admin or manager, **When** they export a campaign, **Then** they get a file with one
   row per recipient showing status, timestamps and failure reason.

---

### User Story 6 - Team access, roles and audit (Priority: P3)

An admin invites team members by email and assigns a role: admin, manager or agent. Each role
sees and does only what it is allowed to. Important actions are recorded in an audit log.

**Why this priority**: Several people will use the platform. Limiting who can launch campaigns,
export data or change credentials protects customers and the company.

**Independent Test**: Invite one user per role. Check each permission in the role table below
from each account, and confirm that the audit log shows the actions taken.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they invite a person with a role, **Then** the person receives an
   invitation, sets a password and can sign in with that role.
2. **Given** an agent, **When** they view contacts or reports, **Then** phone numbers show only the
   last 4 digits. They cannot launch campaigns, export data, or change settings.
3. **Given** a manager, **When** they try to connect numbers, manage users, manage API keys or edit
   the rate card, **Then** the action is not available.
4. **Given** any of these actions, **When** it happens, **Then** the audit log records who did it,
   what was done, to which item, and when:
   - sign-in, role change, number connected or disconnected, credentials changed
   - campaign launched, paused or cancelled
   - export, contact deleted, API key created or revoked
5. **Given** a deactivated team member, **When** they try to sign in, **Then** access is refused.

**Role permissions**:

| Capability | Admin | Manager | Agent |
|---|---|---|---|
| Connect/disconnect numbers, manage credentials | ✅ | – | – |
| Invite/deactivate users, change roles | ✅ | – | – |
| Create/revoke API keys, edit rate card, opt-out keywords | ✅ | – | – |
| Manage contacts, tags, attributes; import | ✅ | ✅ | – |
| Create/submit templates | ✅ | ✅ | – |
| Create, schedule, launch, pause, cancel campaigns | ✅ | ✅ | – |
| View campaigns and reports | ✅ | ✅ | ✅ (masked numbers) |
| Export data | ✅ | ✅ | – |
| View full phone numbers | ✅ | ✅ | – |
| View audit log | ✅ | – | – |

---

### User Story 7 - Send template messages from other company systems (Priority: P4)

The company's other systems (website, CRM, billing) send a WhatsApp template message, such as an
order confirmation or payment reminder, to one customer by calling the platform with an API key.
They can then check whether the message was delivered.

**Why this priority**: It automates transactional notifications. It comes after the manual
broadcast flow because it depends on templates, contacts and status tracking.

**Independent Test**: Create an API key. Send one request for an approved template to a test
number, then look up the message status. Repeat the same request with the same idempotency key,
and send a request for an opted-out number.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they create an API key with a name, **Then** the full key is shown
   once and afterwards only its name, the last 4 characters and its last-used time.
2. **Given** a valid key, an approved template, a valid phone number and variable values, **When**
   a system submits a send request, **Then** the request is accepted with a message reference. The
   message appears in an "API messages" log with its status timeline.
3. **Given** a message reference, **When** a system asks for its status, **Then** it receives the
   current status and the time of each status change.
4. **Given** an invalid or revoked key, a non-approved template, an invalid number, or an
   opted-out contact (for marketing templates), **When** a request is sent, **Then** it is rejected
   with a clear reason and no message is sent.
5. **Given** two requests carrying the same unique request ID (idempotency key) within 24 hours,
   **When** both arrive, **Then** only one message is sent and both receive the same message
   reference.
6. **Given** a key exceeding its request limit, **When** more requests arrive, **Then** they are
   refused with a "too many requests" answer until the limit resets.

---

### Edge Cases

- **Expired credentials:** credentials expire or the number is disconnected mid-campaign → the
  campaign auto-pauses, admins are notified, and recipients stay queued until it is resumed.
- **Messaging limit:** the campaign's eligible recipients exceed the number's daily messaging-limit
  tier → the user is warned before launch with the limit and the count. Messages WhatsApp rejects
  for this reason are marked failed with that reason.
- **Low quality rating:** the number's quality rating drops to "low" → a dashboard warning is shown
  and admins are notified.
- **Phone number formats:** a number without a country code uses the company's default country
  code setting. Numbers that still fail validation are skipped as "invalid number".
- **Duplicate rows:** the same phone appears more than once in an upload → only one recipient is
  kept and duplicates are counted.
- **Opt-out mid-campaign:** a contact opts out while a campaign is running → their unsent message
  is skipped as "opted out".
- **Out-of-order statuses:** e.g. "read" arrives before "delivered" → the most advanced status is
  shown and the timeline keeps every event; a status never moves backwards.
- **Repeated status update:** the same status arrives twice → it is recorded once.
- **Bad upload file:** the file is malformed, has no phone column, uses the wrong encoding, or is
  larger than the upload limit → a clear error explains what to fix and nothing is imported.
- **Bad header media:** header media is too large or of an unsupported type → it is rejected
  before submission with the allowed types and sizes.
- **Past schedule time:** the scheduled time is in the past → the user is blocked and asked to
  pick a future time.
- **WhatsApp outage:** a long outage → messages stay queued and the campaign shows "delayed".
  Retries stop after the maximum, and the remaining messages are marked failed with reason
  "service unavailable".
- **Overlapping campaigns:** two campaigns target the same contact at the same time → both are
  allowed; each campaign still sends at most one message per recipient.

## Requirements *(mandatory)*

### Functional Requirements

**WhatsApp numbers & settings**

- **FR-001**: Admins MUST be able to connect one or more company WhatsApp Business numbers using
  credentials issued by Meta. Credentials MUST be validated before they are saved.
- **FR-002**: The system MUST show for each number its phone number, display name, connection
  status, quality rating and messaging-limit tier. This MUST refresh automatically at least every
  6 hours and on demand.
- **FR-003**: Saved credentials MUST be stored securely and MUST never be displayed in full again.
- **FR-004**: Admins MUST be able to set the company's default country code and default timezone.

**Access & audit**

- **FR-005**: Users MUST sign in with email and password. The first admin account is created
  during installation, and further users join by invitation only.
- **FR-006**: The system MUST enforce the three roles (admin, manager, agent) exactly as defined in
  the role permissions table.
- **FR-007**: Agents MUST see phone numbers masked to the last 4 digits everywhere: screens,
  lists and previews.
- **FR-008**: The system MUST record security-relevant actions (listed in User Story 6) in an
  audit log that only admins can view. Entries are kept for at least 12 months.

**Contacts & consent**

- **FR-009**: Users with permission MUST be able to create, edit, search, filter and delete
  contacts. A contact has a phone number in international format, a name, tags and custom
  attributes.
- **FR-010**: The system MUST import contacts from a file with column mapping, a preview,
  matching by phone number (create or update), and a downloadable row-level error report.
- **FR-011**: Admins and managers MUST be able to define custom attributes with a type: text,
  number, date or yes/no.
- **FR-012**: Each contact MUST have a consent status (opted-in, opted-out or unknown) with the
  source and timestamp of the last change.
- **FR-013**: An inbound message matching an opt-out keyword MUST mark the contact opted-out
  within 1 minute. An opt-in keyword MUST re-subscribe them. Keywords are case-insensitive and
  editable by admins (defaults: STOP, UNSUBSCRIBE / START).
- **FR-014**: Opted-out contacts MUST be excluded from every send path: campaigns, retargeting
  and API. Marketing-category templates MUST be sent only to opted-in contacts.
- **FR-015**: Deleting a contact MUST remove their personal data while keeping aggregate campaign
  totals correct.

**Templates**

- **FR-016**: The system MUST sync templates from the company's WhatsApp account: on connect, on
  demand, and automatically when Meta changes a template's status.
- **FR-017**: Users with permission MUST be able to create a template with these parts:
  - name, category (marketing, utility or authentication) and language
  - optional header (text, image, video or document)
  - body with numbered variables and sample values
  - optional footer
  - optional buttons (quick reply, website link, phone call)
- **FR-018**: The system MUST validate a template against WhatsApp's published rules before
  submission and MUST show every problem next to the field it concerns.
- **FR-019**: The system MUST show each template's status (pending, approved, rejected with reason,
  paused, disabled). Only approved templates MAY be used in campaigns or by the API.

**Campaigns**

- **FR-020**: Users with permission MUST be able to create a campaign with these steps:
  - name and sending number
  - an approved template
  - an audience: a tag/attribute filter, all opted-in contacts, or an uploaded list (with
    confirmation of the opt-in source)
  - variable mapping with fallback values
  - a preview
  - the estimated number of recipients and estimated cost
  - send now, or schedule in a chosen timezone
- **FR-021**: Before launch, the system MUST show the eligible recipient count and the excluded
  counts by reason: opted-out, no opt-in, invalid number, duplicate, missing variable value.
- **FR-022**: The system MUST throttle sending to stay within each number's WhatsApp limits. It
  MUST send at most one message per recipient per campaign.
- **FR-023**: Users with permission MUST be able to pause, resume and cancel a running campaign.
  Resuming MUST never resend to a recipient who was already sent.
- **FR-024**: Temporary failures MUST be retried automatically up to 3 times with increasing
  delay. Permanent failures MUST NOT be retried and MUST record a readable reason.
- **FR-025**: Each recipient MUST have a status timeline (queued, sent, delivered, read, failed,
  skipped, cancelled). Updates from WhatsApp MUST be applied correctly even when duplicated or out
  of order, and a status MUST never move backwards.
- **FR-026**: Scheduled campaigns MUST start within 1 minute of their scheduled time.
- **FR-027**: A running campaign MUST pause automatically when its number becomes unavailable or
  its template is paused/disabled, and admins MUST be notified.

**Reports, cost & retargeting**

- **FR-028**: Each campaign MUST have a report with:
  - totals per status
  - delivery rate and read rate
  - a breakdown of failure reasons
  - an estimated cost in USD
- **FR-029**: Admins MUST be able to maintain a USD rate card (price per message category per
  recipient country, with an effective date). Cost estimates MUST use it and MUST be labelled as
  estimates.
- **FR-030**: Admins and managers MUST be able to export recipient-level campaign results to a
  file.
- **FR-031**: Users with permission MUST be able to create a new draft campaign from any campaign's
  recipients filtered by status (failed, not read, read, delivered). Contacts who are now opted
  out are excluded automatically.

**API for company systems**

- **FR-032**: Admins MUST be able to create, name and revoke API keys. A key's full value is shown
  only once.
- **FR-033**: Authorized systems MUST be able to request a template message to one phone number
  with variable values and receive a message reference.
- **FR-034**: Authorized systems MUST be able to retrieve a message's current status and status
  history by its reference.
- **FR-035**: API requests MUST be rejected with a clear reason when:
  - the key is invalid or revoked
  - the template is not approved
  - the phone number is invalid
  - the contact is opted out (or, for marketing templates, lacks an opt-in)
- **FR-036**: Repeated requests carrying the same unique request ID (idempotency key) within 24
  hours MUST NOT send a second message and MUST return the original message reference.
- **FR-037**: The system MUST limit requests per API key and MUST answer "too many requests" when
  the limit is exceeded.

**Notifications**

- **FR-038**: Admins MUST be notified in the app when:
  - a campaign completes or auto-pauses
  - a number's quality rating drops
  - a number's credentials stop working

### Key Entities

- **Team Member**: a person using the platform; name, email, role (admin/manager/agent), status
  (invited, active, deactivated).
- **WhatsApp Number**: a company number connected to the platform; phone, display name, connection
  status, quality rating, messaging-limit tier, securely stored credentials.
- **Contact**: a customer; phone (international format), name, consent status with source and
  timestamp, tags, attribute values.
- **Tag**: a label grouping contacts.
- **Custom Attribute**: an admin-defined contact field with a type; contacts hold values for it.
- **Message Template**:
  - identity: name, category, language
  - content: header, body, footer, buttons, variables with samples
  - review: status and rejection reason, linked to one WhatsApp account
- **Campaign**:
  - setup: name, sending number, template, audience definition, variable mapping, schedule and
    timezone
  - lifecycle: state (draft, scheduled, running, paused, completed, cancelled), totals
- **Campaign Recipient / Message**: one message to one contact; campaign or API origin, status
  timeline, failure or skip reason, retry count, estimated cost.
- **Rate Card Entry**: message category, recipient country, USD price per message, effective date.
- **API Key**: name, creator, last 4 characters, last used, revoked flag.
- **Audit Log Entry**: actor, action, target item, timestamp.
- **Consent Keywords**: the admin-editable lists of opt-out and opt-in keywords.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Starting from first sign-in, with an approved template available, an admin can
  connect a number and send a first broadcast to an uploaded list in under 15 minutes.
- **SC-002**: A 10,000-recipient broadcast finishes sending within 20 minutes whenever the number's
  WhatsApp limits allow that volume.
- **SC-003**: 100% of opted-out contacts are excluded from all sends, and opt-out takes effect
  within 1 minute of the keyword message.
- **SC-004**: Zero recipients receive the same campaign message twice across pause/resume, retry
  and duplicate-update scenarios.
- **SC-005**: 99% of delivery and read updates appear on the campaign screen within 1 minute of
  WhatsApp reporting them.
- **SC-006**: Campaign report totals match the recipient-level export exactly in 100% of
  campaigns.
- **SC-007**: A 50,000-row contact file imports in under 5 minutes, with a row-level error report.
- **SC-008**: At least 90% of first-time users complete a campaign without help (usability test
  with at least 5 team members).
- **SC-009**: When the rate card is current, the monthly estimated cost is within 5% of Meta's
  actual charges.
- **SC-010**: 99.5% of valid API send requests are accepted within 2 seconds.

## Assumptions

- **Single company:**
  - Meta bills the company directly for WhatsApp messages.
  - The platform only estimates costs; it has no wallet, subscription plans or payments.
- **Meta account:** the company has (or will set up) a Meta Business account and WhatsApp Business
  account, with its numbers registered on the WhatsApp Business Platform. Admins obtain the
  credentials from Meta.
- **Consent:** customers give opt-in outside this feature (forms, checkout, in-store). It is
  recorded through import, the upload confirmation or the API, with source and date.
- **Message types:** broadcasts and API messages use approved templates only. Free-form replies
  belong to the future shared-inbox feature.
- **Sign-in:** email + password with a strong password policy. Two-factor sign-in and single
  sign-on are later enhancements.
- **Scale:** up to 5 numbers, 200,000 contacts, and campaigns of up to 100,000 recipients.
- **Retention:** campaign data is kept for 12 months and the audit log for at least 12 months.
- **Language:** the user interface is English at launch.
- **API limits:** the per-key default is 60 requests per minute, adjustable by admins.

## Out of Scope

- Shared inbox / live chat and free-form replies.
- Chatbot flow builder, AI agents, ads management, payments.
- Click tracking on message buttons, drip/automated follow-up sequences, outbound event
  notifications to other systems.
- Multi-company (SaaS) use, subscription billing, a prepaid message wallet.
- Mobile apps.

## Dependencies

- Availability of Meta's WhatsApp Business Platform, and Meta's review times for templates and
  display names.
- The company's Meta business verification and number registration, which affect messaging-limit
  tiers.
