# Security and Trust Model

This document is intentionally explicit about current MVP tradeoffs.

## Current Security Properties

- Transport security: Browser <-> control-plane and control-plane <-> gateway use TLS (`https` / `wss`).
- Authentication:
  - user auth via session cookie (or `AUTH_MODE=dev` in dev/staging)
  - gateway auth via per-gateway token hash verification
- Least key custody: control-plane does **not** store user private SSH keys.
- User workload isolation: sessions run inside user-owned VPS and tmux-backed workdirs.

## Important MVP Limitation (Read This)

There is **no end-to-end encryption between browser and gateway** today.

What that means in practice:

- Terminal traffic is encrypted in transit per hop (TLS).
- Control-plane terminates those connections and relays traffic.
- So control-plane is in a trusted relay position and can inspect terminal payloads.

This is a deliberate MVP tradeoff for reliability, debuggability, and simple operations.
Broader non-security runtime trade-offs are tracked in:
`docs/IMPLEMENTATION_M4_CORE.md` ("Trade-offs & Deferred Improvements").

## Threat Model Notes

- Recommended usage now: sandbox/dev workloads on fresh user VPS.
- Avoid handling highly sensitive secrets in terminal sessions unless you accept current trust model.
- If you need stricter privacy/isolation today, self-host in your own Cloudflare account and domain.

## Verification and Trust Minimization

You can verify what runs:

1. Inspect source in this repo.
2. Verify gateway release checksum artifacts (`*.sha256`) before installation.
3. Pin explicit gateway versions (`--version vX.Y.Z`) instead of `latest` when needed.
4. Build gateway from source and install with `--binary-source`.
5. Self-host control-plane in your own Cloudflare account.
6. Review deployed Worker versions with Wrangler (`wrangler deployments list`) and audit config/secrets.

## Roadmap (Security Hardening)

Planned improvements include:

- Optional end-to-end encryption mode for terminal payloads.
- Stronger release provenance/signing workflow.
- Additional auditability and operational controls.

## Feedback

Security suggestions are welcome.

- Open a GitHub issue for design discussion.
- For high-impact vulnerabilities, use GitHub's private vulnerability reporting ("Security" -> "Report a vulnerability") and avoid public PoCs until fixed.
