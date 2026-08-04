/**
 * Source-grep guard for `scripts/schema-shape-report.mjs`'s unique-constraint
 * probe (#1982).
 *
 * The probe generates `GROUP BY <key cols> HAVING count(*) > 1` to find rows a
 * new UNIQUE constraint would reject. PostgreSQL indexes are `NULLS DISTINCT`
 * by default, so a row whose key contains a NULL never conflicts with anything
 * — but `GROUP BY` collapses all those NULL rows into one group and the probe
 * reported them as a duplicate group. That produced a 72,599-row phantom
 * violation on `shows.specialty_id` in the #1984 verification run, for an
 * index that applies perfectly cleanly.
 *
 * The behavioural proof is a differential harness against a live PostgreSQL 14
 * (prod's major) that asserts the generated SQL agrees with what
 * `CREATE UNIQUE INDEX` actually does, in both directions, across all-NULL,
 * mixed, multi-column and partial-index cases. That harness cannot live in the
 * unit suite: it needs a real database, and ts-jest's transform doesn't cover
 * `.mjs` (the same reason `format-pg-error.test.ts` and
 * `init-db-historical-replaced.test.ts` source-grep rather than import). Its
 * output is recorded in PR #1984.
 *
 * This file is the cheap tripwire that stops the guard being silently deleted
 * or reverted. It asserts structure, not behaviour — do not mistake it for
 * proof the SQL is correct.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts/schema-shape-report.mjs');
const source = fs.readFileSync(scriptPath, 'utf-8');

/** The body of `buildUniqueWhereClause`, isolated so assertions can't drift into neighbouring functions. */
function uniqueWhereClauseBody(): string {
  const start = source.indexOf('function buildUniqueWhereClause(');
  expect(start).toBeGreaterThan(-1);
  const nextFn = source.indexOf('\nfunction ', start + 1);
  const nextExportedFn = source.indexOf('\nexport function ', start + 1);
  const end = Math.min(nextFn === -1 ? source.length : nextFn, nextExportedFn === -1 ? source.length : nextExportedFn);
  return source.slice(start, end);
}

describe('schema-shape-report.mjs unique-constraint NULL guard (#1982)', () => {
  it('routes the unique probe through buildUniqueWhereClause', () => {
    // The bug was a bare `constraint.where ? ... : ''`, which emitted no NULL
    // guard at all. Pin the call so a revert to the ternary fails here.
    expect(source).toMatch(/const whereClause = buildUniqueWhereClause\(constraint\);/);
  });

  it('never falls back to the bare partial-predicate ternary for the unique case', () => {
    expect(source).not.toMatch(/const whereClause = constraint\.where \? `WHERE \$\{constraint\.where\}` : '';/);
  });

  it('emits an IS NOT NULL guard for every key column', () => {
    const body = uniqueWhereClauseBody();
    // Guard is built by mapping over ALL key columns, not just the first —
    // a multi-column key is exempt from unique enforcement if ANY column is NULL.
    expect(body).toMatch(/constraint\.columns\.map\(/);
    expect(body).toMatch(/IS NOT NULL/);
  });

  it('ANDs the guards together rather than emitting only one', () => {
    expect(uniqueWhereClauseBody()).toMatch(/join\(' AND '\)/);
  });

  it("ANDs a partial index's own predicate with the guard instead of replacing it", () => {
    const body = uniqueWhereClauseBody();
    // `unshift` puts the partial predicate in front of the NULL guards, and the
    // shared `join(' AND ')` above combines them. Replacing (rather than
    // combining) would resurrect the false positive for partial indexes.
    expect(body).toMatch(/if \(constraint\.where\) predicates\.unshift\(/);
  });

  it('exports buildSelect and only runs the CLI when invoked directly', () => {
    // The differential harness imports buildSelect. That is only safe because
    // main() is guarded — an unconditional top-level main() would run the whole
    // report (and try to connect to a database) on import.
    expect(source).toMatch(/export function buildSelect\(/);
    expect(source).toMatch(/const invokedDirectly = /);
    expect(source).toMatch(/if \(invokedDirectly\) \{/);
  });
});
