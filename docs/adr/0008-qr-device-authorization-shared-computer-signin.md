# 0008 — QR device authorization for shared-computer sign-in to dj.wxyc.org

The control-room computer at WXYC is shared across DJ shows; password sign-in on a shared keyboard is awkward and exposes credentials. iOS becomes a QR scanner that authorizes browser sign-in to dj.wxyc.org via better-auth's [`device-authorization` plugin](https://www.better-auth.com/docs/plugins/device-authorization) (RFC 8628), already shipped in `better-auth@^1.6.11` and present in `apps/auth/node_modules/`. Browser POSTs `/auth/device/code` → renders `verification_uri_complete` as a QR + the `user_code` in plain text → polls `/auth/device/token`. iOS scans, calls `/auth/device/verify` carrying the DJ's Bearer JWT, the browser's next poll receives a session. Role gate: `dj+` only; `member` is rejected at `/device/verify` with `access_denied`. QR-issued sessions get a 12-hour `expiresIn` (vs better-auth's 7-day default for cookies) so a forgotten sign-out self-cleans before the next morning's DJ arrives.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0007](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0007--qr-device-authorization-for-shared-computer-sign-in-to-djwxycorg) and the repo-local [iOS ADR 0002](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/adr/0002-qr-device-authorization-shared-computer-signin.md).

## Our side of the work

- **Register the plugin** in [`apps/auth/app.ts`](../../apps/auth/app.ts) with `expiresIn: 5min`, `interval: 5s`, `userCodeLength: 8`, `deviceCodeLength: 32`, and an opaque `verificationUri` (the iOS in-app scanner reads the value out of the QR; it does not need to be a navigable URL). Run the auto-generated `deviceCode` table migration.
- **Custom hook on `/auth/device/verify`** to (a) reject when the approving user's `role === 'member'` with `access_denied`, and (b) override the resulting session's `expiresIn` to 12 hours. The override applies only to device-authorization sessions; password sign-in keeps the existing default.
- **Extend [`rateLimitedPaths`](../../apps/auth/app.ts)** with `/auth/device/code` and `/auth/device/verify` — they inherit the existing `authMutationRateLimit` (10 req / 15 min per-IP). **Do not** rate-limit `/auth/device/token` — the plugin enforces RFC 8628's `pollingInterval` server-side, and an HTTP 429 on top would mask the `authorization_pending` / `slow_down` JSON responses and break any polling client.
- **OpenAPI surface** for the three new endpoints in [`wxyc-shared/api.yaml`](https://github.com/WXYC/wxyc-shared/blob/main/api.yaml).

## Consequences for us

- One new schema object owned by better-auth (`deviceCode` table). Reversible by removing the plugin; the table can be dropped without affecting other surfaces.
- Audit forensics for v1 rely on our existing `session` table plus better-auth's `deviceCode` — together they answer "which sessions for @user this week were QR-issued and from which device_code." Structured Sentry events (`auth.qr.approved`, `auth.qr.rejected`) tagged with phone IP/UA and browser IP/UA are a deferred follow-up — cheap to add when an incident requires richer forensics.
- Phone-coupled session revocation (auto-kill browser session when the phone signs out) is **not** in v1 — adds a surprise mode for DJs signing out on the phone for unrelated reasons. Reconsider in v2 if forgotten-sign-out failure modes are observed.
- The `/auth/device/token` polling endpoint is intentionally absent from rate-limiting — see above. If we ever want global request-count limits, they go at the proxy/ingress layer, not via express-rate-limit on this path.
- No new tables owned by us beyond what better-auth manages. The `apps/auth/` service code grows by ~50 lines (plugin registration + verify hook + rate-limit array entries).

## Related work tickets

[`wxyc-dj-tool-ios/docs/bs-work-inventory.md`](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/bs-work-inventory.md) sub-tickets BS-26 (plugin register), BS-27 (verify hook), BS-28 (rate-limit paths), BS-29 (OpenAPI documentation) — all S-sized, all in one PR.
