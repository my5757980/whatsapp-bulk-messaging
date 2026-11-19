# Quickstart: WhatsApp Bulk Messaging Core

**Feature**: `001-whatsapp-bulk-messaging` | **Plan**: [plan.md](./plan.md)

The commands below are the target developer workflow. `/sp.tasks` and `/sp.implement` create the
scripts named here.

## 1. Prerequisites

- Node.js 26 LTS and npm 11 (`node -v`, `npm -v`)
- Docker Desktop with Compose v2
- Git
- Optional: a tunnel (cloudflared or ngrok), to receive real Meta webhooks on your machine
- Optional, for real sends:
  - a Meta Business portfolio and a WhatsApp Business Account
  - a registered phone number
  - a Meta app with the WhatsApp product

## 2. Setup

```powershell
npm install
Copy-Item .env.example .env        # then fill in the values below
docker compose up -d postgres redis minio   # host ports 5434 / 6380 / 9000 by default
npm run db:migrate -w apps/api     # prisma migrate deploy
npm run db:seed -w apps/api -- --admin-email admin@company.test --admin-password "ChangeMe-12345"
npm run dev                        # web :3000, api :4000, worker (BullMQ)
```

Open http://localhost:3000 and sign in with the seeded admin.

### Environment variables (`.env.example` documents all of them)

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://wbm:wbm@localhost:5432/wbm` | Neon connection string in production |
| `REDIS_URL` | `redis://localhost:6379` | Redis must use `maxmemory-policy noeviction` |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `http://localhost:9000` / `wbm` / … | MinIO locally |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `APP_URL` | `http://localhost:3000` | Used in invitation links |
| `COOKIE_SECURE` | `false` locally, `true` in production | |
| `META_GRAPH_BASE_URL` | `http://localhost:4010` (mock) / `https://graph.facebook.com` | |
| `META_GRAPH_API_VERSION` | `v27.0` | Pinned; upgrade deliberately |
| `META_APP_SECRET` | from the Meta app settings | Verifies webhook signatures |
| `META_WEBHOOK_VERIFY_TOKEN` | any long random string | Must match the Meta webhook setup |
| `SMTP_URL` | `smtp://user:pass@host:587` | Optional; without it, invitation links are shown to the admin |
| `LOG_LEVEL` | `info` | |
| `OPS_TOKEN` | any long random string | Sent as the `X-Ops-Token` header to `/api/health` and `/metrics` |

Never commit `.env`. Only `.env.example` lives in git (constitution, Principle III).

## 3. Validate each user story locally (with mock-meta)

`tools/mock-meta` behaves like the Graph API:
- It accepts template and message calls.
- It approves new templates after 10 s.
- It emits signed `sent`, `delivered` and `read` webhooks to the API.
- Phones ending in `0000` produce error 131026.

| Story | Steps | Expected |
|---|---|---|
| US1 Broadcast | Settings → Numbers → connect with mock IDs and token `mock-token`. Templates → Sync. Campaigns → New → Upload `samples/contacts-10.csv` → map `BODY.1` to `name` → Send now. | Number "Connected". The template list shows. 10 recipients go to Delivered/Read within ~30 s, except 1 Failed (131026) with a readable reason. Totals match the rows. |
| US2 Contacts & consent | Contacts → Import `samples/contacts-100.csv`. Then `npm run mock:inbound -- --from +971500000001 --text STOP`. | 100 imported, with an error report for bad rows. The contact shows Opted-out (source Keyword) within 1 min, and new campaigns exclude it. |
| US3 Templates | Templates → New (marketing, 1 variable, 1 URL button) → Submit. | Status Pending, then Approved within 15 s, without a manual refresh. Invalid names are blocked with field errors. |
| US4 Control | Schedule a 1,000-recipient campaign 2 min ahead. Pause at ~30%, then Resume. | Starts within 1 min. No new sends ≤10 s after pause. Final count = 1,000 unique sends (0 duplicates). |
| US5 Reports | Open the report of the US1 campaign → Export → Retarget "Not read". | Rates and failure reasons are shown. The cost uses the rate card. The export matches the totals. A new draft holds only the unread recipients. |
| US6 Roles | Invite a manager and an agent, then sign in as each. | The agent sees masked phones and no launch/export. The manager cannot open Numbers/Users/API keys. The audit log lists the actions. |
| US7 API | Settings → API keys → Create. Then run the `curl` below twice with the same `Idempotency-Key`. | First call: 202 + id. Second call: 200 with the same id. `GET /api/v1/messages/{id}` shows the history. |

```bash
curl -X POST http://localhost:4000/api/v1/messages \
  -H "Authorization: Bearer wbk_..." -H "Idempotency-Key: order-10234" \
  -H "Content-Type: application/json" \
  -d '{"to":"+971501234567","template":{"name":"order_confirmation","language":"en_US"},"params":{"BODY.1":"Sara"}}'
```

## 4. Automated checks (CI gates)

```powershell
npm run lint
npm run typecheck
npm test                      # unit (Vitest)
npm run test:integration      # Supertest + Docker Postgres/Redis + nock
npm run test:contract         # responses vs contracts/*.openapi.yaml
npm run test:e2e              # Playwright + mock-meta
```

## 5. Connecting a real WhatsApp number (production)

Verify each step against Meta's current docs.

1. In Meta Business settings, create a **system user** and grant it the WhatsApp Business Account.
2. Generate a long-lived token with the WhatsApp messaging and management permissions.
3. Copy the **WABA ID** and **Phone number ID** from the WhatsApp Manager / API setup page.
4. In the Meta app, open WhatsApp → Configuration:
   - Set the callback URL to `https://<your-host>/api/webhooks/meta`.
   - Set the verify token to `META_WEBHOOK_VERIFY_TOKEN`.
   - Subscribe to `messages`, `message_template_status_update` and `phone_number_quality_update`.
5. Subscribe the app to the WABA, if Meta's setup asks for it.
6. In the dashboard, go to Settings → Numbers → Connect, paste the IDs and token, then set the send rate (start at 20 msg/s).
7. Enter USD rates in Settings → Rate card, from Meta's published pricing for your main countries.

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| Webhooks return 401 | `META_APP_SECRET` does not match the Meta app; or a proxy changed the raw body |
| Campaign auto-paused "token_expired" | Regenerate the system-user token, then update it under Numbers → Edit |
| Statuses stuck at Sent | Webhook subscription is missing or the tunnel is down; look at the `webhook_events` table |
| Sends slow | `send_rate_per_second` on the number; queue depth on `/metrics` |
