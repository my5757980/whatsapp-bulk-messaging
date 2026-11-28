# Contract: Sign-in with Two-Factor Authentication

**Feature**: 010 (US6, FR-025 – FR-030, research R10) | **Routes**: contacts-settings-api.openapi.yaml
(`/auth/login/*`, `/me/2fa*`, `/settings/security`, `/users/{id}/2fa/reset`) and the 001
`POST /auth/login`.

## 1. Cookies

| Cookie | Set by | Life | Purpose |
|---|---|---|---|
| `sid` | 001, after the last step | 001 session | The session. Never set before the second step for a member who needs one. |
| `csrf` | 001, with `sid` | as `sid` | Double-submit CSRF token (001). |
| `sid_2fa` | `POST /auth/login` when a second step is needed | 5 minutes, one use, `httpOnly`, `SameSite=Strict`, `Secure` outside development | A pending sign-in. Redis holds `wbm:login2fa:{sha256(token)}` → `{ userId, next, ip }`. It is removed on success, on expiry or on a lockout. |

## 2. `POST /auth/login` (001, extended)

1. The email and password are checked as today, with the 001 throttle and audit.
2. The answer depends on the member:
   - **No 2FA and not required:** `200` with the 001 `User`, and `sid` and `csrf` are set, as today.
   - **2FA on:** `200` with `{ "next": "CODE" }` and `sid_2fa` set. No session exists yet.
   - **Required but not set up:** `200` with `{ "next": "SETUP" }` and `sid_2fa` set.
3. A wrong password stays `401` (001). The answer never says whether the member has 2FA before the
   password is right.

## 3. `POST /auth/login/code`

- **Body:** `{ "code": "123456" }` or `{ "recoveryCode": "ABCD-EFGH-JK" }`. Recovery codes ignore
  case, spaces and dashes.
- **Checks, in order:**
  1. The pending cookie exists and `next` is `CODE`, otherwise `401 PENDING_SIGN_IN_EXPIRED`.
  2. The member is not locked, otherwise `429 SECOND_STEP_LOCKED` with `Retry-After`.
  3. **App code:** TOTP (RFC 6238: SHA-1, 6 digits, 30-second step), accepted one step either side.
     The step must be later than `last_step`, so a code is never accepted twice. **Recovery code:**
     its keyed hash must match an unused code, which is then marked used and audited as
     `auth.2fa_recovery_used`.
  4. **Success:** clears the failure counter and `sid_2fa`, creates the 001 session (sets `sid` and
     `csrf`), audits `auth.login` with `secondStep: CODE | RECOVERY`, and returns the 001 `User`.
     When this was the last recovery code, the `User` carries `recoveryCodesLeft: 0`, and the web app
     asks for new codes.
  5. **Failure:** `422 INVALID_CODE`. The failure counter goes up (`wbm:login2fa:fail:{userId}`, 15
     minutes) and `auth.2fa_failed` is audited. The fifth failure in a row sets the lock
     (`wbm:login2fa:lock:{userId}`, 15 minutes), audits `auth.2fa_locked` and deletes the pending
     sign-in.

## 4. Setup required at sign-in

- `POST /auth/login/setup` (pending cookie with `next: SETUP`) makes a new secret, stores it encrypted
  and not enabled, and returns `{ secret, otpauthUrl, qrSvg }`.
  - `otpauthUrl` is `otpauth://totp/{issuer}:{email}?secret={base32}&issuer={issuer}&algorithm=SHA1&digits=6&period=30`.
  - The issuer is `APP_NAME` (default "WhatsApp Platform").
- `POST /auth/login/setup/confirm` `{ code }` checks the code against the new secret (lockout as in
  §3) and enables 2FA. It makes 10 recovery codes, creates the session, audits `auth.2fa_enabled`,
  and returns `{ recoveryCodes }` once.

## 5. Self-service (`/me/2fa`, signed in)

| Route | Needs | Result |
|---|---|---|
| `GET /me/2fa` | session | `{ enabled, enabledAt, required, recoveryCodesLeft }` |
| `POST /me/2fa/setup` | session, 2FA off | a new pending secret (as §4) |
| `POST /me/2fa/confirm` | session, pending secret, a code | 2FA on, `{ recoveryCodes }`, audit `auth.2fa_enabled` |
| `POST /me/2fa/disable` | session, a current code, not required | 2FA off, secret and codes deleted, audit `auth.2fa_disabled` |
| `POST /me/2fa/recovery-codes` | session, a current code | 10 new codes (old ones deleted), audit `auth.2fa_recovery_regenerated` |

## 6. Admin actions

- `PUT /settings/security { require2fa }` (`users.manage`) audits `security.2fa_required_changed`.
  Members already signed in keep their sessions. Members without 2FA meet `next: SETUP` at their next
  sign-in, and the web app shows them a banner meanwhile.
- `POST /users/{id}/2fa/reset` (`users.manage`, not oneself) deletes the member's secret and codes,
  ends all their sessions and audits `auth.2fa_reset`. The member sets 2FA up again at the next
  sign-in if it is required, or may turn it on later.
- **Operator:** `npm run auth:reset-2fa -w @wbm/api -- --email <email>` does the same from the server
  shell and audits `auth.2fa_reset` with the actor `operator`. It is for the only admin who lost both
  the phone and the recovery codes.

## 7. Never

- **No session from a password alone** for a member who needs a second step.
- **Codes and secrets stay out of records:** no code, secret or recovery code in logs, audit details,
  errors or analytics. Audit entries hold only the kind of step.
- **API keys:** unaffected, since they never sign in.
