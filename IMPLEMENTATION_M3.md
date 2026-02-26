# VibeCode – Implementation Plan: Milestone 3

## Context

M2 delivered the control-plane core (routes, D1, GatewayHub DO, scheduler) and gateway release plumbing.

M3 now focuses on a minimal, usable auth + staging UX slice:
- sign in / sign out
- create VPS + add VPS actions from a simple staging page
- account identity unification by lowercase email across login methods

---

## Goals

1. Ship a minimal login flow that works on staging without the full web app.
2. Support 3 login methods:
   - email magic link
   - Google OAuth
   - GitHub OAuth
3. Ensure the same lowercase email maps to one user across all methods.
4. Add a minimal authenticated staging page with:
   - current user info
   - `Create VPS` button
   - `Add VPS` button (manual test path)
   - `Logout` button

---

## Non-Goals (M3)

- Full polished product UI (`packages/web`) and design system work.
- BYO production UX and confirmation flow from MVP section 10b.
- Replacing existing VPS/session APIs with a new domain model.
- Telegram and Mini App work.

---

## Delta vs Previous Plan

Previous plan (M2 notes + MVP early text) assumed email magic-link later and effectively tied initial session creation to DO OAuth callback.

M3 changes that model:

1. **Auth becomes provider-agnostic first**, DigitalOcean OAuth becomes a linked integration for an already-authenticated user.
2. **Google + GitHub login are added now** (earlier than previously documented).
3. **Identity linking key is lowercase email**, shared across email/Google/GitHub.

This is a meaningful plan shift, but it does **not** break core gateway/session architecture. It only changes auth entry points and user linking logic.

---

## Data Model Changes

Current `email_identities.email` already enforces lowercase uniqueness:
- `email TEXT NOT NULL UNIQUE CHECK (email = lower(email))`

Add provider identity mapping table:

```sql
CREATE TABLE auth_identities (
  provider         TEXT    NOT NULL CHECK (provider IN ('email', 'google', 'github', 'digitalocean')),
  provider_user_id TEXT    NOT NULL,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT    NOT NULL CHECK (email = lower(email)),
  email_verified   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_login_at    INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX idx_auth_identities_user  ON auth_identities(user_id);
CREATE INDEX idx_auth_identities_email ON auth_identities(email);
```

### Identity invariants

1. Email is normalized with `trim().toLowerCase()` before any DB lookup/write.
2. One lowercase email maps to one user (enforced by `email_identities` unique constraint).
3. One `(provider, provider_user_id)` maps to one user (primary key in `auth_identities`).
4. If provider identity and email resolve to different users, fail with `409 identity_conflict` (no silent merge).

---

## Auth Flows

## 1) Email Magic Link

Routes:
- `POST /auth/email/start`
- `GET /auth/email/verify?token=...`

Flow:
1. User submits email.
2. Normalize + validate.
3. Store one-time token in KV (TTL 10 min).
4. Staging mode: return verification URL inline for quick testing.
5. Production mode: send email via provider.
6. Verify endpoint consumes token and signs session cookie.

## 2) Google OAuth

Routes:
- `GET /auth/google/start`
- `GET /auth/google/callback`

Flow:
1. Create `state` nonce in KV (TTL 10 min).
2. Redirect to Google auth.
3. Callback exchanges code for tokens, retrieves verified email + stable subject (`sub`).
4. Run shared identity resolution/linking transaction.
5. Set session cookie and redirect to staging test page.

## 3) GitHub OAuth

Routes:
- `GET /auth/github/start`
- `GET /auth/github/callback`

Flow:
1. Create `state` nonce in KV.
2. Redirect to GitHub auth.
3. Callback exchanges code, fetches `/user` and `/user/emails`.
4. Choose `primary && verified` email (or fail if no verified email).
5. Run shared identity resolution/linking.
6. Set session cookie and redirect.

## 4) Logout + Current User

Routes:
- `POST /auth/logout`
- `GET /auth/me`

Behavior:
- Logout clears cookie (`Max-Age=0`).
- `auth/me` returns current user id + canonical email + linked providers.

## 5) DigitalOcean OAuth (Adjusted)

`/auth/do` becomes **connect-account flow** for already-authenticated users:
- requires valid session
- DO callback links tokens to current user (not “create user from DO email” anymore)

Legacy `/auth/do` login-bootstrap behavior is removed in M3 (hard cutover).

---

## VPS Buttons for Staging Page

## `Create VPS` button

Calls existing:
- `POST /vps`

No backend behavior change required.

## `Add VPS` button (manual test path)

Add a staging-focused endpoint:
- `POST /vps/manual`

Returns install-ready gateway credentials:
- `vps_id`
- `gateway_id`
- `gateway_auth_token` (plaintext returned once)
- `cp_url`
- example install commands for Linux/macOS

M3 keeps this as a pragmatic test path for manual gateway connection before full BYO UX.

---

## Staging Test Page

Add a minimal server-rendered HTML page from control-plane worker (staging):
- route: `GET /staging/test` (name can be adjusted)
- always enabled in staging deploy

Page behavior:
1. On load, call `/auth/me`.
2. If unauthenticated, show login options (email input + Google + GitHub buttons).
3. If authenticated, show:
   - user identity summary
   - `Connect DigitalOcean`
   - `Create VPS`
   - `Add VPS`
   - `List VPS`
   - `Logout`
4. Show raw API response JSON in a debug panel for fast smoke testing.

---

## Planned File-Level Changes

### `packages/control-plane`

- `src/lib/auth.ts`
  - add shared email normalization helper
  - add current-user helper and logout cookie helper
- `src/lib/identity.ts` (new)
  - provider/email identity resolution and linking logic
- `src/routes/auth.ts`
  - add email/google/github/me/logout routes
  - move DO connect/callback to “authenticated connect” semantics
- `src/routes/vps.ts`
  - add `POST /vps/manual` (staging/manual path)
- `src/index.ts`
  - register new routes + staging test page route
- `src/db/schema.ts`
  - auth identity helpers
- `src/db/migrations/0002_auth_identities.sql` (or equivalent schema refresh)
- `wrangler.toml`
  - add vars for provider client IDs and test-page toggle

### Tests

- `test/routes.auth.m3.test.ts` (new)
- extend:
  - `test/auth.test.ts`
  - `test/routes.vps.test.ts`
  - `test/ids.test.ts` (if needed for token format helpers)

---

## Environment and Secrets

New vars/secrets expected (staging first):

- Vars:
  - `GOOGLE_CLIENT_ID`
  - `GITHUB_CLIENT_ID`
  - `AUTH_MODE` (staging should move from `dev` to cookie auth during M3 validation)
- Secrets:
  - `GOOGLE_CLIENT_SECRET`
  - `GITHUB_CLIENT_SECRET`
  - `EMAIL_SIGNING_SECRET` (if required by chosen magic-link token format)
  - email-provider API key (if production email sending is enabled)

---

## Testing Plan

1. Unit tests:
   - email normalization and validation
   - identity resolution/linking conflict cases
   - provider callback payload parsing
2. Route tests:
   - login start/callback success + failure
   - logout clears cookie
   - `/auth/me` authorization behavior
   - `/vps/manual` credential mint behavior
3. Staging smoke:
   - login via email, Google, GitHub using same email -> same `user_id`
   - create VPS from test page
   - add manual VPS and connect gateway via install script
   - logout and re-login via different provider, confirm same account

---

## Backward Compatibility / Break Risk

Low risk to M2 runtime behavior (gateway/session path unchanged), but two auth shifts are notable:

1. `/auth/do` semantic shift from login bootstrap to account-connect.
2. Staging should stop relying on `X-Dev-User` once M3 auth is being validated.

Mitigation:
- keep `AUTH_MODE=dev` only for local dev;
- deploy M3 auth changes to staging as a hard cutover and validate smoke tests before prod.

---

## Acceptance Criteria

1. User can sign in with email magic link, Google, or GitHub.
2. Same lowercase email across methods resolves to the same `user_id`.
3. `/staging/test` supports end-to-end auth + create/add/list/logout flows.
4. Existing `/vps`, `/sessions`, gateway WS behavior remains stable.
5. No secrets in repo; all provider credentials are Wrangler secrets/vars.
