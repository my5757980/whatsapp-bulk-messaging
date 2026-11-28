# Research: Contacts, Settings and Security

**Feature**: `010-contacts-settings-security` | **Date**: 2026-11-28 | **Spec**: [spec.md](./spec.md)

Each decision lists what was chosen, why, and what else was considered. Meta facts were checked on
2026-11-28 against Meta's developer documentation (sources at the end).

## R1. Segments: rules and how members are found

- **Decision:**
  - A segment is a row in `segments` with its rules as JSON, checked by a shared zod schema
    (`SegmentRulesSchema` in `@wbm/shared/contacts`): `{ groups: [{ match: 'all' | 'any', rules }] }`,
    with the groups joined by "all of", up to 5 groups and 30 rules in total.
  - **Rule kinds:**
    - `tag` with `has` or `has_not`
    - `attr`, with the 001 operators by type, plus `is_empty` and `is_not_empty`
    - `consent` (one or more statuses) and `lead_source` (one or more kinds)
    - `added` (before or after a date, or within the last N days)
    - `last_inbound` (within, or not within, the last N days)
    - `blocked` (yes or no)
    - `behaviour`: event `sent`, `delivered`, `read`, `replied`, `clicked` or `failed`; `did` or
      `did_not`; scope one campaign or any campaign in the last 7, 30 or 90 days
  - Members are never stored. A new `segment-query.builder.ts` compiles the rules to one
    parameterised SQL `WHERE` over `contacts c`, next to the 001 `audience-query.builder.ts` (whose
    AND-only filter stays for existing campaigns and is reused for the `tag` and `attr` rules).
    - Behaviour rules are `EXISTS` / `NOT EXISTS` subqueries over `messages` by `contact_id`.
    - `replied` reuses the 009 single definition (`reports/replied.sql.ts`, 72-hour window).
    - `clicked` reads the 005 `link_clicks`.
  - Counts and the preview sample run on demand, with a 10-second statement timeout. Results are
    cached for 10 seconds per hash of the rules, which keeps a typing manager from re-running the
    same query.
  - A rule that names a missing tag, attribute or campaign compiles to an error with the rule's
    index. The editor shows it, and campaigns and enrolments refuse it (`SEGMENT_BROKEN`).
- **Rationale:**
  - Members are worked out when used, so segments are always current and need no sync jobs or
    triggers.
  - One SQL builder keeps segment counts, the campaign estimate and the launch snapshot identical.
- **Alternatives considered:**
  - Stored membership tables updated on events: fast reads, but every event path would have to
    update them, and drift is hard to notice.
  - Database views per segment: harder to version and test than one builder.
- **Performance:**
  - A 200,000-contact seed (`npm run perf:segments`) checks SC-001 with `EXPLAIN ANALYZE`.
  - The indexes needed are `messages (contact_id, created_at)` for "any campaign in N days", and the
    existing `messages (campaign_id, contact_id)`, `contact_tags (tag_id, contact_id)` and
    `link_clicks (contact_id)`.

## R2. Segments as campaign audiences and drip enrolments

- **Decision:**
  - **Campaigns:** the 001 `AudienceType` gains `SEGMENT` and campaigns get `segment_id`. The audience
    snapshot at launch and the estimate run the segment's SQL and then apply the 001 consent, block,
    validity and duplicate rules, the same path as `FILTER`. A campaign keeps the snapshot it made
    at launch.
  - A segment used by a draft, scheduled, running or paused campaign cannot be deleted
    (`SEGMENT_IN_USE`, listing the campaigns). Finished campaigns keep only the segment's name.
  - **Drips:** the 005 enrol request gains a third choice, `segmentId`. Enrolling a segment always
    runs as a background bulk action (R3), so the size does not matter. The result keeps the 005
    counts (enrolled, opted out, already in, not found) and is shown on the drip and in the action's
    record.
- **Rationale:** reuses the snapshot and enrolment rules that already exist; background work keeps a
  large enrolment from timing out a request.
- **Alternatives considered:** entering contacts into drips when they join a segment later (needs
  stored membership; out of scope in the spec).

## R3. Bulk actions in the background

- **Decision:**
  - A `bulk_actions` table records every bulk change: the kind (`TAG_ADD`, `TAG_REMOVE`,
    `DRIP_ENROL`), its parameters, how contacts were chosen (ids up to 10,000, a filter or a segment),
    status, totals and progress.
  - A new BullMQ queue `bulk` with one worker and concurrency 1 runs them in order, so two actions on
    the same contacts never overlap.
  - The worker walks the selection in id order (keyset batches of 5,000), using the live filter or
    segment, so contacts that match when the action runs are changed.
  - **Tags:** `INSERT … SELECT … ON CONFLICT DO NOTHING` per batch to add, `DELETE` to remove.
  - Progress (`processed`, `changed`) is saved after each batch; the page polls every 2 seconds.
  - Actions on up to 1,000 chosen ids also go through the queue; they finish within a second or two,
    and one code path is easier to test.
- **Rationale:**
  - Set-based batches tag 50,000 contacts in seconds (SC-002).
  - The queue survives restarts, and the action finishes even if the member leaves (FR-009).
- **Alternatives considered:**
  - Inline requests for small selections: a second code path for little gain.
  - The shared `maintenance` queue: long bulk work would delay its scheduled jobs.

## R4. Automatic tag rules

- **Decision:**
  - `auto_tag_rules` holds the event (`CONTACT_CREATED` with a lead source kind, `CAMPAIGN_REPLY`,
    `LINK_CLICK`, `OPTED_IN` or `OPTED_OUT`), the tag and an on/off switch.
  - One `AutoTagService.apply(event, contactId, context)` adds the tag idempotently (insert, ignore
    conflicts). Rules are cached per process for 30 seconds.
  - **Where it is called:**
    - the lead source helper when a contact is created (R5)
    - the 001 consent handler after an opt-in or opt-out
    - the 005 click recorder
    - the 002 inbound chat handler for campaign replies: an inbound message counts when the contact
      had a campaign message delivered or read in the 72 hours before, the 009 replied definition
  - Rules only see events after they are saved, and never remove tags.
- **Rationale:** few, explicit call sites; events that happen again add the tag again after a
  manual removal (US2 scenario 3).
- **Alternatives considered:** database triggers (hidden logic, hard to test); a general rules engine
  (far more than the documented behaviour).

## R5. Lead source

- **Decision:**
  - Contacts gain `lead_source_kind`, an enum: `UNKNOWN`, `ORGANIC`, `API`, `IMPORT`,
    `CAMPAIGN_UPLOAD`, `CHAT_LINK`, `AD`, `LEAD_FORM`, `FORM`, `WEBSITE_BUTTON`, `STORE`, `CUSTOM`.
    The existing `lead_source` text stays as the label: the import's label, a custom label, or a
    chat link's name.
  - **Migration:** existing text values map to kinds ('API' → API, 'Campaign upload' →
    CAMPAIGN_UPLOAD, 'STORE' → STORE, 'Lead form' → LEAD_FORM, 'Organic' → ORGANIC, 'Import' →
    IMPORT). Other non-empty values become CUSTOM with the text as label; empty becomes UNKNOWN.
  - A `leadSourceFor(kind, label?)` helper is used by every creation path (inbound handlers, the
    public and contacts APIs, imports, campaign uploads, ad leads, forms and stores). The value is
    only written in the create branch of an upsert, so it never changes later.
  - **First-message sources:** the inbound handler creates the contact as `ORGANIC`. When the same
    first message carries a chat link reference (006, or the 009 website button) or an ad referral
    (007), the matcher upgrades the source to `CHAT_LINK`, `WEBSITE_BUTTON` or `AD`. It does this
    only while the contact was created by that message (the matcher's existing `newContact` flag).
    This keeps the rule "the source of the first contact" without reordering the inbound pipeline.
- **Rationale:** an enum makes filtering and automatic tags reliable, and the label keeps
  free-text sources.
- **Alternatives considered:**
  - Free text only: today's inconsistent values ('STORE' and 'Lead form') show the problem.
  - Moving source detection before contact creation: a large change to the 001 and 002 inbound
    order for one field.

## R6. Contacts export

- **Decision:**
  - `GET /contacts/export.csv` with `segmentId`, the list's filter parameters, or neither (everyone).
  - Streamed like the 009 report CSVs: keyset batches of 2,000 rows, `res.write` with back-pressure,
    nothing stored.
  - **Columns:** name, phone (masked unless the role has `phones.full`), tags (semicolon-separated),
    one column per attribute definition, consent status, source and date, lead source kind and
    label, date added, and the last message date.
  - Needs `data.export`. Audited as `data.exported` with target type `contacts`, the selection and
    the row count. Counted in `wbm_contacts_exported_total`.
- **Rationale:** the same proven pattern as the 001 and 009 exports; 100,000 rows stream well within
  2 minutes (SC-003).
- **Alternatives considered:** a background file in object storage with a link (needs retention and
  link expiry, which streaming avoids).

## R7. Global attributes

- **Decision:**
  - `global_attributes` holds a key (`^[a-z][a-z0-9_]{0,39}$`, unique), a description, a value (up
    to 1,024 characters) and who changed it last.
  - Each process caches the values for 30 seconds. The api that saves a change also clears its own
    cache, so no message uses an old value more than 30 seconds after a change (SC-007).
  - **Where they are used:**
    - **Campaign variables:** the 001 `VariableSourceSchema` gains `source: 'global'` with `key`. It
      is resolved at launch with the other variables (the snapshot), and the launch check refuses
      empty or missing values (`GLOBAL_ATTRIBUTE_EMPTY`). Date automations use the same resolver.
    - **Placeholders:** `{global:key}` works next to the 003 placeholders in flow messages (003
      `render.ts`), saved replies (002 `canned-render.ts`) and AI agent instructions (004 prompt
      builder, filled before the request to Claude). The live chat composer offers an "Insert
      global attribute" menu that inserts the current value.
  - **Deleting one in use** is refused with the list of users: non-final campaigns whose mapping
    names it, saved replies, flow drafts and published versions, agent instructions and date
    automations (text and JSON containment checks).
- **Rationale:** one resolver for campaigns and automations; the placeholder syntax members already
  know from flows.
- **Alternatives considered:** filling values at send time for queued campaign messages (breaks the
  001 snapshot that makes campaign messages reproducible).

## R8. Keyword replies

- **Decision:**
  - The 001 `settings` row gains `opt_out_reply` and `opt_in_reply`: JSON with `{ kind: NONE | TEXT |
    TEMPLATE, text?, templateId?, variables? }`. Templates must be approved and `UTILITY`, which is
    checked on save and again before sending.
  - The 001 consent handler sends the reply after it applies a keyword's consent change, from the
    number the person wrote to:
    - a **text** goes as a session message through the 002 priority send path, and shows in the chat
    - a **template** goes through the template send path with its variables (contact fields,
      attributes, global attributes)
  - It sends at most once per contact and kind in 24 hours (`SET wbm:kwreply:{kind}:{contactId} NX
    EX 86400`), never to blocked contacts, and never while the number's sending switch is off.
  - The keyword lists keep their 20-keyword limit; a keyword in both lists is refused on save.
- **Rationale:** the person's message opens the 24-hour window, so a text reply is free and
  allowed. Keeping it inside the existing handler means the reply always follows the consent change.
- **Alternatives considered:** sending through a flow (would make every company build a flow for a
  standard confirmation).

## R9. Date automations

- **Decision:**
  - `date_automations` holds: name, date attribute key, timing (`YEARLY` or `ONCE`), offset (−30 to
    +30 days), send time (HH:mm, company time zone), number, template, variable mapping, status
    (`ON`, `OFF`, `PAUSED`) and the reason for a pause.
  - `date_automation_occurrences` holds one row per automation, contact and due date (unique). Its
    status is `PENDING`, `SENT`, `SKIPPED` or `FAILED`, with the reason and the message id.
  - **A 1-minute tick** runs on the `maintenance` queue (`date-automation-tick`). For each `ON`
    automation whose send time has passed today in the company time zone:
    1. Find due contacts by SQL on the attribute's ISO date (`attributes ->> key`):
       - **yearly:** the month and day of (date + offset) equal today's
       - **29 February:** on 28 February in years without it
       - **once:** (date + offset) equals today
    2. Insert occurrences, ignoring conflicts, so a contact can never be due twice for one
       occurrence.
    3. Turn pending occurrences into messages (new origin `DATE_AUTOMATION`), in batches of 500, on
       the number's send queue with campaign priority. The 001 template payload builder and the
       variable resolver (R7) build them.
    4. Skip, with a reason: opted out, blocked, invalid, no date, missing variable value, and not
       opted in for marketing templates.
  - At the end of the company day, occurrences still pending become `SKIPPED` with reason
    `too_late`, so nothing is sent on a later day.
  - **Before each run:** the template must be approved and the number connected with sending on.
    Otherwise the automation becomes `PAUSED` with the reason, admins get the new notification
    `DATE_AUTOMATION_PAUSED`, and resuming starts from the current day only.
  - **Results** come from occurrences joined to message statuses (delivered, read, failed) and the 009
    replied definition, grouped by due date.
- **Rationale:**
  - Due contacts come from data, so nothing has to be scheduled per contact.
  - The unique occurrence row is the guarantee against double sends (SC-004).
  - The existing send path keeps rate limits, frequency capping and statuses.
- **Alternatives considered:**
  - A job per contact per year: huge queues, and changes to dates would leave stale jobs.
  - Drips: their steps follow an enrolment, not a stored date.

## R10. Two-factor authentication

- **Decision:**
  - **Codes:** time-based one-time codes (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps, one step
    either side).
    - They are written in `common/auth/totp.ts` with `node:crypto` and tested against the RFC 6238
      test vectors, so no new dependency is needed.
    - Secrets are 20 random bytes in base32, stored encrypted with the 001 `TokenCipher`.
    - The `otpauth://` setup address is shown as a QR code with the existing `qrcode` package.
    - The last accepted time step is stored, so a code cannot be used twice.
  - **Recovery codes:** 10 codes of 10 characters from the 006 link-code alphabet. Each is stored as
    an HMAC-SHA256 with the server key and marked used. Making new ones replaces all old ones.
  - **Sign-in:**
    1. `POST /auth/login` checks the password as today.
    2. For a member with 2FA, or when 2FA is required, no session is created yet. The answer is
       `{ next: 'CODE' | 'SETUP' }`, plus a pending-login cookie `sid_2fa`: a random token kept
       hashed in Redis with the user id for 5 minutes, used once.
    3. `POST /auth/login/code` (an app code or a recovery code) creates the session.
    4. `POST /auth/login/setup` and `POST /auth/login/setup/confirm` let a member who must set up 2FA
       do it before any session exists. The confirm step returns the recovery codes once and creates
       the session.
  - **Lockout:** 5 wrong codes in a row lock the member's second step for 15 minutes. This extends the
    001 `login-throttle.service.ts` with Redis counters. Failures and locks are audited.
  - **Self-service** at `/me/2fa`: status, setup, confirm, turn off (needs a current code; refused
    while 2FA is required) and new recovery codes (needs a current code).
  - **Admins:** `PUT /settings/security { require2fa }` and `POST /users/{id}/2fa/reset` (not
    themselves). A reset also ends that member's sessions. Both need `users.manage`.
  - **Operator:** `npm run auth:reset-2fa -w @wbm/api -- --email <email>` resets one member from the
    server shell and writes an audit entry with the actor "operator".
  - API keys are untouched (FR-030).
- **Rationale:**
  - Every authenticator app supports these codes.
  - A small, vector-tested implementation avoids a new dependency for about 60 lines of standard
    code.
  - The pending-login step means a password alone never yields a session (SC-006).
- **Alternatives considered:**
  - `otplib`: fine, but a dependency for a tiny algorithm.
  - Codes by SMS or email: out of scope, and weaker.
  - WebAuthn/passkeys: out of scope for now.

## R11. Business profile and number status from Meta

- **Decision (Meta facts checked 2026-11-28):**
  - **Read:** `GET /{phone-number-id}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`.
  - **Write:** `POST /{phone-number-id}/whatsapp_business_profile` with `messaging_product:
    "whatsapp"` and only the changed fields. The picture goes as `profile_picture_handle` from the
    001 Resumable Upload flow (app upload session); reads return `profile_picture_url`.
  - **Limits checked before sending** (shared constants):
    - about: 1–139 characters, not empty
    - address: up to 256
    - description: up to 512
    - email: valid, up to 128
    - websites: up to 2, each up to 256, starting with `http://` or `https://`
    - vertical: empty or one of Meta's list (`ALCOHOL`, `APPAREL`, `AUTO`, `BEAUTY`, `EDU`,
      `ENTERTAIN`, `EVENT_PLAN`, `FINANCE`, `GOVT`, `GROCERY`, `HEALTH`, `HOTEL`, `NONPROFIT`,
      `ONLINE_GAMBLING`, `OTC_DRUGS`, `OTHER`, `PHYSICAL_GAMBLING`, `PROF_SERVICES`, `RESTAURANT`,
      `RETAIL`, `TRAVEL`)
  - **Picture:** JPEG or PNG, square, at least 192×192 pixels, up to 5 MB. Meta's API pages give no
    exact limit (192 pixels is WhatsApp's own advice), so this is our guard, and the release
    checklist confirms it on the real account.
  - **Number status:** `GET /{phone-number-id}?fields=verified_name,name_status,new_name_status,quality_rating,whatsapp_business_manager_messaging_limit`.
    - `name_status` is `APPROVED`, `DECLINED`, `EXPIRED`, `PENDING_REVIEW` or `NONE`.
    - `new_name_status` only appears for a requested change.
    - The messaging limit comes from `whatsapp_business_manager_messaging_limit`, because
      `messaging_limit_tier` is deprecated. Since v24 the limit belongs to the business portfolio
      and is shared by its numbers. The 001 number sync stores it in the existing
      `messaging_limit_tier` column.
    - Read when the page opens, cached for 5 minutes, and by the 001 sync.
  - A `number_business_profiles` row per number keeps what Meta last returned, with the read and
    change times. The audit entry stores the changed field names, not the values.
  - mock-meta and the integration `FakeGraph` serve both endpoints with Meta's error shape.
- **Rationale:** follows Meta's documented endpoints, and our own checks give clearer messages than
  Meta's errors.
- **Alternatives considered:** editing in WhatsApp Manager only (the inventory item asks for it in
  the platform).

## R12. Blue tick checklist and guides

- **Decision:**
  - **Content:** the checklist steps and both migration guides are versioned data in `@wbm/shared`
    (`settings/oba-checklist.ts`, `settings/number-guides.ts`). They are in our own words, with
    links to Meta's pages and a `checkedAt` date, like the 009 help content.
  - **Checklist steps:**
    - business verification
    - an approved display name
    - two-step verification on the number
    - a complete business profile
    - three or more articles about the business in well-known news sources, which are not paid or
      promotional (from Meta's notability guidance)
    - applying in WhatsApp Manager
  - **Progress** is one `oba_checklist` row: step states, the application date, Meta's answer and a
    note. Changes are audited.
  - The "move back to the app" guide links to the existing number removal, which asks for a typed
    confirmation.
- **Rationale:** guides change rarely and need review against Meta's pages; data files keep them
  testable (every step has text and a link) and dated.
- **Alternatives considered:** a CMS (far beyond the need).

## R13. Roles, audit, retention and monitoring

- **Decision:**
  - **Roles:** existing permissions only.

    | What | Permission |
    |---|---|
    | Segments | `campaigns.manage` to change; `contacts.view` to use as a filter |
    | Bulk tags | `contacts.manage` |
    | Exports | `data.export` |
    | Automatic tag rules, global attributes, keyword replies | `settings.manage` |
    | Inserting global attributes in chats | `inbox.reply` |
    | Date automations | `campaigns.manage` to change; `campaigns.launch` to switch on or resume |
    | 2FA requirement and resets | `users.manage` |
    | Business profile and checklist | `numbers.manage` to change; `numbers.view` to see |
    | Guides | `numbers.view` |

  - **Audit actions:** `segment.created`, `segment.updated`, `segment.deleted`,
    `contacts.bulk_tagged`, `auto_tag_rule.changed`, `global_attribute.created`,
    `global_attribute.updated`, `global_attribute.deleted`, `keyword_replies.changed`,
    `date_automation.created`, `date_automation.updated`, `date_automation.deleted`,
    `date_automation.switched`, `auth.2fa_enabled`, `auth.2fa_disabled`, `auth.2fa_reset`,
    `auth.2fa_recovery_used`, `auth.2fa_failed`, `auth.2fa_locked`, `security.2fa_required_changed`,
    `business_profile.changed` and `oba_checklist.changed`, plus `data.exported` with target
    `contacts`.
  - **Retention and erasure:**
    - date automation occurrences follow message retention (12 months)
    - bulk action records are kept 90 days and hold counts and selections, never contact lists
    - erasure deletes a contact's occurrences, and exports never include erased contacts
  - **Metrics:**
    - `wbm_segment_query_seconds` (histogram)
    - `wbm_bulk_actions_total{kind,result}`
    - `wbm_contacts_exported_total`
    - `wbm_keyword_replies_total{kind,result}`
    - `wbm_date_automation_messages_total{result}`
    - `wbm_login_second_step_total{result}`
  - **Alerts:**
    - `WbmDateAutomationBehind`: occurrences still pending 30 minutes after their send time
    - `WbmSecondStepFailures`: more than 30 failed sign-in codes in 15 minutes
- **Rationale:** the same shape as 005–009.

## R14. Testing approach

- **Decision:**
  - **Unit:**
    - the segment rule schema and the SQL builder (snapshots per rule kind)
    - TOTP against the RFC 6238 vectors, and recovery code checks
    - due-date maths: yearly, once, offsets, 29 February, time zones
    - business profile checks, and the guide and checklist data
  - **Integration:** each story against Postgres and Redis with the nock `FakeGraph`:
    - segments, counts and broken rules
    - campaign and drip use
    - the bulk queue, automatic tags and lead source per entry point
    - the export, global attributes in every place they are used
    - keyword replies, date automation runs (with a fake clock), 2FA sign-in and lockout
    - the business profile, and the RBAC, audit, retention and erasure cases
  - **Contract:** `contacts-settings-api.openapi.yaml` and the login additions.
  - **E2e:** one Playwright spec per story on mock-meta, plus an e2e sign-in with an app code made by
    the test from the shown secret.
- **Rationale:** test-first, as every earlier feature (constitution V).

## Sources

- [Business profiles (business phone numbers) – Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/business-profiles)
- [Business profiles – Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-profiles)
- [Business phone numbers – Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Messaging limits – Meta for Developers](https://developers.facebook.com/docs/whatsapp/messaging-limits/)
- [WhatsApp changelog – Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)
- [Image messages – Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/image-messages)
- [How to send media, contacts, or location – WhatsApp Help Center](https://faq.whatsapp.com/453914586839706/)
- RFC 6238 (TOTP) and RFC 4226 (HOTP), for the code algorithm and test vectors
