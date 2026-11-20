# Data Model: Chatbot Flow Builder

**Feature**: `003-chatbot-flow-builder` | **Date**: 2026-11-20 | **Research**: [research.md](./research.md)

Conventions follow 001 and 002: uuid v7 ids, snake_case tables and columns, `timestamptz`, Prisma
migrations only. The graph JSON format is specified in [contracts/flow-graph.md](./contracts/flow-graph.md).

## 1. New tables

### flows

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext, unique among non-deleted flows | 1–80 characters |
| status | enum `FlowStatus` (`DRAFT`, `PUBLISHED`, `UNPUBLISHED`) | `DRAFT` = never published |
| priority | int, default 100 | lower runs first when triggers tie (FR-020) |
| all_numbers | boolean, default true | serves every connected number |
| published_version_id | uuid? FK flow_versions | the version customers meet |
| draft | jsonb | the editable graph (contracts/flow-graph.md) |
| draft_revision | int, default 0 | +1 on every save; a save with an older revision gets 409 |
| draft_updated_at / draft_updated_by_id | timestamptz / uuid? FK users `SET NULL` | |
| test_numbers | text[] (E.164), at most 3 | FR-034 (check constraint `cardinality <= 3`) |
| starter_key | varchar(40)? | the starter it was created from |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |
| deleted_at | timestamptz? | only for `DRAFT`/`UNPUBLISHED` flows; history stays for analytics |

### flow_numbers

| Column | Type | Notes |
|---|---|---|
| flow_id | uuid FK flows `CASCADE` | |
| number_id | uuid FK whatsapp_numbers `CASCADE` | |

PK `(flow_id, number_id)`; used when `all_numbers = false`.

### flow_versions

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| flow_id | uuid FK flows `CASCADE` | |
| kind | enum `FlowVersionKind` (`PUBLISHED`, `REVISION`) | revisions are autosave snapshots |
| number | int? | 1, 2, 3… for `PUBLISHED`; null for revisions |
| graph | jsonb | immutable once written |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at | timestamptz | |

Unique `(flow_id, number)` where `kind = 'PUBLISHED'`. Only the latest 20 `REVISION` rows per flow
are kept (pruned on insert).

### flow_triggers

Written on publish from the published graph; deleted on unpublish or when replaced.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| flow_id | uuid FK flows `CASCADE` | |
| flow_version_id | uuid FK flow_versions `CASCADE` | |
| trigger_key | varchar(40) | the trigger's id inside the graph |
| kind | enum `FlowTriggerKind` (`KEYWORD`, `PATTERN`, `TEMPLATE_BUTTON`, `FIRST_MESSAGE`) | manual starts need no row |
| match | enum `KeywordMatch` (`EXACT`, `CONTAINS`)? | keywords and first-message rules |
| phrase | varchar(200)? | normalised (lower case, single spaces, trimmed) |
| pattern | varchar(200)? | pattern triggers |
| template_id | uuid? FK templates `CASCADE` | template-button triggers |
| button_text | varchar(25)? | the quick-reply button's text |
| first_message_tag_id | uuid? FK tags `SET NULL` | first-message rules |
| start_flow | boolean, default true | a first-message rule may only set the tag |
| answer_name | varchar(40)? | pattern triggers can store the matched text as an answer |
| can_interrupt | boolean, default false | FR-022 |

Indexes: `(kind, phrase)`, `(template_id, button_text)`.

### flow_sessions

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| flow_id | uuid FK flows | |
| flow_version_id | uuid? FK flow_versions | null for test sessions running a draft |
| conversation_id | uuid FK conversations `CASCADE` | one chat = contact + number |
| contact_id | uuid? FK contacts `SET NULL` | null after erasure |
| number_id | uuid FK whatsapp_numbers | |
| status | enum `FlowSessionStatus` (`RUNNING`, `ENDED`) | |
| result | enum `FlowSessionResult`? | `COMPLETED`, `HANDED_OVER`, `TIMED_OUT`, `STOPPED_BY_MEMBER`, `OPTED_OUT`, `INTERRUPTED`, `WINDOW_CLOSED`, `SEND_FAILED`, `FLOW_UNPUBLISHED`, `EXPIRED`, `BLOCKED`, `FAILED` |
| failure_reason | varchar(120)? | e.g. "too many steps", "API failed and no branch" |
| current_step_id | varchar(40)? | step key inside the graph |
| wait | enum `FlowWait` (`NONE`, `INPUT`, `DELAY`, `API`) | |
| wait_token | int, default 0 | +1 on every move; timers and buttons carry it |
| wait_until | timestamptz? | question timeout or delay end |
| retries | int, default 0 | invalid answers at the current question |
| steps_since_input | int, default 0 | ends the session at 50 (FR-033) |
| answers | jsonb, default `{}` | `{name: value}`; cleared on erasure |
| is_test | boolean | FR-034 |
| started_by | enum `FlowStartedBy` (`TRIGGER`, `MEMBER`, `JUMP`) | |
| started_by_user_id | uuid? FK users `SET NULL` | member starts |
| trigger_key | varchar(40)? | |
| parent_session_id | uuid? | the session that jumped here |
| started_at / last_activity_at / ended_at | timestamptz | |

Indexes: **partial unique** `(conversation_id) WHERE status = 'RUNNING'` (one running session per
chat); `(status, last_activity_at)` for expiry; `(flow_id, started_at)` for analytics.

### flow_session_steps

| Column | Type | Notes |
|---|---|---|
| id | bigint identity PK | |
| session_id | uuid FK flow_sessions `CASCADE` | |
| flow_id / flow_version_id | uuid | copied for analytics queries |
| step_id | varchar(40) | |
| entered_at | timestamptz | |
| left_at | timestamptz? | |
| branch | varchar(60)? | the branch it left by (`next`, `yes`, an option key, `invalid`, `timed_out`, `failed`…) |

Index `(flow_id, flow_version_id, step_id, entered_at)`. Test sessions are not recorded.

### flow_secrets

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| flow_id | uuid FK flows `CASCADE` | |
| name | varchar(60) | label shown in the editor |
| value_encrypted | text | 001 `TokenCipher` (AES-256-GCM) |
| created_by_id / updated_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

API responses show `{id, name, updatedAt}` only; the value is never returned.

## 2. Changes to existing tables

| Table | Change | Why |
|---|---|---|
| `chat_messages` | enum `ChatContentType` += `BUTTONS`, `LIST`; flow messages carry `payload.flow = {flowId, flowName, sessionId, stepId, test}`; the note check allows `origin = AUTOMATIC` notes (hand-over notes) | interactive sends, the "automatic · flow name" label (FR-030) and hand-over notes (FR-027) |
| `conversation_events` | enum `JourneyEventType` += `FLOW_STARTED`, `FLOW_ENDED`; enum `JourneyActor` += `FLOW` | journey entries for flow starts/ends and for tag/attribute changes made by flows (FR-010, FR-011) |
| `audit_logs` | new actions listed in research R15 | FR-039 |
| permissions (shared) | `flows.manage` (ADMIN, MANAGER) | FR-038 |

## 3. Session state machine

```
            start (trigger / member / jump)
                      │
                      ▼
   ┌──────────── RUNNING ─────────────┐
   │  wait = NONE → run steps          │
   │  wait = INPUT (question/buttons/list) ── customer message ──► validate → next step
   │  wait = DELAY ── timer(token) ──► next step                                   
   │  wait = API ── api result(token) ──► success / failed branch                  
   └───────────────────────────────────┘
                      │ end step, last step, hand-over, or a stop condition
                      ▼
                    ENDED (result)
```

Stop conditions and results:

| Event | Result |
|---|---|
| End step or a branch with nothing after it | `COMPLETED` |
| Hand-over step, or "talk to a person" keyword | `HANDED_OVER` |
| Question timeout with no "timed out" branch | `TIMED_OUT` |
| Member takes the chat or sends a reply/template (except in a member-started session where the member already owns the chat: their reply still stops it) | `STOPPED_BY_MEMBER` |
| Opt-out keyword | `OPTED_OUT` |
| A "can interrupt" trigger starts another flow | `INTERRUPTED` |
| A send planned after the 24-hour window | `WINDOW_CLOSED` |
| A send failed permanently | `SEND_FAILED` |
| The flow is unpublished | `FLOW_UNPUBLISHED` |
| 24 hours without activity | `EXPIRED` |
| The contact is blocked while a session runs | `BLOCKED` |
| 50 steps without input, or an internal error | `FAILED` |
| Buttons or list step gets a typed answer that is not an option and has no "other answer" branch | `FAILED` (reason `no valid answer`) |

A jump ends the current session with `COMPLETED` (branch `jumped`) and starts a session in the target
flow with `started_by = JUMP` and `parent_session_id`.

## 4. Validation rules (enforced on publish; most also live in the editor)

- Graph limits: at most 200 steps (FR-018); step ids unique; exactly one start step.
- Every step except end/hand-over/jump has its required branches connected; optional branches
  ("timed out", "invalid") end the session when unconnected.
- Messages: text and/or one library media file; WhatsApp limits from research R7.
- Questions: answer name unique in the flow; attribute mapping must exist with a compatible type.
- Triggers: phrases 1–200 characters; reserved keywords (opt-out, opt-in, "talk to a person") refused;
  no exact keyword shared with another published flow on an overlapping number; patterns pass the
  safe-pattern check; template buttons must exist on an approved template.
- API steps: HTTPS URL; method in GET/POST/PUT/PATCH/DELETE; timeout 1–10 s; secrets referenced by
  id must belong to the flow.
- Loops: no cycle without a waiting step, following jumps into published targets.

## 5. Retention and erasure

- Retention (001 job, daily): ended `flow_sessions` (and their `flow_session_steps`) older than 12
  months are deleted; deleted flows with no sessions left are removed.
- Contact deletion: the contact's sessions get `answers = '{}'` and `contact_id = NULL`; counts stay.
