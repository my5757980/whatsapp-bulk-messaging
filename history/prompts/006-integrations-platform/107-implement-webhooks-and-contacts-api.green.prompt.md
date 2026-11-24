---
id: 107
title: Implement Webhooks And Contacts API
stage: green
date: 2026-11-24
surface: agent
model: claude-opus-5-5
feature: 006-integrations-platform
branch: 006-integrations-platform
user: Muhammad Yaseen
command: /sp.implement (continue)
labels: ["implement", "integrations", "webhooks", "public-api", "api-key-scopes", "idempotency", "contacts-api", "drips"]
links:
  spec: specs/006-integrations-platform/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - apps/api/prisma/schema.prisma
 - apps/api/prisma/migrations/20261201000000_integrations/migration.sql
 - apps/api/src/modules/api-keys/api-keys.service.ts
 - apps/api/src/modules/public-api/api-key.guard.ts
 - apps/api/src/modules/public-api/api-scope.decorator.ts
 - apps/api/src/modules/public-api/idempotent-responses.service.ts
 - apps/api/src/modules/public-api/idempotency-cleanup.processor.ts
 - apps/api/src/modules/public-api/public-contacts.service.ts
 - apps/api/src/modules/public-api/public-contacts.controller.ts
 - apps/api/src/modules/public-api/public-drips.controller.ts
 - apps/api/src/modules/public-api/public-messages.controller.ts
 - apps/api/src/modules/public-api/public-templates.controller.ts
 - apps/api/src/modules/contacts/contacts.service.ts
 - apps/api/src/modules/growth/growth.module.ts
 - apps/api/src/modules/domain.module.ts
 - apps/api/src/modules/inbox/journey/journey.service.ts
 - apps/web/src/app/(dashboard)/settings/api-keys/page.tsx
 - apps/web/src/components/inbox/journey-list.tsx
 - apps/api/test/integration/integrations-contacts-api.int-spec.ts
 - apps/api/test/contract/public-api-v1.contract-spec.ts
 - apps/web/e2e/integrations-us2-contacts-api.spec.ts
 - apps/api/test/unit/audit-coverage.spec.ts
 - specs/006-integrations-platform/contracts/public-api-v1.openapi.yaml
 - specs/001-whatsapp-bulk-messaging/contracts/public-api.openapi.yaml
 - specs/002-team-inbox/contracts/inbox-api.openapi.yaml
 - specs/006-integrations-platform/data-model.md
 - specs/006-integrations-platform/tasks.md
tests:
 - apps/api typecheck (tsc) passed; apps/web typecheck passed; eslint clean on changed files
 - apps/api unit tests 461/461 passed (audit coverage now includes api_key.scopes_changed)
 - redocly lint of all contracts valid
 - added, to run in CI: integrations-contacts-api.int-spec.ts (7 cases), public-api-v1.contract-spec.ts (US2), integrations-us2-contacts-api.spec.ts (e2e)
---

## Prompt

continue

(Sent four times after restarts and one interruption while 006 was being implemented; each time the work went on from the last task. Before this, the user said "haaa agayyycontinue karooo kaam".)

## Response snapshot

- **US1 (T018–T025), outbound webhooks:** committed as c9bd901. Includes signed deliveries, retries, the delivery log, resend, the test event and auto-pause.
- **US2 (T026–T033), contacts API with key permissions:** tests first, then the code.
  - **Key permissions:**
    - API keys have `scopes`; older keys keep `messages.send` through the column default.
    - The `@RequireScope()` decorator is checked in `ApiKeyGuard`. A key without the permission gets 403 `insufficient_scope`, and the message says which permission is needed.
    - `PUT /api-keys/{id}/scopes` records the `api_key.scopes_changed` audit entry.
  - **New public routes:**
    - contacts: upsert by phone, lookup, get, patch, add and remove tags, opt-in with a source note, opt-out
    - a cursor list over `(updated_at, id)`
    - tags and attributes
    - drip enrolment by id or exact name, and removal
  - **Dashboard rules apply:** the routes reuse ContactsService, ConsentService and EnrolmentsService, so attribute types, tag names, consent rules, drip rules, webhook events and the API_CREATED drip start all match the dashboard.
  - **Idempotency:** a new `api_idempotent_responses` table keeps the first answer for 24 hours. A different request with the same key gets 409. The hourly 001 cleanup also clears this table.
  - **Journey:** entries by the new `API_KEY` actor name the key, in both the API and the web journey list.
  - **Contracts:** the 001 public routes now list 403, the 002 journey actor list includes API_KEY, and the enrolment POST lists 422.
  - **Web:** a permissions editor on the API keys page, with a checkbox and a plain description for each permission, a note about older keys, and a "Permissions saved" confirmation.
- **No pull request yet:** the GitHub MCP connection fails and gh is not installed, so integration, contract and e2e tests have not run in CI yet.

## Outcome

- ✅ Impact: US1 and US2, the developer platform MVP, are implemented and pushed to `006-integrations-platform`.
- 🧪 Tests: all local checks passed. Integration, contract and e2e tests wait for a draft PR, because CI runs on pull requests only.
- 📁 Files: see the list above.
- 🔁 Next prompts:
  - The user opens the draft PR at https://github.com/my5757980/whatsapp-bulk-messaging/pull/new/006-integrations-platform.
  - Fix whatever CI finds.
  - Continue with US3 (API campaigns, T034–T041).
- 🧠 Reflection:
  - Bash heredocs and `node -e` strings with backticks or regex escapes broke twice: a data-model edit lost its code spans, and a task-mark regex matched nothing. Write script files with the Write tool, and check each edit result.
  - Valid UAE test numbers need the prefixes 50, 52, 54, 55, 56 or 58.
