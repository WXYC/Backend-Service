-- Custom SQL migration file, put your code below! --

-- COMMENT ON COLUMN annotations for the DJ-name / real-name PII boundary.
--
-- DDL-only, no ALTER TABLE — five `COMMENT ON COLUMN` statements pinning
-- the distinction docs/pii.md documents in full: `auth_user.real_name` is
-- the sole legal-name (PII) carrier; `auth_user.name`, `flowsheet.dj_name`,
-- `shows.legacy_dj_name`, and `shows.dj_name_override` all hold the public
-- on-air handle and must never carry a legal name. See docs/pii.md for the
-- registry and enforcement pointers (the `wxyc/restricted-real-name` ESLint
-- rule, the dj-real-name-sentinel spec).
--
-- ## Recipe for the next `COMMENT ON` (or other DDL-only, no-Drizzle-diff)
-- ## migration
--
-- `drizzle-kit` has no first-class `COMMENT ON` support, and plain
-- `npm run drizzle:generate` emits nothing on a no-diff schema — a column
-- comment isn't part of the Drizzle schema model, so there's no diff to
-- detect. The escape hatch is an empty custom migration:
--
--   1. `npx drizzle-kit generate --config drizzle.config.ts --custom --name
--      <slug>` creates the empty `.sql` file and appends the journal entry.
--      It needs `DB_*` env vars set for `drizzle.config.ts` to evaluate,
--      but `--custom` never opens a connection — dummy values work fine,
--      e.g. `DB_USERNAME=x DB_HOST=localhost DB_PORT=5432 DB_NAME=x`.
--
--   2. **The `applied-hashes.json data is malformed` notice is NOT optional
--      to work around under `--custom`, unlike docs/migrations.md's
--      "Drizzle-kit applied-hashes.json data is malformed quirk" section
--      says for plain `generate`.** That section calls the move-aside
--      workaround a just-in-case measure "if drizzle-kit's behavior
--      tightens in a future bump" — true for a real schema diff, where the
--      malformed file is merely skipped. Under `--custom` on drizzle-kit
--      0.31.10 it already fails every time: `preparePrevSnapshot` reads
--      `snapshots[snapshots.length - 1]` off `meta/`'s directory listing
--      sorted *alphabetically*, not by migration index, so
--      `applied-hashes.json` (sorting after every `NNNN_snapshot.json`,
--      since `'a'` > `'0'`-`'9'`) is picked as "the previous snapshot",
--      fails `pgSchema.parse`, and drizzle-kit silently exits 0 having
--      written nothing — no error, no `.sql`, no journal entry, just the
--      malformed notice and then silence. The same docs/migrations.md
--      workaround fixes it (step 6 below regenerates the moved file from
--      scratch anyway, so the temporary absence is harmless) — it just
--      isn't optional here:
--
--        mv shared/database/src/migrations/meta/applied-hashes.json /tmp/
--        npx drizzle-kit generate --config drizzle.config.ts --custom --name <slug>
--        mv /tmp/applied-hashes.json shared/database/src/migrations/meta/
--
--   3. Hand-write the DDL below the placeholder line drizzle-kit leaves
--      (`-- Custom SQL migration file, put your code below! --`), and
--      prepend a header comment like this one explaining the migration's
--      purpose. `COMMENT ON COLUMN` is idempotent (last write wins, no
--      error on re-apply), so no `IF NOT EXISTS`-style guard is needed —
--      and see docs/migrations.md's `dev-prod-pg-version-skew` rule: this
--      syntax is plain SQL, unchanged since Postgres 7.2, so it's PG14-safe
--      by construction, no release-notes check required.
--
--   4. If `meta/<idx>_snapshot.json` wasn't written (only possible if step
--      2's workaround wasn't applied), duplicate the predecessor's snapshot
--      under the new index — a no-Drizzle-diff migration's snapshot is
--      byte-for-byte identical to its predecessor's, since nothing in the
--      Drizzle-modeled schema changed. Applying the workaround above wrote
--      `meta/0157_snapshot.json` correctly, so this step wasn't needed for
--      this migration.
--
--   5. Journal `when`: drizzle-kit auto-stamps `Date.now()` on the new
--      entry. Diff it against the previous entry's `when`
--      (docs/migrations.md's `hand-edit-when` rule) rather than assuming —
--      hand-bump to `previous.when + 1` only if it isn't already strictly
--      greater. Here it already was (both are real wall-clock timestamps),
--      so no hand-edit was needed.
--
--   6. `npm run drizzle:freeze-hashes` (regenerates
--      `meta/applied-hashes.json` from every `.sql` file's current
--      content), then `npm run lint:migrations` must be green before
--      committing.

COMMENT ON COLUMN "wxyc_schema"."auth_user"."real_name" IS
  'PII: legal name, collected as a legal requirement; never on a public wire; see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."auth_user"."name" IS
  'Display handle/username — NOT the legal name; real_name is. Backfill pending (jobs/auth-user-name-backfill); see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."flowsheet"."dj_name" IS
  'Public on-air handle; never a legal name; see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."shows"."legacy_dj_name" IS
  'Public on-air handle sourced from tubafrenzy DJ_HANDLE; never a legal name; see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."shows"."dj_name_override" IS
  'Public on-air handle override, operator-supplied; never a legal name; see docs/pii.md';
