# Feature Specification: Click-to-WhatsApp Ads and the Ads Manager

**Feature Branch**: `007-ads-manager`
**Created**: 2026-11-25
**Status**: Draft
**Input**: User description: "Feature 007: Click-to-WhatsApp ads and the ads manager (AiSensy inventory items 10.1-10.4 and the text part of 9.7; public information only, our own design and wording). Managers run Meta ads from the platform with the company's own ad account, paid directly to Meta (no ad credits). Admins connect the ad account and Facebook page once (system user token, checked like the number wizard). Ad types: Click-to-WhatsApp ads that open a chat with one of our numbers with a pre-filled message (the main type), plus website and lead-form ads where Meta allows them. A guided builder: objective, audience (locations, age, gender, interests, and custom audiences made from our contact tags or campaign results, plus lookalikes of them), placements (automatic or chosen), daily budget and start/end dates, creative (upload image or video, primary text, headline, call to action), with optional AI-drafted ad text from the existing AI assistant. Submit to Meta, then track review and delivery status (in review, active, rejected with the reason, paused, ended); pause, resume, change budget or end date, and duplicate. Reporting synced from Meta per ad and per campaign: impressions, reach, clicks, CTR, CPC, spend, plus our own chats started, new contacts, replies and cost per chat. Chats that start from an ad carry the ad (Meta referral data), show it in live chat, and use Meta's free 72-hour window for ad chats where it applies; a flow can start when a chat comes from a chosen ad (ad trigger in the flow builder). Lead-form leads become contacts with their consent answer, tagged by form. Out of scope: AI image or video generation, WhatsApp Status ads if Meta does not offer them through the API, buying ad credits, other ad networks. Permissions: admins connect accounts, managers build and run ads, agents see results. Audit, retention and privacy as in earlier features."

**Context**: This is the next part of the order the user chose on 2026-11-19 (live chat, flows,
the AI agent, campaign growth, integrations, then ads and payments). It covers items 10.1–10.4 and
the ad text part of 9.7 of `docs/research/aisensy/feature-inventory-2026-11-19.md`. Item 10.5 (ad
credits sold by AiSensy) does not apply: the company pays Meta directly. We match the documented
behaviour, not the look: screens, labels and wording are our own (constitution Principle II).

## Concepts used in this spec

| Term | Meaning |
|---|---|
| **Ad account** | The company's own Meta ad account. Meta bills it directly; the platform never handles payment. |
| **Facebook Page** | The company's page that ads run under. A Click-to-WhatsApp ad needs the page to be linked to the WhatsApp number the chats go to. |
| **Ads connection** | The link between the platform and the ad account and page, made once by an admin with a token, and checked like the 006 number wizard. |
| **Ad campaign** | What a manager builds in the platform: one goal, one audience, one budget and schedule, and one to five ad versions. It becomes a campaign with one ad set and its ads at Meta. |
| **Ad version** | One creative of an ad campaign: an image or video, the main text, a headline and a button. Meta reviews each version. |
| **Click-to-WhatsApp ad** | An ad whose button opens a WhatsApp chat with one of the company's numbers, with a pre-filled message. |
| **Lead-form ad** | An ad that opens a short form inside Facebook or Instagram; the answers become a lead. |
| **Website ad** | An ad whose button opens a web page. |
| **Audience** | Who sees the ad: places, ages, gender and interests, optionally a saved list of the company's own contacts (a custom audience) or people similar to them (a lookalike). |
| **Custom audience** | A list made from the platform's contacts (for example a tag or a campaign's "clicked" group), sent to Meta in the protected form Meta requires, so ads can reach or exclude them. |
| **Lookalike** | People Meta finds who resemble a custom audience. |
| **Ad chat** | A chat that starts when a person taps a Click-to-WhatsApp ad. Meta tells the platform which ad it came from. |
| **Free ad window** | Meta's rule that messages in a chat started from an ad are free for 72 hours once the business replies in time. |
| **Lead** | The answers one person gave in a lead form. |
| **Spending cap** | A monthly limit an admin sets for ads made in the platform. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect the company's ad account and page (Priority: P1)

An admin opens **Ads → Connect** and pastes a token from the company's Meta business settings. The
platform checks it and lists the ad accounts and pages it can reach. The admin picks the ad account
and the page. The platform then checks each thing ads need and shows a plain fix for each failure:
the token's permissions and expiry, that the ad account is active and has a payment method, its
currency and time zone, that the page can run ads, which WhatsApp numbers are linked to the page,
and whether the terms for lead forms and customer lists are accepted. The admin saves the
connection; the token is stored encrypted.

**Why this priority**: nothing else in ads works without the connection, and catching missing
permissions or an unlinked number here saves failed ads later.

**Independent Test**: With a test token, connect an ad account and a page; a token missing a
permission is named with its fix; a page without a linked number shows the fix; the saved
connection shows the account's currency and time zone.

**Acceptance Scenarios**:

1. **Given** an admin pastes a valid token, **When** the platform checks it, **Then** it lists the ad accounts and pages the token can use.
2. **Given** the token lacks a permission ads need, **When** checked, **Then** the check names the missing permission and how to add it.
3. **Given** the chosen ad account is disabled or has no payment method, **When** checked, **Then** the check fails with the reason Meta gives and a fix, and ads cannot be launched until it passes.
4. **Given** the page has no WhatsApp number linked, **When** checked, **Then** the check says Click-to-WhatsApp ads need it and how to link the number in Meta.
5. **Given** the connection is saved, **When** anyone views it later, **Then** the token is never shown again, and only a "Run checks" and "Replace token" are offered.

---

### User Story 2 - Launch a Click-to-WhatsApp ad (Priority: P1)

A manager opens **Ads → New ad** and follows a guided builder:
1. **Goal**: start WhatsApp chats (the default), get leads with a form, or send people to a website.
2. **Chat**: the WhatsApp number (from those linked to the page) and the message the customer sees
   ready to send.
3. **Audience**: countries, regions or cities, age range, gender, interests, and optionally saved
   audiences to include or exclude.
4. **Placements**: automatic (recommended) or chosen (Facebook, Instagram, their feeds and stories).
5. **Budget and dates**: a daily budget in the ad account's currency, a start date and an optional
   end date.
6. **Ad versions**: one to five, each with an image or a video, the main text, a headline and a
   button. A **Write with AI** button drafts the texts from a short description, which the manager
   edits.

The builder shows the estimated audience size and checks Meta's minimums before submitting. On
submit, Meta reviews the ad; the platform shows "In review", then "Active" or "Rejected" with
Meta's reason. A rejected version can be edited and submitted again.

**Why this priority**: chats from ads are the main way new customers reach the company on WhatsApp,
and this is the feature's core.

**Independent Test**: Build a Click-to-WhatsApp ad with one image version and a daily budget,
submit it, and see it go from In review to Active (or Rejected with a reason) as Meta reports.

**Acceptance Scenarios**:

1. **Given** a manager builds an ad with all required parts, **When** they submit it, **Then** it is created at Meta paused for review as Meta does, and the platform shows "In review".
2. **Given** Meta approves the ad, **When** the platform learns it, **Then** the status shows "Active" and the dates and budget as set.
3. **Given** Meta rejects a version, **When** the platform learns it, **Then** the version shows "Rejected" with Meta's reason, and the manager can edit and resubmit it.
4. **Given** the daily budget is below Meta's minimum for the account's currency, **When** the manager continues, **Then** the builder says the minimum and blocks submitting.
5. **Given** a manager asks the AI to write the texts, **When** it answers, **Then** the main text and headline are filled in within Meta's length limits, and nothing is submitted until the manager submits.
6. **Given** the chosen number is not linked to the page, **When** the manager picks it, **Then** the builder explains why it cannot be used.

---

### User Story 3 - Handle chats that come from ads (Priority: P1)

When a person taps a Click-to-WhatsApp ad and sends the message, the chat appears in live chat with
the ad's name and picture, so the agent knows what they saw. The contact's journey records the ad.
The chat shows that Meta's free ad window applies and until when. A manager can choose a flow that
starts when a chat comes from a given ad (an ad trigger in the flow builder), and a tag that each
such contact gets. Chats from ads made outside the platform are still marked with the ad Meta names.

**Why this priority**: the value of an ad is the conversation it starts; agents and flows need to
know where the customer came from.

**Independent Test**: Receive a customer message that carries an ad's details; the chat shows the
ad, the journey records it, the contact gets the ad's tag, and the ad's flow starts.

**Acceptance Scenarios**:

1. **Given** a customer message carries an ad's details, **When** it arrives, **Then** the chat is marked with the ad (name, picture, headline) in live chat and in the contact's journey.
2. **Given** the ad belongs to a platform ad campaign with a flow, **When** the chat starts, **Then** the flow starts before keyword flows and the AI agent, unless a flow is running or a member has the chat (as for chat links in 006).
3. **Given** the ad campaign has a tag, **When** the chat starts, **Then** the contact gets the tag.
4. **Given** the chat started from an ad, **When** an agent looks at it, **Then** they see that the free ad window applies and when it ends, under Meta's current rules.
5. **Given** the ad was made outside the platform, **When** its chat arrives, **Then** the chat is still marked with the ad's details Meta sends, and counted under "Other ads".

---

### User Story 4 - See ad results (Priority: P2)

A manager opens an ad campaign's results and sees, per day and in total, Meta's numbers
(impressions, reach, clicks, click-through rate, cost per click and spend) and the platform's own
(chats started, new contacts, contacts who replied, leads, and cost per chat or lead). Each ad
version has the same numbers. The ads list shows each campaign's status, spend and chats at a
glance. Results can be exported.

**Why this priority**: managers decide what to keep, change or stop from these numbers.

**Independent Test**: For an ad with Meta numbers for two days and three chats started, the
results show both days, the totals and the cost per chat.

**Acceptance Scenarios**:

1. **Given** an active ad, **When** the platform syncs Meta's numbers, **Then** today's numbers are at most an hour old and earlier days are final within a day.
2. **Given** chats started from the ad, **When** results are shown, **Then** chats started, new contacts and replies are counted from the platform's own records, and cost per chat is spend divided by chats started.
3. **Given** a manager exports results, **When** the file is made, **Then** it lists each day and each version, with phone numbers masked for roles without full phone access.

---

### User Story 5 - Manage running ads and spending (Priority: P2)

A manager can pause, resume and end an ad campaign, pause one version, change the daily budget or
the end date, and duplicate a campaign to start a new one. An admin can set a monthly spending cap
for ads made in the platform: a launch or budget change that could exceed the rest of the month's
cap is refused, and ads pause when the month's spend reaches the cap. The platform warns admins
when the ad account has a payment problem or an ad stops delivering.

**Why this priority**: ads spend real money; managers need control and admins need a limit.

**Independent Test**: Pause and resume an active ad, change its budget, and see Meta's state
follow; set a cap below the planned monthly spend and see the budget change refused.

**Acceptance Scenarios**:

1. **Given** an active ad campaign, **When** a manager pauses it, **Then** it pauses at Meta and shows "Paused"; resuming makes it active again.
2. **Given** a manager raises the daily budget, **When** the change would let the month's spend pass the cap, **Then** it is refused with the remaining amount.
3. **Given** the month's spend reaches the cap, **When** the platform sees it, **Then** it pauses the platform's ads and alerts admins and the ads' managers.
4. **Given** a campaign is duplicated, **When** the copy opens, **Then** it is a draft with the same settings and versions, not yet at Meta.
5. **Given** Meta reports a payment problem or an ad stops for policy reasons, **When** the platform learns it, **Then** admins and the ad's manager get an alert with Meta's reason.

---

### User Story 6 - Target ads at the company's own contacts (Priority: P2)

A manager makes a saved audience from the platform's contacts: a tag, a contact filter, or a 005
campaign group (for example "clicked" or "replied"). The platform sends it to Meta in the protected
form Meta requires and keeps it up to date daily. Opted-out and blocked contacts are never included.
The manager can make a lookalike of it, and use either to include or exclude people in an ad.

**Why this priority**: reaching past customers, or people like them, usually costs less per chat
than broad audiences.

**Independent Test**: Make an audience from a tag of 1,000 contacts with 10 opted out; Meta receives
990; a new tagged contact is added at the next daily update; a lookalike of it can be chosen in the
builder.

**Acceptance Scenarios**:

1. **Given** a tag with contacts, **When** a manager makes an audience from it, **Then** it is created at Meta with the contacts' details in the protected form, and the opted-out and blocked contacts left out.
2. **Given** contacts join or leave the tag, **When** the daily update runs, **Then** Meta's audience gains and loses them.
3. **Given** an audience is too small for Meta to use, **When** it is shown, **Then** the platform says so and the builder will not offer it until it is large enough.
4. **Given** a contact is deleted or opts out, **When** the next update runs, **Then** they are removed from every audience at Meta.

---

### User Story 7 - Collect leads with lead-form ads (Priority: P3)

A manager builds a lead-form ad: the form's questions (name, phone, email and up to three of their
own), a privacy policy link, and a consent question that names WhatsApp. When someone submits the
form, the lead arrives in the platform within minutes and becomes a contact (or updates one), tagged
with the form's name. The contact is opted in to WhatsApp only when they ticked the consent question.
A manager can choose a template to send at once to leads who consented. Leads can be listed and
exported.

**Why this priority**: lead forms suit people who are not ready to chat; it is a second goal after
chats.

**Independent Test**: Submit a test lead with consent ticked and one without; both become contacts
with the form's tag, only the first is opted in and gets the welcome template.

**Acceptance Scenarios**:

1. **Given** a lead is submitted, **When** the platform receives it, **Then** it creates or updates the contact by phone number and adds the form's tag.
2. **Given** the person ticked the WhatsApp consent question, **When** the lead is saved, **Then** the contact is opted in with the source "lead form" and the form's name; otherwise their consent is unchanged.
3. **Given** a welcome template is chosen, **When** a consenting lead arrives, **Then** the template is sent once.
4. **Given** the same lead arrives twice, **When** it is processed, **Then** only one lead and one contact change are recorded.

---

### User Story 8 - Website ads and AI-drafted texts (Priority: P3)

A manager builds an ad that sends people to a web page, with a 005 tracked link so clicks that reach
the page are counted with the platform's own numbers too. In any ad builder, **Write with AI**
drafts the main text and headline from a short description of the offer, in the company's chosen
language and within Meta's limits.

**Why this priority**: website ads are less central to WhatsApp, and AI texts save time but are not
needed to run ads.

**Independent Test**: Build a website ad with a tracked link and launch it; the results show Meta's
clicks and the tracked link's visits. Ask the AI for texts and get editable drafts within limits.

**Acceptance Scenarios**:

1. **Given** a website ad with a tracked link, **When** people open it, **Then** the results show Meta's link clicks and the platform's counted visits.
2. **Given** a manager asks the AI for texts, **When** the drafts arrive, **Then** they respect Meta's length limits, avoid claims the company's AI settings forbid, and are only used after the manager edits or accepts them.

---

### Edge Cases

- **Connection problems:** the token expires or is revoked, the ad account is disabled or its payment fails, or the page loses its link to the number. The platform marks the connection, stops new launches, alerts admins, and shows the fix; running ads keep running at Meta.
- **Meta minimums and limits:** budgets below the minimum, audiences too narrow or too small, texts over the length limits, or images and videos Meta refuses (size, ratio, length). The builder checks what it can before submitting and shows Meta's own message otherwise.
- **Special ad categories:** ads about credit, employment, housing or social issues need Meta's special category, which limits targeting. The builder asks whether the ad is about one of them (default: no) and applies Meta's limits.
- **Review results:** a version is rejected while others are approved; the campaign runs with the approved ones and shows the rejected one with its reason.
- **Changes made in Meta's own tools:** the platform reads the current state at each sync and shows it; it never overwrites changes made elsewhere without the manager doing it in the platform.
- **Chats from ads of other numbers:** an ad chat that arrives on a number the ad did not point to is still marked with the ad.
- **Free ad window:** the window applies only under Meta's current rules (for example if the business replies within the time Meta sets). The platform shows it as information and never sends messages outside Meta's rules because of it.
- **Running flows and member chats:** an ad's flow never interrupts a running flow or a member's chat (as for chat links).
- **Lead data:** a lead without a phone number is stored and exported but cannot become a WhatsApp contact; an invalid phone is shown as such. A lead that names an existing contact updates it.
- **Deleted contacts:** they are removed from audiences at the next update, and their leads keep no personal data.
- **Time zones and currency:** Meta's numbers are per day in the ad account's time zone and in its currency; the platform shows them as Meta does and says so.
- **Spending cap:** spend at Meta can run past the cap until the platform pauses the ads; the platform checks often enough that this is at most a few hours of budget.
- **Meta outages and rate limits:** syncs and changes are retried; the platform shows when numbers were last updated.

## Requirements *(mandatory)*

### Functional Requirements

**Ads connection**

- **FR-001**: Admins MUST be able to connect one ad account and one Facebook Page with a pasted token, choosing from the accounts and pages the token reaches.
- **FR-002**: The connection MUST check, each with passed, failed or warning and a plain fix: the token's permissions and expiry; the ad account's status, payment method, currency and time zone; the page's ability to run ads; the WhatsApp numbers linked to the page; and the acceptance of Meta's terms for lead forms and customer lists.
- **FR-003**: The token MUST be stored encrypted, never shown again, and never sent in events or logs. Admins can run the checks again or replace the token.
- **FR-004**: When a check that ads depend on fails later (for example an expired token or a disabled account), the platform MUST stop new launches and changes, alert admins, and keep showing the last known state.

**Building and launching ads**

- **FR-005**: Managers MUST be able to build an ad campaign with a guided builder: goal (WhatsApp chats, leads, or website visits), audience, placements, daily budget, start and end dates, and one to five ad versions.
- **FR-006**: For WhatsApp chats, the manager MUST choose one of the company's numbers linked to the page and the message the customer sees ready to send.
- **FR-007**: The audience MUST support countries, regions and cities, an age range, gender, interests found by searching Meta's list, and saved audiences to include or exclude.
- **FR-008**: Placements MUST be automatic by default, with the option to choose Facebook and Instagram feeds and stories.
- **FR-009**: Each ad version MUST have an image or a video, the main text, a headline and a button suited to the goal. Uploads MUST be checked against Meta's published size and format limits before submitting.
- **FR-010**: The builder MUST show Meta's audience size estimate and refuse budgets below Meta's minimum for the account's currency, with the minimum shown.
- **FR-011**: The builder MUST ask whether the ad is about credit, employment, housing or social issues, and apply Meta's targeting limits for those categories.
- **FR-012**: Submitting MUST create the campaign at Meta and show its review and delivery state: draft, in review, active, rejected (with Meta's reason per version), paused, ended or error.
- **FR-013**: A rejected version MUST be editable and resubmittable without rebuilding the campaign.
- **FR-014**: Managers MUST be able to save a draft and finish it later; drafts are not sent to Meta.
- **FR-015**: **Write with AI** MUST draft the main text and headline from a short description using the 004 AI service, within Meta's length limits and the company's AI rules, and MUST never submit anything by itself.

**Running ads and spending**

- **FR-016**: Managers MUST be able to pause, resume and end a campaign, pause and resume one version, change the daily budget and the end date, and duplicate a campaign as a new draft.
- **FR-017**: The platform MUST read each campaign's state from Meta at least every 15 minutes while it is in review or active, and show changes made in Meta's own tools without overwriting them.
- **FR-018**: Admins MUST be able to set a monthly spending cap for ads made in the platform. A launch or budget change that could let the month's spend pass the cap MUST be refused with the remaining amount.
- **FR-019**: When the month's spend reaches the cap, the platform MUST pause its ads at Meta and alert admins and the ads' managers.
- **FR-020**: The platform MUST alert admins and the ad's manager when Meta reports a payment problem, a disapproval of a running ad, or that an ad stopped delivering.

**Chats from ads**

- **FR-021**: When a customer message carries an ad's details from Meta, the platform MUST attach the ad to the chat and the message, and show the ad's name, picture and headline in live chat.
- **FR-022**: The contact's journey MUST record that the chat came from the ad. Ads made outside the platform MUST be recorded with the details Meta sends and grouped as "Other ads".
- **FR-023**: Live chat MUST show whether Meta's free ad window applies to the chat and when it ends, under Meta's current rules, as information for agents.
- **FR-024**: Managers MUST be able to choose, per ad campaign, a flow that starts when a chat comes from it and a tag for those contacts. The flow MUST start before keyword flows and the AI agent, but never interrupt a running flow or a member's chat.
- **FR-025**: The flow builder MUST offer an "ad" trigger that starts a flow for chats from chosen ad campaigns.

**Results**

- **FR-026**: Each ad campaign and version MUST show, per day and in total, Meta's impressions, reach, clicks, click-through rate, cost per click and spend, and the platform's chats started, new contacts, contacts who replied, leads, and cost per chat or lead.
- **FR-027**: Today's Meta numbers MUST be at most one hour old while the campaign runs; earlier days MUST be updated until Meta's numbers are final.
- **FR-028**: The ads list MUST show each campaign's goal, status, dates, daily budget, spend to date and chats or leads.
- **FR-029**: Results MUST be exportable as CSV, with phone numbers masked for roles without full phone access.
- **FR-030**: Website ads MAY use a 005 tracked link, and then show the platform's counted visits next to Meta's clicks.

**Audiences**

- **FR-031**: Managers MUST be able to make a saved audience from a tag, a contact filter, or a 005 campaign group, and a lookalike of a saved audience in chosen countries.
- **FR-032**: Contacts MUST be sent to Meta only in the protected (hashed) form Meta requires; opted-out, blocked and deleted contacts MUST never be included.
- **FR-033**: Saved audiences MUST be updated at Meta at least daily, adding and removing contacts as they change.
- **FR-034**: An audience too small for Meta to use MUST be shown as such and not offered in the builder.

**Lead forms**

- **FR-035**: Managers MUST be able to build a lead form with name, phone and email, up to three own questions, a privacy policy link and a consent question that names WhatsApp.
- **FR-036**: Leads MUST arrive in the platform within 5 minutes of being submitted, each recorded once.
- **FR-037**: A lead with a phone number MUST create or update a contact, tagged with the form's name. The contact MUST be opted in to WhatsApp only when the consent question was ticked, with the source "lead form" and the form's name.
- **FR-038**: Managers MAY choose a welcome template for a form; it MUST be sent once to each consenting lead, following the 001 sending rules.
- **FR-039**: Leads MUST be listed per form with their answers and exportable; their arrival MUST be an outbound webhook event (006).

**Permissions, audit, retention and privacy**

- **FR-040**: Permissions MUST be: admins connect accounts and set the cap; admins and managers build, launch, change and end ads and audiences; agents see ads, results and leads with masked phone numbers; exports need the export permission.
- **FR-041**: Every connection change, launch, change of state or budget, cap change, audience creation or deletion, and lead export MUST be recorded in the audit log.
- **FR-042**: Meta's daily numbers MUST be kept 25 months; leads 12 months; ad chat links to the ad for as long as the chat's messages are kept (002 rules).
- **FR-043**: Deleting a contact MUST remove them from audiences at Meta at the next update and clear the personal data of their leads, keeping only counts.
- **FR-044**: Customer details sent to Meta MUST be limited to what audiences need (hashed phone numbers and emails), never message content.

### Key Entities

- **Ads connection**: the ad account and page in use, the encrypted token, the account's currency and time zone, the last check results, and the monthly spending cap.
- **Ad campaign**: goal, number and pre-filled message (for chats), audience, placements, daily budget, dates, special category, flow and tag for chats, state, Meta's ids, and who made it.
- **Ad version**: an image or video, main text, headline, button, review state with Meta's reason, and Meta's id.
- **Media upload**: an image or video used in versions, with Meta's reference.
- **Saved audience**: its source (tag, filter or campaign group), size, last update, Meta's id, and lookalikes made from it.
- **Ad result day**: Meta's numbers for one campaign or version on one day, with when they were read.
- **Ad chat start**: a chat that began from an ad, with the ad's details from Meta, the contact, and whether they were new.
- **Lead form**: questions, consent wording, privacy link, tag, welcome template, and Meta's id.
- **Lead**: one person's answers to a form, the contact it made or updated, and the consent answer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A manager can build and submit a Click-to-WhatsApp ad with one version in under 10 minutes, without leaving the platform.
- **SC-002**: Review and delivery changes made at Meta show in the platform within 15 minutes for 95% of changes.
- **SC-003**: 99% of chats that start from an ad are marked with the right ad, and its flow and tag apply.
- **SC-004**: After the daily update, the platform's spend, impressions and clicks per campaign match Meta's numbers for the same day.
- **SC-005**: 95% of leads become contacts (or update them) within 5 minutes of being submitted, each once.
- **SC-006**: Ads made in the platform never run more than 2 hours past the month's spending cap.
- **SC-007**: No opted-out, blocked or deleted contact is in a saved audience at Meta more than 24 hours after the change.

## Assumptions

- The company has a Meta business portfolio with an ad account, a payment method, and a Facebook Page linked to the WhatsApp numbers used in ads. Meta business verification may be needed for some features; the release checklist covers it.
- One ad account and one page are enough for one company. More accounts or pages are out of scope.
- The company's own Meta app with a system user token is used, with the permissions Meta requires for managing its own ads, pages and leads. Access to Meta's ads features for a company's own accounts is assumed; any app review Meta requires is a release item.
- The platform's ad campaign has one audience and budget (one ad set) and one to five versions; complex structures stay in Meta's own tools.
- Meta's review time, minimum budgets, length limits and audience size limits are Meta's; the platform shows them and does not change them.
- The free ad window is Meta's pricing rule; the platform only shows it. Whether a message is free is decided by Meta's billing.
- AI texts use the 004 AI service and settings (the same monthly limit and content rules).
- Leads arrive through Meta's lead notifications to the platform, with a periodic catch-up so none are missed.
- Prices and spend are shown in the ad account's currency, not converted.
- WhatsApp Status ads are left out unless Meta offers them to the company's account through its tools for developers.

## Out of Scope

- AI image or video generation for ads.
- Buying ad credits; Meta bills the company directly.
- Other ad networks (Google, TikTok, Snapchat and others).
- WhatsApp Status ads if Meta does not offer them through its tools for developers.
- Messenger or Instagram Direct as chat destinations; catalog and shopping ads (planned with commerce).
- More than one ad account or page, and agency setups.
- A/B test campaigns and automated budget rules beyond the spending cap.

## Dependencies

- 001: contacts, tags, consent, templates, sending rules, roles, audit and exports.
- 002: live chat, the contact journey and notifications.
- 003: the flow builder (the ad trigger) and flow sessions.
- 004: the AI service for ad texts.
- 005: campaign groups for audiences and tracked links for website ads.
- 006: the wizard-style checks, outbound webhook events, and the chat link rules for starting flows.
- Meta: the company's ad account, page, app, permissions, terms for leads and customer lists, and ad review.
