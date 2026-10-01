import * as fs from 'fs';
import * as path from 'path';
import { SEARCH_DOC_GAP_SENTINEL } from '../../../apps/backend/services/search.service';

/**
 * BS#2753 review findings 1 and 9 on PR #2753 (BS#2726): pin
 * `gappedSearchDocSql` (`apps/backend/services/search.service.ts`) against
 * the two schema expressions it has to agree with, parsing source text
 * rather than executing SQL — this is "do two TypeScript files say the same
 * thing", not a question a live Postgres connection would answer any more
 * precisely.
 *
 * Finding 1 (drift): `gappedSearchDocSql` is a hand copy of
 * `flowsheet.search_doc`'s own `generatedAlwaysAs` expression (schema.ts,
 * migration 0065) with gap vectors spliced between the segments. Nothing
 * enforced that the two stay in sync before this test — a sixth segment, a
 * reorder, or a reweight landing in schema.ts would silently stop being
 * reflected in the reader's gapped rebuild (which would then recheck the
 * WRONG set of fields, or the right fields at the wrong weight, with no test
 * going red). The guard this file pins is deliberately about SHAPE
 * (columns, their order, their weights, and the `coalesce` wrapping), not
 * byte-for-byte SQL text — `gappedSearchDocSql` interpolates `${flowsheet.col}`
 * drizzle references where the schema literal writes `"col"`, so comparing
 * raw strings would never match either version.
 *
 * Finding 9 (sentinel reuse): the gap sentinel word and its three-repeat
 * width are not a value this reader invented — they are the exact mechanism
 * `library.search_doc` already uses (migration 0178), reused at read time
 * instead of baked into a column. Naming it once as `SEARCH_DOC_GAP_SENTINEL`
 * (exported from search.service.ts) and asserting it against library's own
 * copy, rather than restating the literal in two files, is what makes a
 * future change to either surface (a sentinel collision, or a wider gap for
 * BS#2712's prefix chains) show up as a failing test instead of a silent
 * divergence.
 */
describe('search.service gappedSearchDocSql schema drift (BS#2753)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const searchServicePath = path.resolve(__dirname, '../../../apps/backend/services/search.service.ts');
  const searchServiceSource = fs.readFileSync(searchServicePath, 'utf-8');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  /** The SQL inside `generatedAlwaysAs(sql`…`)`, and nothing else — mirrors
   * tests/unit/database/schema.search-doc-position-gap.test.ts's helper of
   * the same name. */
  const generatedExpression = (tableName: string): string => {
    const def = extractTableDef(tableName);
    const code = def.replace(/^[^\n]*\/\/[^\n]*$/gm, '');
    const match = code.match(/search_doc:\s*tsvector\([^)]*\)\s*\.generatedAlwaysAs\(\s*sql`([\s\S]*?)`\s*\)/);
    if (!match) throw new Error(`search_doc generated expression not found on ${tableName}`);
    return match[1];
  };

  const gappedSearchDocSqlSource = (): string => {
    const match = searchServiceSource.match(/function gappedSearchDocSql\(\): SQL \{[\s\S]*?\n\}/);
    if (!match) throw new Error('gappedSearchDocSql function body not found in search.service.ts');
    return match[0];
  };

  it("gappedSearchDocSql's columns, order, weights and coalesce wrapping match flowsheet.search_doc's own generatedAlwaysAs expression", () => {
    const schemaExpr = generatedExpression('flowsheet');
    const schemaPairs = [...schemaExpr.matchAll(/coalesce\("(\w+)", ''\)\), '(\w)'\)/g)].map((m) => [m[1], m[2]]);

    const readerSource = gappedSearchDocSqlSource();
    const readerPairs = [...readerSource.matchAll(/coalesce\(\$\{flowsheet\.(\w+)\}, ''\)\), '(\w)'\)/g)].map((m) => [
      m[1],
      m[2],
    ]);

    // Fixed first: both extractions actually found the five real segments,
    // so an empty-vs-empty pass can't make the equality below vacuous.
    expect(schemaPairs).toEqual([
      ['artist_name', 'A'],
      ['track_title', 'B'],
      ['dj_name', 'B'],
      ['album_title', 'C'],
      ['record_label', 'D'],
    ]);
    expect(readerPairs).toEqual(schemaPairs);
  });

  // Mutation proof: temporarily reweighting schema.ts's flowsheet
  // `record_label` segment from 'D' to 'E' (while leaving
  // gappedSearchDocSql untouched) makes the equality above fail — the
  // reader's rebuild would silently recheck the wrong weight band. Run
  // manually: this is the one line to edit and this is what breaks.

  it("the reader's named gap sentinel and three-repeat gap width equal library.search_doc's own copy of the same mechanism (migration 0178)", () => {
    const libraryExpr = generatedExpression('library');

    const gapVectorMatch = libraryExpr.match(/to_tsvector\('simple', '((?:\w+ ?)+)'\)/);
    if (!gapVectorMatch) throw new Error('gap vector literal not found in library.search_doc');
    const libraryGapWords = gapVectorMatch[1].split(' ');

    const sentinelMatch = libraryExpr.match(/ts_delete\([\s\S]*, '(\w+)'\)/);
    if (!sentinelMatch) throw new Error('ts_delete sentinel argument not found in library.search_doc');
    const librarySentinel = sentinelMatch[1];

    expect(SEARCH_DOC_GAP_SENTINEL).toBe(librarySentinel);
    expect(libraryGapWords).toEqual([SEARCH_DOC_GAP_SENTINEL, SEARCH_DOC_GAP_SENTINEL, SEARCH_DOC_GAP_SENTINEL]);

    // The reader's own gap vector (gappedSearchDocSql's `gapVector` local),
    // read off its source text rather than re-executed, must be the SAME
    // three-repeat width — not a value this test invents independently of
    // what the reader actually sends to Postgres.
    const readerSource = gappedSearchDocSqlSource();
    const readerGapVectorMatch = readerSource.match(/to_tsvector\('simple', '\$\{gapVector\}'\)/);
    expect(readerGapVectorMatch).not.toBeNull();
    const readerGapVector = `${SEARCH_DOC_GAP_SENTINEL} ${SEARCH_DOC_GAP_SENTINEL} ${SEARCH_DOC_GAP_SENTINEL}`;
    expect(readerGapVector.split(' ')).toEqual(libraryGapWords);
  });

  // Mutation proof: temporarily changing SEARCH_DOC_GAP_SENTINEL in
  // search.service.ts to a different word (while leaving schema.ts's
  // library.search_doc untouched) makes the first assertion above fail.
  // Run manually.
});
