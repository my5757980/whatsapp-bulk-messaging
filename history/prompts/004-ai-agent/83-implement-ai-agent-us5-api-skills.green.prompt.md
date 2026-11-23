---
id: 83
title: Implement AI Agent US5 API Skills
stage: green
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "ai-agent", "api-skills", "secrets", "confirmation", "us5"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - apps/api/src/modules/ai/claude/skills.ts
 - apps/api/src/modules/ai/agents/secrets-vault.ts
 - apps/api/src/modules/ai/agents/agent-secrets.service.ts
 - apps/api/src/modules/ai/agents/agent-secrets.controller.ts
 - apps/api/src/modules/ai/agents/publish.service.ts
 - apps/api/src/modules/ai/turns/turn.service.ts
 - apps/api/src/modules/ai/turns/apply.ts
 - apps/api/src/modules/ai/turns/preview.service.ts
 - apps/api/src/modules/ai/ai.module.ts
 - apps/web/src/components/ai/api-skill-form.tsx
 - apps/web/src/components/ai/skills-tab.tsx
 - apps/api/test/unit/ai/skill-tools.spec.ts
 - apps/api/test/integration/ai-skills.int-spec.ts
 - apps/api/test/contract/ai.contract-spec.ts
 - apps/web/e2e/ai-us5-api-skill.spec.ts
 - specs/004-ai-agent/tasks.md
tests:
 - apps/api/test/unit/ai/skill-tools.spec.ts (6 new, pass); API unit 398/398; eslint and tsc clean for api and web
 - CI for US3 web (3b5f450) and US4 (5aa3271) all green before this push
---

## Prompt

continue

## Response snapshot

US5 (API skills), T070–T076:

- **Skill tools (`claude/skills.ts`, unit-tested):**
  - Each skill becomes one strict tool, `skill_<id>`, built from its inputs.
  - The request uses the 003 place-aware encoding with `{input:…}`, `{contact:name}`, `{contact:phone}` and `{attr:…}`. Secrets go in header values only.
  - Only the mapped fields go back to the model. A timeout, an error status or a refused address comes back as `ok: false` with the reason.
  - Skills that change data answer `confirmation_needed` and keep a pending call. They run on a later turn with the same inputs, and other inputs ask again. The preview only simulates them and shows "Would call …"; read-only skills still run in the preview.
- **Turn wiring:**
  - `think()` builds the skill session with the agent's decrypted secrets, and the pending confirmation goes into the turn context.
  - The applier stores the next pending confirmation on the AI conversation and records skill calls without values in `ai_replies.skills` and `payload.ai.skills`.
- **Secrets:** an encrypted vault in the domain module. The API supports create, rename and replace-value, and delete, which returns 409 `SECRET_IN_USE` while the draft or any version uses the secret. Names only are returned, and changes are audited `ai.secret_changed` without values.
- **Skill test request:** runs on the same safe client and returns ok, status, duration, the mapped fields, a body preview and the error.
- **Publish:** also refuses skill addresses written as private or local hosts (`BLOCKED_ADDRESS`). The shared checks `NOT_HTTPS`, `SECRET_OUTSIDE_HEADER`, `UNKNOWN_INPUT` and `DUPLICATE_SKILL_ID` and the server check `UNKNOWN_SECRET` were already in place.
- **Web:** an API skill editor in the Skills tab: inputs, method and address, headers with "insert a secret", query, body, timeout, mapped fields, "changes data", and a test request. Also a secrets panel: store, replace, delete, values shown masked.
- **Tests:**
  - Integration: encoding and the header secret, mapped fields only, timeout and 500 without an invented status, publish refusals, the test request, and the secret lifecycle with audits.
  - Contract cases.
  - e2e: masked secret, test request, publish, and the fake model's tool call. The lookup fails, so the agent offers a person and live chat shows "Used 1 skill".

## Outcome

- ✅ Impact: US5 complete (76 of 113 tasks).
- 🧪 Tests: unit/lint/typecheck pass locally; integration, contract and e2e in CI.
- 📁 Files: listed above.
- 🔁 Next prompts: US6 (work together with chatbot flows).
- 🧠 Reflection: side effects of a turn (the pending confirmation, skill records) are collected during the model run and persisted only with the reply, so a dropped turn leaves no stray state.

## Evaluation notes (flywheel)

- Failure modes observed: none new.
- Graders run and results (PASS/FAIL): unit PASS 398; lint/tsc PASS; CI pending.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): none.
