# Authentication

The `shared/authentication` workspace package wraps better-auth and provides JWT verification + role-based access control for the API server.

**Key files:**

- `auth.definition.ts` — better-auth config with plugins and hooks
- `auth.roles.ts` — Role definitions and access control rules
- `auth.middleware.ts` — JWT verification and permission checking
- `auth.client.ts` — Client-side better-auth initialization
- `email.ts` — SES email sending (password reset, verification)

**Roles** (hierarchical): member < dj < musicDirector < stationManager

**Permissions per role:**

| Role           | bin        | catalog    | flowsheet   |
| -------------- | ---------- | ---------- | ----------- |
| member         | read/write | read       | read        |
| dj             | read/write | read       | read/write  |
| musicDirector  | read/write | read/write | read/write  |
| stationManager | all        | all        | all + admin |

**JWT payload**: `sub` (user ID), `email`, `role` (queried from the organization member table, not `user.role`).

**`requirePermissions` middleware flow:**

1. Extract Bearer token from `Authorization` header via the shared `parseBearerToken` helper — the Bearer scheme is matched case-insensitively per RFC 6750 §2.1 (`bearer`/`Bearer`/`BEARER`), and a bare `Bearer` with no token is rejected with 401. The same helper serves the `AUTH_BYPASS` branch so the two cannot drift (BS#1125).
2. Verify against JWKS endpoint (`BETTER_AUTH_JWKS_URL`)
3. Check issuer and audience claims
4. Validate role exists in `WXYCRoles`
5. Check permissions using the role's authorize function
6. 403 if role invalid or permissions insufficient

**Auth bypass**: Set `AUTH_BYPASS=true` to skip JWT verification in tests. Rate limiting is disabled when `NODE_ENV=test`.

**Role mismatch gotcha**: better-auth's organization plugin has built-in roles (`owner`, `admin`, `member`) that overlap with WXYC's custom roles. If a user's `member.role` is set to a value not in `WXYCRoles`, the middleware returns 403 on every request. Organization hooks sync `stationManager`/`admin`/`owner` to `user.role='admin'` for the better-auth admin plugin.
