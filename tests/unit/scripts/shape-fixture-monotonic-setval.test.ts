/**
 * Regression test for BS#1728.
 *
 * `tests/fixtures/shape.sql` advances its sequences past the fixture's
 * 7000-range IDs with `setval(...)` so subsequent serial inserts from tests
 * or app code don't collide with fixture rows. Against a clean CI database
 * that's harmless — but `npm run db:start` in dev also loads
 * `dev_env/seed-clone.sql` (a prod snapshot) *before* the shape fixture,
 * which advances the same sequences to their real prod watermarks (e.g.
 * `library_id_seq` to 70351). A bare `setval('...', 7099, true)` REWINDS
 * the sequence below `MAX(id)`, so the next serial insert collides with an
 * existing clone row and every integration suite that inserts against that
 * table fails with a duplicate-key pkey violation.
 *
 * The fix: every setval in the fixture must be monotonic — it should only
 * ever advance the sequence, via `GREATEST(<fixed-floor>, (SELECT
 * last_value FROM <seq>))` — so it establishes the fixture's ID-range floor
 * against a clean DB without ever rewinding a sequence that's already ahead.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const fixturePath = path.join(repoRoot, 'tests/fixtures/shape.sql');
const fixtureSql = fs.readFileSync(fixturePath, 'utf-8');

// Matches `SELECT setval('wxyc_schema.foo_id_seq', ...);` bodies, capturing
// the sequence name and everything between the sequence name and the
// trailing `, true)` so we can assert the "value" argument is the
// monotonic GREATEST(...) form rather than a bare integer literal.
const SETVAL_RE = /SELECT\s+setval\(\s*'([^']+)'\s*,\s*([\s\S]*?)\s*,\s*true\s*\)\s*;/g;

interface SetvalCall {
  sequence: string;
  valueExpr: string;
}

function findSetvalCalls(sql: string): SetvalCall[] {
  const calls: SetvalCall[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SETVAL_RE);
  while ((m = re.exec(sql)) !== null) {
    calls.push({ sequence: m[1], valueExpr: m[2] });
  }
  return calls;
}

describe('tests/fixtures/shape.sql sequence advances (BS#1728)', () => {
  const calls = findSetvalCalls(fixtureSql);

  it('contains at least one setval call (sanity check the regex still matches the file)', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('every setval call uses the monotonic GREATEST(floor, last_value) form', () => {
    for (const { sequence, valueExpr } of calls) {
      // The value expression must reference GREATEST(...) and read the
      // sequence's own last_value, not just hardcode a fixed integer.
      expect(valueExpr).toMatch(/GREATEST\s*\(/i);
      expect(valueExpr).toMatch(/last_value/i);
      expect(valueExpr).toContain(sequence);
    }
  });

  it('no setval call regresses to a bare fixed-integer value (the BS#1728 bug shape)', () => {
    // Matches the pre-fix pattern: setval('<seq>', <digits>, true) with no
    // GREATEST/last_value wrapping around the digits.
    const bareFixedRe = /SELECT\s+setval\(\s*'[^']+'\s*,\s*\d+\s*,\s*true\s*\)\s*;/g;
    expect(fixtureSql).not.toMatch(bareFixedRe);
  });

  it('covers every sequence the fixture touches (labels, artists, library, rotation, shows, flowsheet, compilation_track_artist)', () => {
    const sequences = new Set(calls.map((c) => c.sequence));
    for (const expected of [
      'wxyc_schema.labels_id_seq',
      'wxyc_schema.artists_id_seq',
      'wxyc_schema.library_id_seq',
      'wxyc_schema.rotation_id_seq',
      'wxyc_schema.shows_id_seq',
      'wxyc_schema.flowsheet_id_seq',
      'wxyc_schema.compilation_track_artist_id_seq',
    ]) {
      expect(sequences.has(expected)).toBe(true);
    }
  });
});
