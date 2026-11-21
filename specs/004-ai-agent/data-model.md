# Data Model: AI Agent

**Feature**: `004-ai-agent` | **Date**: 2026-11-20 | **Research**: [research.md](./research.md)

Conventions follow 001–003: uuid v7 ids, snake_case tables and columns, `timestamptz`, Prisma
migrations only (one migration, `20261127000000_ai_agent`). The agent configuration document is
specified in [contracts/agent-config.md](./contracts/agent-config.md); the reply JSON in
[contracts/claude-messages.md](./contracts/claude-messages.md).

## 1. New tables

### ai_agents

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | citext, unique among non-deleted agents | 1–80 characters |
| status | enum `AiAgentStatus` (`DRAFT`, `PUBLISHED`, `UNPUBLISHED`) | `DRAFT` = never published |
| draft | jsonb | the editable configuration (contracts/agent-config.md) |
| draft_revision | int, default 0 | +1 on every save; a save with an older revision gets 409 |
| draft_updated_at / draft_updated_by_id | timestamptz / uuid? FK users `SET NULL` | |
| published_version_id | uuid? FK ai_agent_versions | the version customers meet |
| test_numbers | text[] (E.164), at most 3 | FR-035 (check constraint `cardinality <= 3`) |
| starter_key | varchar(40)? | the starter it was created from |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |
| deleted_at | timestamptz? | soft delete, so AI reply history keeps its agent |

### ai_agent_versions

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| agent_id | uuid FK ai_agents `CASCADE` | |
| number | int | 1, 2, 3… per agent |
| config | jsonb | immutable once written |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at | timestamptz | |

Unique `(agent_id, number)`.

### ai_agent_numbers

| Column | Type | Notes |
|---|---|---|
| number_id | uuid PK, FK whatsapp_numbers `CASCADE` | one agent per number (FR-004) |
| agent_id | uuid FK ai_agents `CASCADE` | answers only while the agent is published |
| assigned_by_id | uuid? FK users `SET NULL` | |
| assigned_at | timestamptz | |

### ai_agent_secrets

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| agent_id | uuid FK ai_agents `CASCADE` | |
| name | varchar(60) | label shown in the editor |
| value_encrypted | text | 001 `TokenCipher` (AES-256-GCM), as 003 `flow_secrets` |
| created_by_id / updated_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

API skill headers refer to them as `{secret:<id>}`. Responses show `{id, name, updatedAt}` only;
the value is never returned, logged or sent to the AI service. Deleting one that a draft or
published version uses is refused (`SECRET_IN_USE`). Duplicating an agent copies its secrets.

### ai_knowledge_sources

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| agent_id | uuid FK ai_agents `CASCADE` | |
| kind | enum `AiKnowledgeKind` (`ANSWER`, `WEBSITE`, `FILE`) | |
| title | varchar(200) | question for answers, page or file title otherwise |
| enabled | boolean, default true | FR-003 |
| status | enum `AiKnowledgeStatus` (`PROCESSING`, `READY`, `FAILED`) | answers are `READY` at once |
| error_code / error_message | varchar(40)? / text? | `NO_TEXT`, `PASSWORD_PROTECTED`, `TOO_LARGE`, `BLOCKED_ADDRESS`, `NOT_HTTPS`, `ROBOTS_DISALLOWED`, `FETCH_FAILED`, `UNSUPPORTED_TYPE` |
| question / answer | text? / text? | `ANSWER` only; at most 300 / 2,000 characters |
| replace_me | boolean, default false | example answers from a starter (FR-005) |
| url | text? | `WEBSITE` start address (HTTPS) |
| refresh_weekly | boolean, default false | `WEBSITE` only |
| pages_read | int? | `WEBSITE` only; at most 100 |
| storage_key / file_name / mime_type / size_bytes / sha256 | text? / text? / text? / int? / char(64)? | `FILE` only; at most 20 MB |
| char_count / chunk_count | int, default 0 | sizes of the processed text |
| last_refreshed_at | timestamptz? | |
| created_by_id | uuid? FK users `SET NULL` | |
| created_at / updated_at | timestamptz | |

Indexes: `(agent_id, kind)`; unique `(agent_id, sha256)` where `sha256 IS NOT NULL`. Limits per
agent (FR-011): 500 answers, 5 websites, 50 files, checked in the service.

### ai_knowledge_chunks

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| source_id | uuid FK ai_knowledge_sources `CASCADE` | |
| agent_id | uuid | copied from the source, for search |
| position | int | order within the source |
| title | text | source title |
| heading | text? | nearest heading path |
| url / page | text? / int? | page address for websites, page number for PDFs |
| text | text | about 1,500 characters |
| tsv | tsvector, generated stored | `setweight(to_tsvector('english', title ‖ heading), 'A') ‖ setweight(to_tsvector('english', text), 'B') ‖ to_tsvector('simple', text)` |
| created_at | timestamptz | |

Indexes: GIN on `tsv`; `(agent_id)`; `(source_id, position)`. A source's chunks are replaced in one
transaction when it is processed again. Prisma maps `tsv` as `Unsupported("tsvector")`; searches
use `$queryRaw`.

### ai_conversations

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid FK conversations `CASCADE` | the 002 chat |
| agent_id | uuid FK ai_agents `CASCADE` | |
| version_id | uuid? FK ai_agent_versions `SET NULL` | last version that answered; null for draft (test) turns |
| contact_id | uuid? FK contacts `SET NULL` | null after contact erasure |
| number_id | uuid FK whatsapp_numbers `CASCADE` | |
| test | boolean | a test number talking to the draft |
| started_by | enum `AiStartedBy` (`CUSTOMER`, `FLOW`) | `FLOW` = a Hand to AI agent step |
| status | enum `AiConversationStatus` (`ACTIVE`, `ENDED`) | |
| result | enum `AiConversationResult`? | see the state machine |
| replies | int, default 0 | AI replies sent in this conversation (reply cap, FR-023) |
| last_handled_at | timestamptz? | time of the last customer message a reply covered |
| pending_confirmation | jsonb? | `{skillId, inputs, askedAt}` for a skill that changes data |
| unanswered_streak | jsonb? | the last question the agent could not answer (repeat rule, FR-023) |
| summary | text? | hand-over summary |
| started_at / last_activity_at / ended_at | timestamptz | started_at is the first customer message the first reply covered; history reaches back to it |

Partial unique index: one `ACTIVE` row per `conversation_id`. Index `(status, last_activity_at)`
for expiry.

### ai_replies

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ai_conversation_id | uuid FK ai_conversations `CASCADE` | |
| chat_message_id | uuid? FK chat_messages `SET NULL` | the message it produced; null for previews |
| agent_id / version_id / number_id | uuid / uuid? / uuid? | |
| kind | enum `AiReplyKind` (`REPLY`, `HANDOVER`, `FALLBACK`, `LIMIT`) | `FALLBACK` and `LIMIT` are fixed texts |
| test | boolean | |
| counted | boolean | true for `REPLY` and `HANDOVER` (FR-036) |
| language | varchar(10)? | |
| sources | jsonb | `[{id, kind, title}]` the knowledge used |
| skills | jsonb | `[{skillId, name, outcome}]`, never input values |
| model | varchar(60) | |
| input_tokens / cache_read_tokens / cache_write_tokens / output_tokens | int | summed over the turn's calls |
| cost_micros | bigint | USD × 1,000,000 at the prices in force |
| duration_ms | int | message received to reply queued |
| created_at | timestamptz | |

### ai_unanswered_questions and ai_unanswered_asks

| ai_unanswered_questions | Type | Notes |
|---|---|---|
| id | uuid PK | |
| agent_id | uuid FK ai_agents `CASCADE` | |
| text | varchar(300) | the agent's short, generic description of what was missing |
| normalized | varchar(300) | lower case, punctuation removed; unique per agent while open |
| ask_count | int | recomputed from asks |
| first_asked_at / last_asked_at | timestamptz | |
| resolved_at / resolved_by_id | timestamptz? / uuid? | answered or dismissed (FR-015) |

| ai_unanswered_asks | Type | Notes |
|---|---|---|
| question_id | uuid FK ai_unanswered_questions `CASCADE` | |
| ai_conversation_id | uuid FK ai_conversations `CASCADE` | links the ask to a contact, for erasure |
| asked_at | timestamptz | |

### ai_usage_daily

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| day | date | in the company time zone |
| kind | enum `AiUsageKind` (`REPLY`, `PREVIEW`, `ASSISTANT`) | |
| agent_id / number_id | uuid? / uuid? | null for assistant rows |
| test | boolean | |
| count | int | AI replies, preview turns or assistant requests |
| input_tokens / cache_read_tokens / cache_write_tokens / output_tokens | bigint | |
| cost_micros | bigint | |

Unique index on `(day, kind, coalesce(agent_id, zero uuid), coalesce(number_id, zero uuid), test)`;
rows are upserted in the apply transaction.

### ai_usage_months

| Column | Type | Notes |
|---|---|---|
| month | date PK | first day, company time zone |
| replies | int, default 0 | AI replies including tests, against the reply limit |
| assistant_requests | int, default 0 | against the assistant limit |
| reply_alert_level / assistant_alert_level | smallint, default 0 | 0, 80 or 100: alerts already sent (FR-038) |

### assistant_requests

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK users `CASCADE` | |
| prompt | text | at most 2,000 characters |
| status | enum `AssistantRequestStatus` (`QUEUED`, `RUNNING`, `DONE`, `FAILED`) | |
| reply | text? | the assistant's answer |
| drafts | jsonb | `[{kind: TEMPLATE|FLOW|CAMPAIGN, id, name}]` |
| error_code | varchar(40)? | `LIMIT_REACHED`, `AI_UNAVAILABLE`, `REFUSED` |
| input_tokens / cache_read_tokens / cache_write_tokens / output_tokens / cost_micros | int / bigint | |
| created_at / finished_at | timestamptz | |

### assistant_actions

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| request_id | uuid FK assistant_requests `CASCADE` | |
| user_id | uuid FK users `CASCADE` | only this member may confirm |
| kind | enum `AssistantActionKind` (`SEND_CAMPAIGN`, `SCHEDULE_CAMPAIGN`, `DELETE_CONTACTS`, `DELETE_TAGS`) | |
| params | jsonb | what will run (campaign id and time, ids to delete) |
| preview | jsonb | what the member sees: items, recipient count, estimated cost in USD |
| status | enum `AssistantActionStatus` (`PENDING`, `CONFIRMED`, `CANCELLED`, `EXPIRED`, `FAILED`) | |
| expires_at | timestamptz | 30 minutes after creation |
| decided_at | timestamptz? | |
| result | jsonb? | outcome or error code |
| created_at | timestamptz | |

## 2. Changed tables and enums

- **settings**: `ai_reply_limit int default 1000`, `ai_assistant_limit int default 300`,
  `ai_prices jsonb` (USD per million tokens: `{model, input, output, cacheRead, cacheWrite}`,
  default the Opus 5.5 rates 4 / 20 / 0.20 / 5), `ai_limit_message text null`.
- **ConsentSource** + `AI_AGENT` (opt-out recorded by the agent, FR-027).
- **NotificationType** + `AI_USAGE`, `AI_FAILING`.
- **JourneyActor** + `AI_AGENT`; **JourneyEventType** + `AI_STARTED`, `AI_ENDED` (journey entries
  when an agent starts and stops answering a chat, as flows have).
- **FlowSessionResult** + `HANDED_TO_AI`; **FlowStartedBy** + `AI_AGENT`.
- **chat_messages** + `ai_pending boolean not null default false` with a partial index on
  `conversation_id` where it is true: the AI router flags each customer message it queues a turn for,
  and the turn that answers or drops them clears the flag (research R5). WhatsApp times have
  one-second precision and can arrive out of order, so turns never pick messages by time.
- **chat_messages.payload** for AI replies (no schema change): `payload.ai = {agentId, agentName,
  versionId, aiConversationId, sources: [{id, kind, title}], skills: [{skillId, name, outcome}],
  test}`.
- **Flow graph** (packages/shared): new step `aiAgent` (`agentId`, optional `openingMessage` up to
  1,024 characters); it has no next step. Publishing refuses it with `AGENT_NOT_PUBLISHED` when the
  agent is not published.
- **Permissions** (packages/shared/permissions.ts): `ai.manage` (ADMIN, MANAGER), `ai.usage`
  (ADMIN), `assistant.use` (ADMIN, MANAGER).

## 3. AI conversation state machine

```text
(customer message, number's agent eligible)        (flow step "Hand to AI agent")
                 │                                               │
                 ▼                                               ▼
              ACTIVE  ──────── reply sent (replies + 1, last_handled_at) ──┐
                 │  ◄──────────────────────────────────────────────────────┘
                 ├── agent hands over / reply cap / repeat unanswered ──► ENDED (HANDED_OVER)
                 ├── chat moved to Waiting for agent by a keyword or flow ─► ENDED (HANDED_OVER)
                 ├── member takes, replies, sends a template, starts a flow ► ENDED (MEMBER_TOOK)
                 ├── chat closed (002 resolve) ──────────────────────────► ENDED (CLOSED)
                 ├── 24 h without messages ───────────────────────────────► ENDED (EXPIRED)
                 ├── monthly limit reached ───────────────────────────────► ENDED (LIMIT_REACHED)
                 ├── AI service failed (fallback sent, handed over) ──────► ENDED (FAILED)
                 ├── opt-out (keyword or clear request) ──────────────────► ENDED (OPTED_OUT)
                 ├── contact blocked ─────────────────────────────────────► ENDED (BLOCKED)
                 └── agent unpublished or deleted ───────────────────────► ENDED (UNPUBLISHED)
```

A flow started by the agent (`startFlow`) leaves the AI conversation `ACTIVE`: while the flow runs
it answers first, and when it ends the agent continues (FR-032). The usage page groups results as:
answered by the agent (`CLOSED` or `EXPIRED` with at least one reply), handed over, member took
over, limit reached, error (`FAILED`), other.

## 4. Validation rules (from the spec)

- Agent config: see contracts/agent-config.md (goal required, at least one reply language, at
  most 20 guardrails, 20 hand-over topics, 20 shared media, 20 fillable attributes, 10 API skills,
  10 flow skills; reply cap 5–100; maximum reply length 100–1,000 characters).
- Publish checks (FR-005): `NO_GOAL`, `NO_LANGUAGE`, `SKILL_WITHOUT_DESCRIPTION`, API skill 003
  checks (`NOT_HTTPS`, `UNKNOWN_SECRET`, …), `MEDIA_NOT_FOUND`, `UNKNOWN_ATTRIBUTE`,
  `ATTRIBUTE_TYPE`, `FLOW_NOT_PUBLISHED`, `REPLACE_ME_LEFT`.
- Number assignment: only one agent per number; assigning a number that has another agent needs
  `replace: true`, else 409 `NUMBER_HAS_AGENT`.
- Knowledge: answer question ≤ 300 and answer ≤ 2,000 characters; websites HTTPS only; files PDF
  or DOCX up to 20 MB; per-agent limits as above.
- Reply (contracts/claude-messages.md): message ≤ the agent's maximum length (≤ 1,024 with media);
  ≤ 3 buttons of ≤ 20 characters; list ≤ 10 rows (titles ≤ 24, descriptions ≤ 72, button ≤ 20);
  media and flow IDs from the version's skills; remembered keys from the allowed attributes, values
  of the attribute's type, never card, bank or ID numbers.

## 5. Retention and erasure

- 12 months (the 001 retention job): ended AI conversations with their replies and unanswered
  asks; assistant requests with their actions. Usage rows are anonymous and kept.
- Contact deletion (FR-051): AI conversations of the contact lose `contact_id`, `summary` and
  `pending_confirmation`; their unanswered asks are deleted and question counts recomputed;
  remembered values disappear with the contact's attributes; AI replies keep only counts and
  sources.
- Knowledge files are deleted from object storage when their source is deleted.
