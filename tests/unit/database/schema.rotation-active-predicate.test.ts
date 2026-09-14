/**
 * BS#2479: the canonical active-rotation predicate (`kill_date IS NULL OR
 * kill_date > CURRENT_DATE`) must be spelled ONCE — `rotationActiveSql()` in
 * `shared/database/src/schema.ts`, next to `rotation` itself — and every
 * other rotation read must consume that fragment rather than retyping the
 * predicate. Before this issue the predicate was hand-rolled independently
 * across library.service.ts, the rotation-tracks cache warmer, the library
 * tiebreak, and several jobs — a silent drift risk, since a future edit to
 * one spelling would not touch the others.
 *
 * Pure file-reading guard over the WHOLE deployed source tree (`apps/`,
 * `jobs/`, `shared/`), in the style of `schema.rotation-cards.test.ts`: it
 * greps source text rather than exercising the query builder, because the
 * thing under test is "how many places spell this predicate," which a mocked
 * `db.execute` call can't observe. It matches the spellings grep can see —
 * the `${...kill_date}` sql-template interpolations, the `"kill_date"`
 * double-quoted raw-SQL form (both operand orders, with or without an alias
 * qualifier), and Drizzle operator-helper comparisons over
 * `rotation.kill_date` — and pins every surviving occurrence in an explicit
 * allowlist, each entry carrying the reason it may exist. A new spelling in
 * any file, or a new occurrence in an allowlisted file, fails here.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['apps', 'jobs', 'shared'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'migrations', '.turbo']);

/**
 * Files allowed to carry a hand-written spelling, with the exact number they
 * may carry and why. Anything else must consume `rotationActiveSql()`.
 */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  // 1: the definition itself. 2: `library_artist_view`'s rotation LEFT JOIN —
  // that spelling is frozen into the deployed database by migration 0166's
  // applied DDL, so the TS mirror must keep the exact bytes the view was
  // created from; consuming the runtime fragment there would change nothing
  // in production (no migration re-CREATEs the view) while letting the mirror
  // silently disagree with it. Documented at the leftJoin in schema.ts.
  'shared/database/src/schema.ts': { count: 2, reason: 'definition site + 0166-frozen library_artist_view mirror' },
  // These two jobs alias `rotation` (`FROM ... r`) inside hand-written
  // multi-join SQL. The shared fragment interpolates schema-qualified
  // UNALIASED `rotation` column references, which Postgres cannot resolve
  // against an aliased FROM entry — so these spellings cannot consume it
  // without de-aliasing one-shot job queries. Pinned at one each: the count
  // may only shrink.
  'jobs/uncovered-release-list/rotation.ts': { count: 1, reason: 'aliased `r` raw SQL; fragment is unaliased' },
  'jobs/rotation-release-id-backfill/query.ts': { count: 1, reason: 'aliased `r` raw SQL; fragment is unaliased' },
};

// The two operand orders of the sql-template interpolated form, e.g.
// `${rotation.kill_date} IS NULL OR ${rotation.kill_date} > CURRENT_DATE`.
// Comments never interpolate `${...kill_date}`, so prose can't false-positive.
const INTERPOLATED =
  /\$\{[A-Za-z_$][\w$.]*\.kill_date\}\s*(?:IS NULL\s*OR\s*\$\{[A-Za-z_$][\w$.]*\.kill_date\}\s*>\s*CURRENT_DATE|>\s*CURRENT_DATE\s*OR\s*\$\{[A-Za-z_$][\w$.]*\.kill_date\}\s*IS NULL)/g;

// The two operand orders of the raw double-quoted form, with an optional
// alias qualifier (`r."kill_date"`). Docblocks spell the predicate without
// double quotes, so prose can't false-positive here either.
const RAW_QUOTED =
  /(?:[A-Za-z_]\w*\.)?"kill_date"\s+IS\s+NULL\s+OR\s+(?:[A-Za-z_]\w*\.)?"kill_date"\s*>\s*CURRENT_DATE|(?:[A-Za-z_]\w*\.)?"kill_date"\s*>\s*CURRENT_DATE\s+OR\s+(?:[A-Za-z_]\w*\.)?"kill_date"\s+IS\s+NULL/g;

// Drizzle operator-helper comparisons over the live column — the shape a
// query-builder retype would take (`or(isNull(rotation.kill_date),
// gt(rotation.kill_date, ...))`). Any occurrence is a retype: the one
// legitimate builder-side use of the column's active window is the fragment.
const BUILDER_HELPERS = /\b(?:isNull|gt|gte|lt|lte)\(\s*[\w$.]*\.kill_date\s*[,)]/g;

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const sourceFiles = SCAN_ROOTS.flatMap((root) => walk(path.join(repoRoot, root), []));

const countSpellings = (source: string): number =>
  (source.match(INTERPOLATED) ?? []).length +
  (source.match(RAW_QUOTED) ?? []).length +
  (source.match(BUILDER_HELPERS) ?? []).length;

describe('canonical active-rotation predicate is spelled once, tree-wide (BS#2479)', () => {
  it('scans a plausible number of source files (the walk is not silently empty)', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('the definition lives in shared/database/src/schema.ts and is exported', () => {
    const schemaSource = fs.readFileSync(path.join(repoRoot, 'shared/database/src/schema.ts'), 'utf-8');
    expect(schemaSource).toMatch(/export const rotationActiveSql = \(\): SQL =>/);
  });

  it('no file outside the allowlist hand-types the predicate, and allowlisted files carry exactly their pinned count', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const relative = path.relative(repoRoot, file);
      const found = countSpellings(fs.readFileSync(file, 'utf-8'));
      const allowed = ALLOWLIST[relative]?.count ?? 0;
      if (found !== allowed) {
        violations.push(
          `${relative}: ${found} hand-written spelling(s), ${allowed} allowed` +
            (allowed > 0 ? ` (${ALLOWLIST[relative].reason})` : ' — consume rotationActiveSql() from @wxyc/database')
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('every allowlist entry still points at a real file (a moved/deleted file must leave the allowlist)', () => {
    for (const relative of Object.keys(ALLOWLIST)) {
      expect(fs.existsSync(path.join(repoRoot, relative))).toBe(true);
    }
  });

  it('the known consumers invoke the shared fragment', () => {
    // Not a full census (the tree scan above is the census) — this pins the
    // call sites the consolidation converted, so a revert to a local copy in
    // any one of them fails by name.
    const consumers = [
      'apps/backend/services/library.service.ts',
      'apps/backend/services/rotation-tracks-cache-warm.service.ts',
      'shared/database/src/library-tiebreak.ts',
      'jobs/rotation-lml-identity-backfill/query.ts',
      'jobs/rotation-artist-backfill/query.ts',
    ];
    for (const relative of consumers) {
      const source = fs.readFileSync(path.join(repoRoot, relative), 'utf-8');
      expect(`${relative}: ${/rotationActiveSql\(\)/.test(source)}`).toBe(`${relative}: true`);
    }
  });
});
