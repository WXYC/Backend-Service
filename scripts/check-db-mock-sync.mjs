#!/usr/bin/env node
/**
 * Fails if `tests/mocks/database.mock.ts` has drifted from
 * `shared/database/src/schema.ts` (BS#2448).
 *
 * Why this exists: `jest.unit.config.ts` maps `@wxyc/database` — and any path
 * resolving to `shared/database/src/client` — to a hand-written double. Every
 * unit assertion that names a column therefore runs against that double, and
 * would compare the mock to itself. Nothing kept the two in sync, and the
 * failure mode is silent rather than loud: a column missing from a double
 * reads as `undefined`, and
 *
 *     expect(fn).toHaveBeenCalledWith({ format_id: undefined })
 *
 * **matches a call that omitted the key entirely**. So a test pinning a
 * widened `.returning()` column list passed BEFORE the projection was widened
 * — it was asserting nothing. That is how #2409's `rotation.format_id` /
 * `rotation.label_id` got through, and it was noticed only because the
 * implementer of #2410 asked why a test was green before the change that
 * should have made it green.
 *
 * This check is the other half: it imports the REAL schema and reads the mock,
 * so a migration that adds a column without updating the double fails here
 * instead of silently weakening every unit assertion that touches it.
 *
 * The comparison logic lives in `tests/utils/db-mock-parity.ts` (linted, and
 * unit-tested in `tests/unit/scripts/db-mock-sync.test.ts`) because
 * `scripts/**` is excluded from ESLint and `npm run typecheck`. This runner is
 * deliberately thin — the same split, for the same reason, as
 * `scripts/check-better-auth-mock-sync.ts`. Any import/resolution failure is a
 * FAILED check, never a skip, or the tripwire silently disarms itself.
 *
 * The mock is read by parsing its AST rather than importing it: it imports
 * `@jest/globals`, which throws outside a Jest environment.
 *
 * Exit codes (the split lets an operator tell "the check is broken" from
 * "someone forgot to update the double", following check-auth-tables-doc.mjs):
 *   0 — conformant
 *   2 — config/IO error (a required file is missing, or an import failed)
 *   3 — drift (a new missing column/double, or an unqualified sentinel)
 *   4 — extraction found no schema tables or no doubles (a broken parse or a
 *       moved file; the repo always has plenty of both)
 *   5 — the allowlist has entries that are no longer needed, and must shrink
 *
 * Run: npm run check:db-mock-sync
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { compareDbMock, groupFindings, parseMockDoubles } from '../tests/utils/db-mock-parity.ts';
import { DB_MOCK_ALLOWLIST } from '../tests/utils/db-mock-allowlist.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_REL = 'tests/mocks/database.mock.ts';
const SCHEMA_REL = 'shared/database/src/schema.ts';

/**
 * Resolve drizzle-orm from the workspace that actually declares it. A bare
 * import from `scripts/` resolves through the root node_modules only by npm
 * hoisting — an undeclared contract that a future version conflict in another
 * workspace would break, with no diff anywhere near this file.
 *
 * Cross-instance safety: drizzle's `is()` compares the `entityKind` static
 * string up the prototype chain rather than an identity, so it gives the right
 * answer even if this resolved copy differs from the one `schema.ts` imported.
 */
const requireFromDatabasePackage = createRequire(path.join(REPO_ROOT, 'shared', 'database', 'package.json'));

function fail(code, lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

async function main() {
  let drizzle;
  let schema;
  let mockSource;

  try {
    drizzle = await import(requireFromDatabasePackage.resolve('drizzle-orm'));
  } catch (error) {
    fail(2, [
      'FAIL: could not load drizzle-orm from shared/database.',
      'This is a failed check, not a skip — the db-mock drift tripwire cannot run.',
      String(error),
    ]);
  }

  try {
    schema = await import(path.join(REPO_ROOT, SCHEMA_REL));
  } catch (error) {
    fail(2, [
      `FAIL: could not import ${SCHEMA_REL}.`,
      'This is a failed check, not a skip — the db-mock drift tripwire cannot run.',
      String(error),
    ]);
  }

  try {
    mockSource = readFileSync(path.join(REPO_ROOT, MOCK_REL), 'utf8');
  } catch (error) {
    fail(2, [`FAIL: could not read ${MOCK_REL}.`, String(error)]);
  }

  const { getTableColumns, getViewSelectedFields, is, Table, View } = drizzle;

  // Tables AND views: the mock doubles `library_artist_view` and `album_plays`
  // too, and a view's columns drift exactly the same way.
  const schemaTables = new Map();
  for (const [name, value] of Object.entries(schema)) {
    if (!value) continue;
    if (is(value, Table)) schemaTables.set(name, Object.keys(getTableColumns(value)));
    else if (is(value, View)) schemaTables.set(name, Object.keys(getViewSelectedFields(value)));
  }

  const mockDoubles = parseMockDoubles(mockSource, MOCK_REL);

  if (schemaTables.size === 0 || mockDoubles.size === 0) {
    fail(4, [
      `FAIL: extraction came back empty (schema tables: ${schemaTables.size}, mock doubles: ${mockDoubles.size}).`,
      'That is a broken parse or a moved file, not a clean tree — this repo has dozens of both.',
    ]);
  }

  const findings = compareDbMock(schemaTables, mockDoubles, DB_MOCK_ALLOWLIST);
  if (findings.length === 0) {
    console.log(
      `✓ database.mock.ts matches schema.ts (${schemaTables.size} tables/views, ${mockDoubles.size} doubles, ` +
        `${DB_MOCK_ALLOWLIST.missingDoubles.length} absent doubles + ` +
        `${Object.values(DB_MOCK_ALLOWLIST.missingColumns).reduce((n, c) => n + c.length, 0)} columns still allowlisted)`
    );
    return;
  }

  const grouped = groupFindings(findings);
  const stale = grouped.get('stale-allowlist') ?? [];
  const drift = findings.filter((finding) => finding.kind !== 'stale-allowlist');

  if (drift.length > 0) {
    console.error(`FAIL: tests/mocks/database.mock.ts has drifted from schema.ts (${drift.length} finding(s)):\n`);
    for (const kind of ['missing-column', 'missing-double', 'unknown-double', 'unqualified-sentinel']) {
      for (const finding of grouped.get(kind) ?? []) {
        console.error(`  [${finding.kind}] ${finding.detail}`);
      }
    }
    console.error('');
    console.error('Why this matters: the unit suite resolves @wxyc/database to that double, so a column');
    console.error('missing from it reads as `undefined` — and `toHaveBeenCalledWith({ col: undefined })`');
    console.error('MATCHES a call that never passed the key. Every assertion naming the column above is');
    console.error('currently unable to fail, whether or not the production code writes it.');
    console.error('');
    console.error(`Fix: add the column to its double in ${MOCK_REL}, sentinel included —`);
    console.error("  `format_id: 'rotation.format_id'` — the qualifier is what keeps a same-named column");
    console.error('  on another table from being the same value. Do NOT add it to');
    console.error('  tests/utils/db-mock-allowlist.ts; that list records pre-existing debt and may only shrink.');
  }

  if (stale.length > 0) {
    if (drift.length > 0) console.error('');
    console.error(
      `FAIL: tests/utils/db-mock-allowlist.ts has ${stale.length} entr(y/ies) that are no longer needed:\n`
    );
    for (const finding of stale) console.error(`  [${finding.kind}] ${finding.detail}`);
    console.error('');
    console.error('The allowlist is a shrinking debt list, not a config file. Deleting these lines is the');
    console.error('whole fix — it is how closing the drift gets recorded.');
  }

  process.exit(drift.length > 0 ? 3 : 5);
}

main().catch((error) => {
  console.error('FAIL: db-mock-sync check threw unexpectedly.');
  console.error(error);
  process.exit(2);
});
