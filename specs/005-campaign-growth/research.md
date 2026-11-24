# Research: Campaign Growth

**Feature**: `005-campaign-growth` | **Date**: 2026-11-23 | **Spec**: [spec.md](./spec.md)

Meta's rules were checked on 2026-11-23 against Meta's developer documentation. Where only vendor
summaries were available, that is said.

## R1. Where tracked links live

- **Decision:**
  - Tracked links are `${PUBLIC_LINK_BASE_URL}/{code}`. `PUBLIC_LINK_BASE_URL` is a new setting,
    for example `https://go.company.example` or `https://wa.company.example/l`.
  - The api serves them on a public route, `GET /l/:code`, outside `/api`: no session and no CSRF,
    but rate-limited per client.
  - The route looks the code up and answers `302` to the destination, with `Cache-Control:
    no-store` and `Referrer-Policy: no-referrer`. It records the click (R3).
  - Unknown or expired codes get a small `404` page that sends nobody onward.
- **Rationale:**
  - Meta's template guidance, as summarised by several providers, rejects third-party link
    shorteners and expects links on a domain that belongs to the business
    ([Bird](https://docs.bird.com/applications/content/message-templates/concepts/whatsapp-message-templates/whatsapp-business-template-guidelines-and-restrictions),
    [AWS End User Messaging](https://docs.aws.amazon.com/social-messaging/latest/userguide/managing-templates_rejection.html),
    [Exotel](https://developer.exotel.com/docs/whatsapp-support/template-guidelines)). This could not
    be confirmed on a Meta page, so it is re-checked at release.
  - The company already exposes one public HTTPS host for Meta's webhooks, so short links need no new
    server.
- **Alternatives considered:**
  - A third-party shortener: rejected under Meta's guidance, and it would give click data to
    another company.
  - Serving links from the Next.js app: rejected. The api owns the data and is already public.
    Going through the web app's proxy adds a hop to every click (SC-001).

## R2. Per-recipient links inside templates

- **Decision:**
  - A link is tracked per person when it is one of these:
    - a **URL button** whose address is `${PUBLIC_LINK_BASE_URL}/{{1}}`, where the variable is the
      recipient's code
    - a **body or header variable** used as a link, where the variable's value is the whole short
      link
  - The template editor gets a "Tracked link button" choice that fills the button address with the
    tracking prefix and an example code.
  - Approved templates whose buttons point elsewhere cannot be tracked per person; the campaign
    screen says why (FR-001, spec Assumptions).
  - Codes are 10 random characters from `[0-9A-Za-z]` (about 8.4 × 10^17 values), drawn with
    `crypto.randomInt`. They are unique in the database and carry no data (FR-002, SC-009).
- **Rationale:** Meta allows one variable in a URL button, at the end of the address; an example is
  required; send-time values must be percent-encoded; a template has at most two URL buttons; and
  button order must match the template
  ([Template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md)).
  A 10-character code needs no encoding.
- **Alternatives considered:**
  - Codes derived from message ids or hashes: rejected because they are guessable.
  - One shared link per campaign: rejected because it gives no per-person data.
  - Rewriting links in fixed template text: impossible, because Meta approves the text.

## R3. Clicks, previews and robots

- **Decision:**
  - A request is **not** a click, though it is still redirected, when any of these holds:
    - the method is `HEAD`
    - `Purpose: prefetch` or `Sec-Purpose: prefetch` is set
    - the user agent matches WhatsApp's preview fetcher (`WhatsApp/2…`)
    - the user agent matches another preview or bot fetcher: `facebookexternalhit`, `Facebot`,
      `Twitterbot`, `Slackbot`, `TelegramBot`, `Discordbot`, `LinkedInBot`, `SkypeUriPreview`,
      `Googlebot`, `bingbot` or `Applebot`
    - the user agent has a generic `bot`, `crawler`, `spider`, `preview` or `scanner` token
  - The device kind is `MOBILE` (Android, iPhone, iPad and other mobile tokens), else `DESKTOP`, or
    `OTHER` when the user agent is missing.
  - The client's IP is used only for the rate limit, as a salted hash with a short time to live in
    Redis. It is never stored with a click (FR-003).
- **Rationale:** Meta's link-preview documentation gives WhatsApp's preview user agent as
  `WhatsApp/2.22.20.72 A` (A, i or W for the platform)
  ([Link previews](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/)).
  Other fetchers come from public bot lists. User-agent matching is a weak signal, but the usual
  one, and SC-002 measures it with a mixed test.
- **Alternatives considered:**
  - A JavaScript interstitial page that counts only real browsers: rejected because it slows every
    click and breaks deep links.
  - Counting everything: rejected because previews would inflate counts (FR-004).

## R4. Which failures a retry round may retry

- **Decision:**
  - A failed message goes into a round only when its last failure is in the `TRANSIENT` set of
    `meta-error-classifier.ts`: 130429 throughput, 131000 unknown, 131016 service unavailable,
    133004 server unavailable, 131056 too many messages to the person, or the codes 4 and 80007.
    An HTTP 5xx without a code also counts. The 001 short retries must be used up first.
  - Never retried in a round:
    - 131049, the per-person marketing limit, shown as its own **Held back** group for a retarget
      the next day
    - 131026 undeliverable
    - 131048 sending restricted
    - 131050, the person stopped marketing messages
    - template errors (132xxx)
    - blocking or account errors (`BLOCKING`)
    - opted-out contacts
- **Rationale:**
  - Meta's [error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
    say to retry 130429 and 131000 later, and to confirm 131026 with the user rather than retry.
  - The [per-user marketing limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/)
    page says to wait at least 24 hours before resending after 131049. Earlier retries fail again
    and can block delivery to that person for up to 24 hours. That is outside a 24-hour retry
    window, so the spec now lists these as Held back (FR-014).
- **Alternatives considered:** retrying 131049 inside the window was rejected because it breaks
  Meta's guidance and harms delivery.

## R5. Scheduling retry rounds

- **Decision:**
  - The plan is stored on the campaign: `retry_rounds` (0–3) and `retry_delays_min` (one delay per
    round, from 30, 60, 120, 240, 480 or 720 minutes). It is saved while the campaign is a draft or
    scheduled, and refused when the sum of the delays exceeds 24 hours.
  - When the campaign's first pass is final (every message sent, failed or skipped), round 1 is due
    after the first delay. Each later round is due its delay after the previous round finishes.
  - A round row (`campaign_retry_rounds`) is created when it becomes due. It runs as a delayed
    BullMQ job `campaign-retry-round` on the existing `maintenance` queue (beside `campaign-start`; the `campaign-dispatch` queue has one processor for dispatch ticks). A 30-second sweep in the
    existing schedule reconciler starts due rounds whose job was lost.
  - Running a round:
    - select the campaign's `FAILED` messages with a retryable last failure and
      `retry_round < round`
    - set them back to `PENDING` with `retry_round = round`
    - hand them to the 001 dispatcher
  - The send processor's consent check skips opted-out contacts.
  - A round is skipped with a note when it would start more than 24 hours after launch, or when the
    template is paused or disabled or the number is not connected (FR-017). Pausing the campaign
    holds its rounds; cancelling cancels them.
  - "Recovered" counts the messages a round re-sent that end up `SENT`, `DELIVERED` or `READ`.
- **Rationale:**
  - Only `FAILED` rows are re-sent, and they were never delivered, so nobody gets the message twice
    (001 SC-004).
  - The existing dispatcher, throttling and status webhooks are reused unchanged.
- **Alternatives considered:**
  - Copying failed messages into a new campaign: rejected because it splits the results.
  - Timers per message: rejected because thousands of jobs are hard to cancel.

## R6. Retargeting by click, reply and held-back

- **Decision:**
  - `RetargetStatus` gains `CLICKED`, `NOT_CLICKED`, `REPLIED`, `NOT_REPLIED` and `HELD_BACK`.
  - The 001 RETARGET snapshot (taken at launch) adds SQL for them:
    - Clicked: messages with a click.
    - Not clicked: delivered or read messages without a click.
    - Replied: a customer chat item (002, kind `SESSION_IN`) from that contact on that number
      within 72 hours after `delivered_at`.
    - Not replied: delivered or read without such a reply.
    - Held back: failed with 131049.
  - `GET /campaigns/{id}/retarget-groups` gives the counts before a draft is made (FR-011).
- **Rationale:** this extends 001's retargeting (FR-031) where it already works, with the same
  consent rules and the same snapshot at launch.
- **Alternatives considered:** copying contact ids into the draft when it is created was rejected:
  001 snapshots at launch, and doing it differently here would make two behaviours.

## R7. Running drips: due times in Postgres and a tick

- **Decision:**
  - Each enrolment stores `current_position` and `next_due_at` (index on `(status, next_due_at)`).
  - A repeatable BullMQ job `drip-tick` runs every 30 seconds on a new `drips` queue. It claims due
    enrolments of active drips outside their quiet hours, in batches of 500, with `FOR UPDATE SKIP
    LOCKED`. For each one, in a single transaction, it:
    - checks again the state, consent, blocking and that the contact is not deleted
    - writes the 001 `messages` row (origin `DRIP`) and a `drip_step_sends` row
    - moves the enrolment to the next step and its due time, or finishes it
  - After the commit it hands the messages to the number's send queue through the 001 dispatcher.
  - Quiet hours: due steps are not claimed while the drip's window is closed (company time zone).
- **Rationale:**
  - Pausing, editing, removing steps and leaving are plain updates; there are no per-contact timers
    to find or cancel.
  - The 30-second tick keeps SC-005 (5 minutes) with room to spare.
  - `SKIP LOCKED` lets several workers share the load.
- **Alternatives considered:**
  - A BullMQ delayed job per step: up to 100,000 jobs per drip, and edits or pauses need job
    surgery.
  - A cron per drip: more moving parts.

## R8. Starting events

- **Decision:**
  - An outbox table `drip_events` is written in the same transaction as the triggering change, and
    only when an active drip listens to that kind of event. The triggering changes are:
    - a tag added: the four code paths are the contact create and update, bulk tagging, the 003 flow
      tags step and the import processor
    - consent becoming `OPTED_IN`
    - a contact created by import or by the public API
    - a tracked-link click
  - The tick consumes events before due steps:
    - insert an enrolment for every active drip with a matching trigger, using a partial unique
      index of one `ACTIVE` enrolment per (drip, contact) and the drip's rejoin rule
    - delete the event
  - Events that arrive while no drip is active are not stored, so nothing is replayed (FR-027).
  - Manual enrolment uses the 001 contact filter (`AudienceQueryBuilder`) or chosen ids, in batches
    of 1,000.
- **Rationale:**
  - The outbox commits with the change, so no event is lost and none is invented by a rolled-back
    transaction.
  - The check for an active drip keeps imports cheap.
- **Alternatives considered:**
  - Calling the enroller after commit: events are lost on a crash.
  - A queue job per event: more jobs for the same result.

## R9. Leaving rules

- **Decision:**
  - Leaving events update enrolments directly, in the same transaction as the event:
    - opt-out (001 `ConsentService`)
    - block (002)
    - contact deletion
    - a stop tag (the tag hooks of R8)
    - a reply: the 002 inbound chat handler, for a customer message on the drip's number
    - a click on the drip's own links, when that rule is on
    - removal by a member
  - The tick locks each enrolment row and checks it again before sending. Whichever commits first
    wins, so a step never goes out after a leaving event (SC-006).
- **Rationale:** these hooks already exist for the 003 flows and the 004 AI agent (opt-out, block,
  reply), so the same places gain one statement each.

## R10. Drip messages in live chat and the journey

- **Decision:**
  - `MessageOrigin` gains `DRIP`. Messages get `drip_enrolment_id` and `drip_step_id`.
  - The 002 timeline's message references show drip messages with `ChatOrigin` `AUTOMATIC`, labelled
    "Drip <name> · step n".
  - `JourneyEventType` gains `DRIP_JOINED`, `DRIP_LEFT` (with the reason) and `LINK_CLICKED` (FR-009,
    FR-033).
  - Replies follow the 002–004 paths unchanged (FR-034).

## R11. Results

- **Decision:**
  - Counts are computed when they are read, with SQL:
    - drip step results join `drip_step_sends`, `messages` statuses, `link_clicks` and replies
      (the R6 reply rule, from the step's delivery)
    - campaign click results come from `link_clicks` by campaign
  - Lists are paged, and exports stream CSV like the 001 exports. With these indexes the counts are
    exact (FR-036) and fast enough for 100,000 enrolments:
    - `link_clicks (campaign_id, contact_id)`
    - `link_clicks (drip_step_id, contact_id)`
    - `drip_step_sends (step_id)`
    - `messages (drip_step_id)`
- **Alternatives considered:** counter columns updated on each event were rejected: they drift, and
  SC-008 needs exact numbers.

## R12. Retention, deletion and privacy

- **Decision:**
  - `link_clicks` older than 12 months are purged.
  - `tracked_links` go with their message through a foreign key cascade, so when 001 purges
    messages, their codes stop working (FR-039).
  - Enrolments are kept for 12 months after leaving or finishing.
  - Consumed `drip_events` are deleted at once, and unconsumed ones older than 1 day are purged.
  - Contact deletion: enrolments end with the reason `DELETED` and lose the contact link, and clicks
    lose the contact link (FR-040).
  - Codes and destinations go on the log redaction list (FR-041).

## R13. Permissions, throughput and observability

- **Permissions:** the 001 permissions are reused (FR-037):
  - `campaigns.manage`: tracked links, retry plans, building drips
  - `campaigns.launch`: retargeting, activating, pausing and archiving drips, enrolling and
    removing contacts
  - `campaigns.view`: results, with masked phone numbers for agents
- **Throughput:** drip and retry messages go through the 001 dispatcher with the campaign priority,
  so live chat replies stay first (002 R6). Meta's per-number throughput (80 messages a second by
  default, [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput/))
  and messaging limits apply unchanged.
- **Metrics:**
  - `wbm_link_clicks_total{kind="click"|"preview"}`
  - `wbm_link_redirect_seconds`
  - `wbm_campaign_retry_messages_total{outcome}`
  - `wbm_drip_steps_total{result}`
  - `wbm_drip_enrolments_total{via}`
  - `wbm_drip_due_lag_seconds`
- **Alert:** `WbmDripLagging` fires when the drip due lag p95 is over 5 minutes for 15 minutes.
