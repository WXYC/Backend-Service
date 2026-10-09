import { readFileSync } from 'fs';
import { join } from 'path';
import { LINKAGE_SOURCES } from '../../../shared/database/src/schema';

/**
 * BS#3078: `flowsheet.linkage_source` is typed as a closed `LinkageSource` union for TypeScript writers; this
 * suite covers the two writers the compiler cannot see: raw-SQL literals, and the Python stamps builder behind the
 * bridge/fuzzy scripts. The type-level guard lives in `shared/database/src/linkage-source.type-test.ts`.
 */

const ROOT = join(__dirname, '../../..');
const RAW_SQL_WRITERS = [
  'jobs/legacy-linkage-resolve/job.ts',
  'jobs/flowsheet-linkage-audit-backfill/job.ts',
  'scripts/direct-link-flowsheet.sql',
  'scripts/discogs-bridge-flowsheet.sql',
  'scripts/fuzzy-trigram-flowsheet.sql',
  'scripts/review-linkage.ts',
];

/** Every `linkage_source = '<v>'` literal, plus the THEN/ELSE arms of a `linkage_source = CASE ... END`. */
function extractLinkageSourceLiterals(text: string): string[] {
  const literals = [...text.matchAll(/linkage_source"?\s*=\s*'([^']*)'/g)].map((m) => m[1]);
  for (const m of text.matchAll(/linkage_source"?\s*=\s*CASE([\s\S]*?)\bEND\b/g)) {
    literals.push(...[...m[1].matchAll(/\b(?:THEN|ELSE)\s+'([^']*)'/g)].map((a) => a[1]));
  }
  return literals;
}

describe('linkage_source vocabulary', () => {
  it.each(RAW_SQL_WRITERS)('%s stamps only LINKAGE_SOURCES values', (file) => {
    const literals = extractLinkageSourceLiterals(readFileSync(join(ROOT, file), 'utf8'));
    expect(literals.length).toBeGreaterThan(0);
    const unknown = literals.filter((v) => !(LINKAGE_SOURCES as readonly string[]).includes(v));
    expect(unknown).toEqual([]);
  });

  it('extracts CASE arms from the audit backfill', () => {
    const literals = extractLinkageSourceLiterals(
      readFileSync(join(ROOT, 'jobs/flowsheet-linkage-audit-backfill/job.ts'), 'utf8')
    );
    expect(literals).toEqual(expect.arrayContaining(['etl_legacy_id', 'dj_bin_pick']));
  });

  // The bridge/fuzzy SQL scripts only mention their label in comments; the stamps builder writes it, from its
  // `--linkage-source` argument. argparse `choices` makes the builder refuse a non-member, so pin that tuple to the
  // union, and every documented invocation (the runbooks the operator copies) to it.
  const BUILDER = 'scripts/build-flowsheet-stamps-sql.py';

  it('the stamps builder accepts exactly LINKAGE_SOURCES', () => {
    const text = readFileSync(join(ROOT, BUILDER), 'utf8');
    const tuple = text.match(/^LINKAGE_SOURCES = \(([\s\S]*?)^\)/m);
    expect(tuple).not.toBeNull();
    const values = [...(tuple?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect([...values].sort()).toEqual([...LINKAGE_SOURCES].sort());
    expect(text).toMatch(/"--linkage-source",\s*required=True,\s*choices=LINKAGE_SOURCES,/);
  });

  it.each([BUILDER, 'scripts/discogs-bridge-flowsheet.sql', 'scripts/fuzzy-trigram-flowsheet.sql'])(
    '%s documents --linkage-source only with LINKAGE_SOURCES values',
    (file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const values = [...text.matchAll(/--linkage-source[\s=]+(\w+)/g)].map((m) => m[1]);
      expect(values.length).toBeGreaterThan(0);
      expect(values.filter((v) => !(LINKAGE_SOURCES as readonly string[]).includes(v))).toEqual([]);
    }
  );
});
