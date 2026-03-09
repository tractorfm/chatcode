# M4 UI Review Notes (Frontend Worker Handoff)

Date: 2026-03-09  
Scope: `frontend-claude` (`ccac6ca`) and follow-up review feedback

## Blocking / High Priority

1. DO onboarding completion flow is using a mismatched API contract.
- `createVPS()` in web expects a full `VPS`, but control-plane currently returns `{ vps_id, status }`.
- Fix in UI:
  - treat create response as minimal create result, then re-fetch `GET /vps` and resolve the created record by `vps_id`.
  - avoid assuming `vps.id` is present in create response.

2. BYO onboarding command is currently static and not executable for registration.
- UI currently renders a generic install command without CP-issued credentials.
- Required flow:
  - call `POST /vps/manual`
  - display generated install command using returned credentials/token
  - show copy-safe one-liner (and optional expanded command view).

3. App-domain auth/cookie flow is not wired for `app.*` usage.
- Frontend uses `credentials: "include"` but CP CORS/callback assumptions were built around staging test routes.
- UI must align with core changes:
  - use app routes for post-auth navigation
  - avoid hard-coded `/staging/test` assumptions.

## Medium Priority

4. UI expects VPS fields not guaranteed by current API shape.
- Fields in UI logic/types: `provider`, `label`, `gateway_connected`, `gateway_version`.
- Keep these optional in UI until core guarantees them, or fetch live status from dedicated status APIs before rendering actions that depend on them.

5. `TerminalView` has render-time side-effects.
- Avoid fitting/focusing from render path (`queueMicrotask` from render is brittle).
- Move fit/focus side-effects into React effects (`useEffect`/`useLayoutEffect`) with explicit dependencies.

6. CSS import path for xterm is brittle.
- Replace relative `node_modules` import with package import:
  - `@xterm/xterm/css/xterm.css`.

## Additional Notes

7. Auth page path assumptions are stale.
- Avoid checking only `/auth/verify` in frontend; support actual callback routes and/or CP-driven redirect params.

8. Add minimal frontend contract coverage.
- Suggested tests:
  - auth happy path redirect handling
  - onboarding create VPS response handling (minimal response)
  - BYO provisioning flow (`/vps/manual` command generation)
  - terminal connect smoke with ack/ping lifecycle.

9. Minor plan/doc hygiene from review:
- fix duplicate list numbering in `REVIEW_M4_PLANS.md` sections (Core WS1/UI WS1).
- add one-line comment for branch sanitization fallback to `"preview"` in Pages deploy workflow.

