# Research: Chatbot Flow Builder

**Feature**: `003-chatbot-flow-builder` | **Date**: 2026-11-20 | **Plan**: [plan.md](./plan.md)

Each item gives the decision, why, and what else was considered. Facts about WhatsApp come from the
public Cloud API reference and a typed client that mirrors it; re-check them against Meta's current
reference before release, as 001 and 002 did.

## R1. How a flow is stored

- **Decision:**
  - `flows` holds the flow's settings and its **draft graph** (JSON) with a `draft_revision`
    counter for optimistic saves.
  - `flow_versions` holds **published versions** (numbered, immutable) and **revisions** (autosave
    snapshots; only the last 20 per flow are kept, FR-005).
  - The graph format is defined once in `packages/shared` (zod schema + TypeScript types), used by
    the editor for instant checks and by the API as the authority (contracts/flow-graph.md).
- **Rationale:** a flow is edited and published as one document; sessions point at an immutable
  version, so running sessions are unaffected by later edits (FR-004).
- **Alternatives:** one table row per step and branch (many writes per autosave, harder to version);
  event sourcing of edits (more than the spec needs).

## R2. Triggers and matching

- **Decision:**
  - On publish, the triggers of the new version are written to `flow_triggers` (keyword phrases
    already normalised: lower case, single spaces, trimmed). Unpublishing deletes them.
  - The inbound handler queries `flow_triggers` for the message's number on every customer
    message (no worker cache: 002 showed that a cache in the worker misses changes made in the app).
  - Order (FR-020): exact keyword → contains (longest phrase first) → pattern → template button;
    ties by flow priority, then oldest flow. First-message rules apply only to a contact's first
    ever inbound message, before the other triggers, and may also set the first-message tag.
  - Test numbers (FR-034) match against the **draft** triggers of flows that list the sender as a
    test number; those are evaluated in memory from the draft graph.
- **Rationale:** one indexed query per inbound message is cheap at our volume (a few thousand
  messages a day) and always current.
- **Alternatives:** an in-memory trie per worker with pub/sub invalidation (fast but adds a cache to
  keep in sync); matching in the browser (not possible).

## R3. Pattern triggers without slowing the worker

- **Decision:** patterns are limited to 200 characters, checked at save time for nested quantifiers
  (a "safe pattern" rule that rejects constructs like `(a+)+`), and evaluated inside
  `vm.runInNewContext` with a 25 ms timeout. A timeout counts as "no match" and is logged with the
  trigger id. A unit test proves a catastrophic pattern returns within the limit.
- **Rationale:** managers write their own patterns (inventory 7.2), and one bad pattern must not
  stall message handling.
- **Alternatives:** the native `re2` module (linear time, but a native build in every image);
  a worker thread per match (heavier); forbidding patterns (loses a documented trigger type).

## R4. Sessions and the engine

- **Decision:**
  - `flow_sessions` holds one row per session with `status` (`RUNNING`/`ENDED`), `result`,
    `current_step_id`, `wait` (none, input, delay, api), a `wait_token` that increases on every move,
    `answers` (JSON), retry and step counters. A partial unique index allows one `RUNNING` session
    per conversation (contact + number, FR-024).
  - The engine is a pure step interpreter (`engine/run.ts`): given a session, a version graph and an
    input (customer message, button choice, timer, API result), it returns the next state and a list
    of effects (send message, set tags, set attributes, hand over, schedule timer, call API, end).
    The service applies the effects in one transaction under a per-conversation advisory lock.
  - The engine runs steps until it needs the customer (question, buttons, list), a timer (delay,
    question timeout) or an API reply, or the session ends. 50 steps without customer input end the
    session (FR-033).
- **Rationale:** a pure interpreter is easy to unit test for every step type and branch; the lock and
  the unique index make "one session per contact" hold under concurrent webhooks (SC-004).
- **Alternatives:** a generic workflow engine (Temporal, BPMN): far beyond the spec and a new service;
  running steps in the web request: violates "queue-only sending".

## R5. Where flows sit in the inbound pipeline

- **Decision:** the 002 `InboundChatHandler` calls `FlowRouter.onCustomerMessage()` after the message
  is stored and after consent and "talk to a person" handling, and before welcome/off-hours:
  1. Blocked contact → nothing (the handler already returns early).
  2. Opt-out keyword → end any session with result `OPTED_OUT`; no reply (001 consent first).
  3. "Talk to a person" keyword → end the session with `HANDED_OVER`; 002 moves the chat to
     Waiting for agent.
  4. Chat not Open (Waiting for agent / Taken) → only a member-started session continues (FR-025).
  5. Running session → the message is its input, unless it matches a "can interrupt" trigger.
  6. Otherwise match triggers and start a session.
  7. If a flow started or continued, skip welcome and off-hours messages (FR-029).
- Member actions in 002 (`take`, replies, templates) call `FlowSessions.stopForConversation()`, which
  ends a running session with `STOPPED_BY_MEMBER` (FR-026). Starting a flow from the chat (FR-031) is a
  new endpoint that creates a session with `started_by = MEMBER`.
- **Rationale:** keeps all routing for a customer message in one place, in the order the market
  leader documents (active flow session → inbox).
- **Alternatives:** a separate webhook handler for flows (two handlers racing on the same message).

## R6. Sending flow messages

- **Decision:**
  - Flow messages are `chat_messages` rows (`SESSION_OUT`, origin `AUTOMATIC`, payload with
    `flowId`, `flowName`, `sessionId`, `stepId`), sent through the 002 session send path on the
    number's queue with chat priority (FR-030). Interactive messages add two content types, `BUTTONS`
    and `LIST`; the 002 send processor builds the Graph `interactive` payload for them.
  - Messages produced by one engine run are queued with increasing delays (0 s, 1 s, 2 s, …) so they
    arrive in order (edge case "steps sent too fast").
  - The 24-hour window is checked when the engine plans a send and again by the send processor
    (002); a closed window ends the session with `WINDOW_CLOSED` (FR-028).
- **Rationale:** reuses the tested 002 path (claim-before-send, retries, ticks, timeline, metrics).
- **Alternatives:** a separate flow send queue (duplicates rate limits and status handling).

## R7. WhatsApp interactive messages (Graph API v27)

- **Decision:** limits enforced by the shared graph schema (FR-008):
  - Reply buttons: body 1–1024 characters, optional text header ≤ 60 and footer ≤ 60, 1–3 buttons,
    title 1–20, id 1–256.
  - Lists: body 1–1024 (Meta allows more for lists; we keep one limit for both), list button label
    1–20, 1–10 sections with optional title ≤ 24, at most 10 rows in total, row title 1–24, row
    description ≤ 72, row id ≤ 200.
  - Button and row ids carry `s:<sessionId>:<waitToken>:<optionKey>`, so a stale button (the session
    moved on) is recognised and treated as a normal message (edge case).
  - Inbound replies arrive as `interactive.button_reply {id, title}` and `interactive.list_reply
    {id, title, description}`; 002's parser already stores them as `BUTTON_REPLY` / `LIST_REPLY`.
  - Template quick-reply taps arrive as `type: button` with `button.text`, `button.payload` and
    `context.id` (the wamid of the template message). The template-button trigger finds the template
    through `context.id` → `messages.wa_message_id` → template, then matches the button text.
- **Alternatives:** plain numbered text menus ("reply 1, 2 or 3"): worse experience; still possible
  with a question step.

## R8. Questions, validation and answers

- **Decision:** validators are pure functions in `packages/shared/flows/answers.ts`:
  - text (length), number (decimal, min/max), email (practical pattern), phone (libphonenumber-js
    with the company default country, as 001 contacts), date (day/month/year in several written
    forms, ISO, "today"/"tomorrow"; earliest/latest), choice (buttons or list id).
  - An answer is saved to the session (`answers[name]`) and, when mapped, to a contact attribute of
    a compatible type (TEXT, NUMBER, DATE, BOOLEAN from 001); publishing refuses incompatible
    mappings (FR-003).
- **Alternatives:** an AI parser for free answers (feature 007).

## R9. Variables in texts

- **Decision:** reuse the 002 saved-reply renderer and its syntax (`{first_name}`, `{last_name}`,
  `{name}`, `{phone}`, `{attr:key}`), add `{answer:name}`, and keep per-step fallbacks
  (`fallbacks: {"attr:city": "there"}`) like saved replies. A missing value without a fallback
  renders as empty (FR-017).
- **Rationale:** one syntax across the product; members already know it.

## R10. Delays, question timeouts and expiry

- **Decision:** a new BullMQ queue `flows` with delayed jobs `flow-timer {sessionId, waitToken}` for
  delays and question timeouts. On fire, the engine runs only if the session's token still matches
  (otherwise the timer is stale and ignored). A maintenance job every 5 minutes ends sessions with no
  activity for 24 hours (`EXPIRED`, FR-032).
- **Rationale:** BullMQ already persists delayed jobs in Redis; tokens make late or duplicate timers
  harmless.
- **Alternatives:** polling `flow_sessions` every few seconds for due timers (more database load).

## R11. API steps

- **Decision:**
  - The engine pauses at an API step and queues `flow-api {sessionId, waitToken}` on the `flows`
    queue; the job makes the call and resumes the session with the result. The inbound worker never
    waits on outside systems.
  - Requests use Node's own `https` client with a DNS `lookup` that rejects private, loopback,
    link-local, multicast and reserved IPv4/IPv6 ranges at connect time (no DNS-rebinding gap;
    address literals are checked before connecting), HTTPS only, no redirects, timeout 1–10 s,
    response cap 100 KB, JSON replies only for mapping. (Planned with an undici `Agent`; Node's
    client gives the same connect-time check without adding an HTTP library to the API.)
  - Mapping uses simple dotted paths (`order.status`, `items.0.name`) into named answers.
  - Secret header values live in `flow_secrets`, encrypted with 001's `TokenCipher`, referenced from
    the graph as `{secret:<id>}` and shown as `••••` after saving (FR-015). Values never enter logs,
    analytics, exports or the graph JSON.
  - The editor's **Test request** goes through the same client, with sample values.
- **Alternatives:** calling from the inbound worker (blocks message handling for up to 10 s); allowing
  plain HTTP (credentials in clear text).

## R12. Analytics

- **Decision:** `flow_session_steps` records each step a session enters (`entered_at`) and how it left
  (`branch`, `left_at`), skipping test sessions. Counts per period (company time zone, as the 002
  team view) come from SQL over these rows and `flow_sessions.result`:
  - entered = rows for the step; continued = rows that left by a branch to another step;
    dropped = sessions that ended while at the step with a result other than completed or handed
    over; per-option counts = rows grouped by `branch`.
  - The CSV of dropped contacts joins sessions to contacts (FR-036).
- **Alternatives:** counters in Redis (fast but drift from the session records, failing SC-005).

## R13. The editor (web)

- **Decision:** `@xyflow/react` (React Flow) **12.12.1** for the canvas: nodes, handles, edges, zoom,
  minimap and selection. It is the newest release at least 2 weeks old (13.0.x appeared on
  2026-11-16). Step forms are ordinary React panels; the draft autosaves 1 s after the last change
  with the `draft_revision` check (two editors → the second gets a conflict and reloads).
- **Rationale:** a mature MIT library that handles hundreds of nodes (SC-006); building a canvas from
  scratch would take weeks.
- **Alternatives:** a form-based "list of steps" editor (simpler, but the spec asks for a canvas);
  other diagram libraries (less focused on node editors).

## R14. Loops and publish checks

- **Decision:** the shared validator walks the graph: unreachable steps, unconnected required
  branches, missing content, limits, attribute existence and types, duplicate exact keywords per
  number against other published flows (server side), and cycles that contain no waiting step
  (question, buttons, list, delay). Jumps are followed into the target flows' published graphs.
- **Rationale:** catches the common mistakes before customers meet them (SC-007).

## R15. Retention, erasure and audit

- **Decision:** the 001 retention job deletes ended sessions and their step rows after 12 months;
  contact deletion clears `answers` and `contact_id` on the contact's sessions (counts stay, FR-040).
  Audit actions: `flow.created`, `flow.updated` (name, numbers, priority), `flow.duplicated`,
  `flow.deleted`, `flow.published`, `flow.unpublished`, `flow.restored`, `flow.test_numbers_updated`,
  `flow.secret_changed`, with ids and names only (FR-039).

## R16. Permissions

- **Decision:** a new permission `flows.manage` (ADMIN, MANAGER) for building, testing, publishing,
  analytics and secrets. Starting a published flow from a chat and listing published flows use the
  existing `inbox.reply` (all roles), within 002's visibility rules.

## R17. mock-meta and tests

- **Decision:** mock-meta accepts `type: interactive` sends (buttons and lists) and returns wamids and
  statuses like other free-form sends; its inbound CLI gets `--button-id`, `--list-id` and
  `--context <wamid>` so tests can tap buttons and template replies. API steps are tested with nock
  intercepting HTTPS requests to public test host names (nock also intercepts `fetch`), and the
  private-network guard is unit-tested on its own with IPv4 and IPv6 cases.
