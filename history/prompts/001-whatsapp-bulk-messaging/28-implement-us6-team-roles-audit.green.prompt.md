---
id: 28
title: Implement US6 Team Roles Audit
stage: green
date: 2026-11-17
surface: agent
model: claude-opus-5-5
feature: 001-whatsapp-bulk-messaging
branch: 001-whatsapp-bulk-messaging
user: Muhammad Yaseen
command: /sp.implement
labels: ["implement", "us6", "invitations", "roles", "rbac", "audit", "masking"]
links:
  spec: specs/001-whatsapp-bulk-messaging/spec.md
  ticket: null
  adr: history/adr/0005-authentication-sessions-and-access-control.md
  pr: null
files:
 - apps/api/src/modules/users/{invitations.service,mailer.service,users.controller}.ts
 - apps/api/src/modules/audit/{audit-actions,audit.controller,audit.service}.ts
 - apps/api/src/modules/domain.module.ts
 - apps/api/test/support/test-context.ts (provider overrides)
 - apps/api/test/integration/{users,rbac,masking,audit}.int-spec.ts, apps/api/test/unit/audit-coverage.spec.ts
 - apps/web/src/app/(auth)/invite/[token]/page.tsx, apps/web/src/app/(dashboard)/settings/{team,audit}/page.tsx, apps/web/src/components/require-permission.tsx
 - apps/web/src/app/(dashboard)/{settings/layout,campaigns/new/page,templates/new/page,contacts/import/page}.tsx
 - apps/web/e2e/us6-roles.spec.ts
 - specs/001-whatsapp-bulk-messaging/tasks.md (T166-T169, T171-T180 done; notes on T167, T170, T175, T176)
tests:
 - apps/api unit - 128 pass (new: audit coverage; red confirmed first)
 - apps/api integration - users, rbac (every documented x-permission x 3 roles), masking, audit: 15 pass
 - web typecheck and eslint (web + api) - clean
 - Playwright us6-roles - written, not executed; full regression not rerun (memory)
---

## Prompt

continue

## Response snapshot

Implemented Phase 8, User Story 6.
- **Invitations:** POST /users/invitations creates or refreshes an INVITED user. The random token is stored only as a hash, expires after 7 days and works once. The link is optionally e-mailed through nodemailer when `SMTP_URL` is set; otherwise the admin copies it. The action is audited `user.invited`. Accepting sets the name and password, activates the user and signs them in.
- **Team management:**
  - GET /users and PATCH /users/{id} (role/status).
  - Deactivation revokes sessions; role changes apply on the next request.
  - The last active admin is protected under a row lock.
  - Changes are audited `user.role_changed`, `user.deactivated` and `user.reactivated`.
- **Audit log:** GET /audit-logs is admin-only, newest first, with action/actor filters, pagination and actor names/types. The typed action list moved to audit-actions.ts, with a unit test proving every action is recorded.
- **RBAC test:** a generic test builds the request matrix from the contract's `x-permission` values for all three roles.
- **Masking:** masking is verified across contacts, recipients and previews.
- **Web:** invitation accept page, Team page (invite with copyable link, role select, deactivate/reactivate, new link for pending invites), Audit log page (filters, pagination), and page-level permission gates.

## Outcome

- ✅ Impact: Team rollout is safe; every documented permission is enforced server-side and reflected in the UI (FR-005–FR-008).
- 🧪 Tests: The targeted suites pass, including the generic RBAC matrix. A full regression and the Playwright specs are still pending.
- 📁 Files: about 15 source and test files plus tasks.md.
- 🔁 Next prompts:
  - continue with Phase 9 (US7 public API keys and send API)
  - "tests chalao" when RAM allows
- 🧠 Reflection: Deriving the RBAC test from the OpenAPI contract means new endpoints are covered automatically, and contract/implementation drift surfaces as failures.

## Evaluation notes (flywheel)

- Failure modes observed: none in this phase. All new tests passed after implementation; red was confirmed before it.
- Graders run and results (PASS/FAIL): unit PASS, US6 integration PASS, typecheck PASS, lint PASS, Playwright NOT RUN.
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): US7 - API keys with hashed secrets, idempotency records, per-key rate limits and POST /v1/messages.
