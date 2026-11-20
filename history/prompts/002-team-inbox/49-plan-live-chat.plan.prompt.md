---
id: 49
title: Plan Live Chat
stage: plan
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 002-team-inbox
branch: 002-team-inbox
user: Muhammad Yaseen
command: /sp.plan
labels: ["plan", "live-chat", "sse", "redis-streams", "web-push", "aisensy-parity"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/002-team-inbox/spec.md (revised to the AiSensy live-chat model; FR-036 opt-out gate)
 - specs/002-team-inbox/checklists/requirements.md
 - specs/002-team-inbox/plan.md
 - specs/002-team-inbox/research.md
 - specs/002-team-inbox/data-model.md
 - specs/002-team-inbox/quickstart.md
 - specs/002-team-inbox/contracts/inbox-api.openapi.yaml
 - specs/002-team-inbox/contracts/realtime-events.md
 - specs/002-team-inbox/contracts/meta-graph-inbox.md
 - CLAUDE.md (agent context)
tests:
 - redocly lint inbox-api.openapi.yaml: valid
---

## Prompt

shuruuu karooo

## Response snapshot

- **Spec revision:** rewrote the 002 spec to AiSensy's documented live-chat flow:
  - Active, Requesting and Intervened states, and History after 24 h
  - Intervene/Resolve, transfer, auto-resolve and agent rules
  - canned messages with media, favourites and a limit of 200, plus a media library
  - welcome and off-hours messages, blocking, sound and push notifications, and the customer journey
  - Result: 8 stories, 42 FRs, 9 SCs.
- **Constitution gate:** the Principle I check added "no automatic messages to opted-out contacts".
- **/sp.plan:**
  - **research.md (R1–R18):**
    - SSE through the Next.js proxy, with Redis Stream replay
    - separate chat tables, with reference rows to 001 messages
    - free-form replies at priority 1 on the per-number send queues
    - asynchronous inbound media download, and a derived 24 h window with jobs
    - an atomic intervene and a single visibility predicate
    - Web Push with presence, openings for metrics, and Graph v27 payloads
  - **data-model.md:** 9 new tables, 5 altered, the state machine and the event envelope.
  - **Contracts:** `inbox-api.openapi.yaml` (redocly-valid, 7 new permissions), `realtime-events.md`
    and `meta-graph-inbox.md`.
  - **quickstart.md:** per-story checks with the mock-meta CLI.
  - **plan.md:** Constitution Check PASS both times, the source layout, delivery order and
    complexity tracking.
- **Agent context:** updated CLAUDE.md.
- **ADR suggested** (not created): live-chat realtime and storage.

## Outcome

- ✅ Impact: Feature 002 is planned end to end and ready for `/sp.tasks`.
- 🧪 Tests: contract lint valid; test strategy defined per story.
- 📁 Files: see the list above.
- 🔁 Next prompts: `/sp.tasks` ("continue"); optionally `/sp.adr live-chat-realtime-and-storage`.
- 🧠 Reflection: Keeping the timeline apart from campaign messages protects 001's invariants. SSE through the first-party proxy avoids a second origin.

## Evaluation notes (flywheel)

- Failure modes observed: redocly flagged unquoted commas inside YAML flow mappings, fixed by quoting.
- Graders run and results (PASS/FAIL): spec checklist PASS; Constitution Check PASS (pre and post); contract lint PASS.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): N/A
