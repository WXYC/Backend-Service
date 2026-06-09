# 0005 — Album condition is a state enum with an audit log, MD-gated for non-missing transitions

Replaces the current `markedMissingAt` / `markedFoundAt` two-timestamp model on [`wxyc_schema.library`](../../shared/database/src/schema.ts) with a `condition` enum (`in_library` default, `missing`, `damaged`, `in_repair`) plus a new `condition_transitions` audit table (`album_id`, `from_state`, `to_state`, `reporter_dj_id`, `at`, `note?`). An album is exactly one state at any moment; multi-observation issue-row layering is explicitly out of scope for v1.

Authorization is role-gated at our boundary (iOS gates the UI based on the JWT `role` claim — see [`JWTPayload.swift`](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/Packages/WXYCAPI/Sources/WXYCAPI/JWTPayload.swift) — but we enforce):

| Transition                                 | Required role             |
| ------------------------------------------ | ------------------------- |
| `in_library` ↔ `missing` (both directions) | `dj` and above            |
| `in_library` → `damaged`                   | `musicDirector` and above |
| `damaged` → `in_repair`                    | `musicDirector` and above |
| `in_repair` → `in_library`                 | `musicDirector` and above |
| Any other transition                       | Not allowed               |

Endpoint shape: replace `PATCH /library/{id}/missing` and `PATCH /library/{id}/found` with one `PATCH /library/{id}/condition` taking `{ to_state, note? }`. Server validates the transition is in the allowed set above.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0004](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0004--album-condition-is-a-state-enum-with-an-audit-log-md-gated-for-non-missing-transitions).

## Consequences

- One Drizzle schema migration adds the `condition` column (backfill from `markedMissingAt IS NOT NULL → 'missing'` else `'in_library'`), drops the two timestamp columns (or keeps them deprecated for one release), creates `condition_transitions`.
- One [`wxyc-shared/api.yaml`](https://github.com/WXYC/wxyc-shared/blob/main/api.yaml) update deprecates the two paths and adds the unified one.
- Authz expansion is mechanical — likely either an extension to [`auth.roles.ts`](https://github.com/WXYC/Backend-Service/blob/main/shared/authentication/src/auth.roles.ts) or per-endpoint guard rather than the catch-all "DJ-authz" we use for the two existing paths.
- The audit table becomes the natural source for an MD-facing "recently missing / recently damaged" report; we get that capability for free.
