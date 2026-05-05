# Plan: Surface drizzle:migrate's underlying Postgres ERROR in deploy logs

- **Issue**: WXYC/Backend-Service#725
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 1 (visibility)
- **Size**: XS

## Context

When `drizzle-kit migrate` (invoked by `dev_env/init-db.mjs`) fails, the underlying Postgres `ERROR` text is shadowed by drizzle-kit's spinner ANSI redraws. The deploy log shows only trailing `NOTICE` lines and an empty stderr, leaving operators to infer the failure from timing. Same failure mode bit us in #400 and #550; recurred 2026-05-04 (run 25337297761) on migration 0071's `RAISE EXCEPTION` precondition guard.

## Approach

Stop shelling out to `drizzle-kit migrate`. Use drizzle-orm's programmatic `migrate()` directly — same function the CLI ultimately calls, but exposed as a library so we own the error surface. Wrap in try/catch; on catch, dump the full Postgres error fields (`code`, `message`, `where`, `detail`, `hint`) to stderr before re-throwing.

drizzle-orm exports the function from `drizzle-orm/postgres-js/migrator`. Already installed (`shared/database` depends on `drizzle-orm`); no new dep.

## Implementation

### Step 0 — Confirm drizzle-orm version compatibility in `dev_env/`

`dev_env/package.init.json` currently pins a different `drizzle-orm` minor than `shared/database/package.json` (e.g., `^0.41.0` vs `^0.45.2` at time of writing). The `migrate()` function is stable across these but verify before relying on it: install dev_env's pin and confirm `drizzle-orm/postgres-js/migrator` exports `migrate()` with the documented signature. If the gap is wider than a minor, bump `dev_env/package.init.json` to match `shared/database`'s drizzle-orm version.

### Step 1 — Replace the exec call in `dev_env/init-db.mjs`

Current shape (around the `🔄 Running Drizzle migrations...` log):

```js
const { stdout, stderr } = await execAsync('npm run drizzle:migrate', { cwd: __dirname });
```

New shape:

```js
// init-db.mjs is plain JavaScript — no TypeScript type assertions. Use
// optional-chaining / direct property access instead.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const db = drizzle(sql); // sql is the existing postgres-js client
try {
  await migrate(db, { migrationsFolder: join(__dirname, 'database/migrations') });
} catch (error) {
  // Postgres errors carry semantic fields beyond .message — dump them all so
  // an operator reading the deploy log sees the actual failure cause, not a
  // generic "exit 1". The most diagnostic field is usually .where (the
  // PL/pgSQL stack frame) for RAISE EXCEPTION, and .detail for constraint
  // violations.
  process.stderr.write('\n=== drizzle:migrate failed ===\n');
  if (error && typeof error === 'object') {
    for (const field of [
      'code',
      'severity',
      'message',
      'detail',
      'hint',
      'where',
      'schema',
      'table',
      'column',
      'constraint',
    ]) {
      const value = error[field];
      if (value !== undefined) {
        process.stderr.write(`${field}: ${value}\n`);
      }
    }
    if (error.stack) {
      process.stderr.write(`stack: ${error.stack}\n`);
    }
  } else {
    process.stderr.write(String(error) + '\n');
  }
  process.stderr.write('===\n');
  throw error;
}
```

**Note for #726**: extract the formatting block into a reusable `formatPgError(error)` function exported from a small helper module (e.g., `dev_env/format-pg-error.mjs`) so the pre-flight dry-run script #726 ships can import it directly without duplicating the field list.

### Step 2 — Verify the existing `drizzle:migrate` script remains usable

`dev_env/package.init.json` defines `drizzle:migrate` as `drizzle-kit migrate --config 'drizzle.config.ts'`. Keep it — useful for ad-hoc CLI runs where the spinner output is fine. Just don't invoke it from `init-db.mjs`.

### Step 3 — Keep the existing journal-skip detection (Step 3 of init-db.mjs)

The existing post-migrate verification ("Verifies all journal migrations were applied") catches the silent-skip case where Drizzle's `when`-cursor logic skips a migration. Belt-and-suspenders; don't remove it.

## Test plan (TDD)

The failure mode is environmental (CI log capture), not unit-testable in isolation. Use a manual repro:

1. Add a temporary throwaway migration `9999_surface-test.sql` with `DO $$ BEGIN RAISE EXCEPTION 'SURFACE_TEST'; END $$;` and a journal entry.
2. Run `node dev_env/init-db.mjs` against a local DB.
3. Assert: capture stderr; the script must exit non-zero AND its captured stderr must contain the substrings `severity: ERROR`, `message: SURFACE_TEST`, and `where:` (the PL/pgSQL stack frame). Wrap as a shell one-liner so it's repeatable: `node dev_env/init-db.mjs 2>&1 | tee /tmp/out.log; grep -q 'SURFACE_TEST' /tmp/out.log && grep -q 'severity: ERROR' /tmp/out.log && grep -q 'where:' /tmp/out.log || { echo FAIL; exit 1; }`.
4. Compare against current behavior (re-run with the existing exec-based shell-out): only the spinner trailing characters appear; no `SURFACE_TEST` text. The grep above exits 1.
5. Delete the throwaway migration before merging.

Optional unit test: extract the error-formatting block into a pure function (`formatPgError(err): string`) and unit-test against a synthetic `{ code: '...', message: '...', where: '...' }` object. Lower value (the actual failure mode is the integration with drizzle-orm's library), but cheap.

## Risks / gotchas

1. **drizzle-orm and drizzle-kit version skew.** `init-db.mjs` is currently in `dev_env/` with its own `package.init.json` listing minimal deps. Confirm `drizzle-orm` is installed in that mini-package; if only `drizzle-kit` is, add `drizzle-orm` (it's tiny — `migrate()` is a few hundred lines).
2. **postgres-js client lifecycle.** Currently the script creates `const sql = postgres(dbConfig)` at module top. The `drizzle()` wrapper re-uses that client, but `migrate()` may issue its own `BEGIN`/`COMMIT` — verify the client's `max: 1` setting (already configured) doesn't deadlock against migrate's transaction.
3. **NOTICE handling.** drizzle-kit prints PG NOTICEs (the harmless `schema "drizzle" already exists, skipping` ones). drizzle-orm's `migrate()` may or may not surface them. If absent, that's fine — we don't need them for diagnosis. If they pollute the success-path log, suppress with `sql.options.onnotice = () => {}` on the client.
4. **The error object's shape varies by Postgres driver.** postgres-js wraps errors with the `severity` / `code` / `where` fields; pg uses different field names. We're on postgres-js per `drizzle.config.ts`, so the field list above is correct, but if anyone migrates the project to `pg` later, the formatter needs updating.

## Acceptance criteria

- [ ] `dev_env/init-db.mjs` no longer calls `npm run drizzle:migrate` via `execAsync`; it imports and calls `migrate()` from `drizzle-orm/postgres-js/migrator`.
- [ ] Manual repro (per Test Plan step 1-4) confirms `RAISE EXCEPTION` text appears verbatim in stderr.
- [ ] Success-path: a clean migrate on a fresh dev DB completes silently and exits 0; `__drizzle_migrations` cursor advances correctly.
- [ ] Existing journal-skip detection (init-db.mjs step 3) still runs after the migrate.
- [ ] No regression in `npm run ci:testmock` (which exercises the full init-db flow).

## Out of scope

- Filing upstream improvements to drizzle-kit's spinner.
- Removing the `drizzle:migrate` script from `package.init.json` (keep for ad-hoc use).
- Sentry breadcrumb integration for migration runs (separate, optional, deferred to #730 or later).
