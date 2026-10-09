Closes #3086

Leaves the uptime canary's DJ-role account out of "can be asked to review", as the auto-DJ already is (#3076), so `GET /reviews/reviewers` and `POST /intake/{id}/request`'s `dj_id` check agree with the contract ("service accounts, such as the auto-DJ account").

## Marker choice

Nothing on the account durably distinguishes service accounts: no column, and `POST /auth/admin/provision-user` takes a free-form username. wxyc-canary's README setup step names the canary's account only by email (`canary@wxyc.org`, `dj` role), with no fixed username, so a username marker would have been a guess. So `shared/authentication` now exports `CANARY_EMAIL` and `isServiceAccount({ username, email })` beside `AUTO_DJ_USERNAME` (auto-DJ by username, canary by case-insensitive email); `canBeAskedToReview` calls it, and a future automated account is added there only. The email is a public README value, not an infrastructure identifier.

Because the marker is an email, the rule's input gains `email`: `memberAccount` and `listReviewers` both select it (both column pins updated), and it is used only for the comparison, never returned or logged. `docs/pii.md` lists the two new read sites. The canary keeps its `dj` role and grants; no data changes.

## Changes

- `canBeAskedToReview` table: canary rows (exact, mixed case, and a near-miss email that stays listed); list and `dj_id` route tests cover the canary, with the 400 body identical to a member's.
- `app.yaml`: the `GET /reviews/reviewers` description and `dj_id` property say "service accounts, such as the auto-DJ account"; the summary is now "The accounts that can be asked to review (BS#3058)". The YAML parses and the touched strings are non-empty.

## Checks run locally

lint, format:check, typecheck, check:docs, check-cross-cache-identity-flags.sh, check-precondition-guards.sh, check-legacy-entry-id-writes.mjs, check-lml-caller-classification.mjs, check-bulk-update-analyze.mjs --strict, check-auth-tables-doc.mjs, the full unit suite (675 suites, 13827 tests), and check:audit-coverage:ci. Not run: integration specs, ci:testmock (Docker is unavailable). No integration spec was added; the list and `dj_id` behavior is pinned in unit tests.
