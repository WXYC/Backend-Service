/**
 * BS#2714 — `library.search_doc` has a position gap between its segments.
 * BS#3733 added a third segment, `alternate_artist_name` at weight C, behind
 * a second gap, so the title/alternate-name seam is covered here too.
 *
 * `tsvector || tsvector` shifts the right operand's positions to continue from
 * the left's with NO gap, so the album title's first lexeme sat directly
 * adjacent to the artist name's last one and a phrase query matched across the
 * field boundary. Migration 0178 inserts a sentinel between the segments to buy
 * a position shift and then removes it with `ts_delete`, which deletes a
 * lexeme's entry WITHOUT renumbering the survivors.
 *
 * Measured on a 64,193-row production clone before the fix: `'d':* <-> 'a':*`
 * (what `to_tsquery` makes of a `d'a` prefix token) matched 760 rows, 184 of
 * them straddling the seam. After: 576, none cross-boundary.
 *
 * Postgres-backed and deliberately SQL-level: the subject is a generated column,
 * so driving it through HTTP would only add a ranker and a LIMIT between the
 * assertion and the thing being asserted. The probe rows carry `Todd Rundgren` /
 * `Angel Hair` because that is the pair the migration header works through,
 * `Chuquimamani-Condori` / `Edits` for the hyphenated-compound case, and
 * `DJ Krush` / `Cold Krush Cuts` / `DJ Krush & Coldcut` (a real catalog row)
 * for the title/alternate-name seam.
 *
 * Probe ids live in the reserved 7000-range at 7070/7072/7074 — the shape fixture
 * occupies 7000-7009 and `library-query-sort-plays.spec.js` uses 7060/7062 —
 * and reuse fixture artist 7000, genre 11, format 1 so every FK resolves.
 * `library.artist_name` is a denormalized column, so the probe rows can carry
 * text that differs from `artists.artist_name` without touching that table: the
 * 0060 cascade trigger only fires on an `artists` UPDATE, which this spec never
 * does.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'
const PROBE_SEAM = 7070; // 'Todd Rundgren' / 'Angel Hair'
const PROBE_HYPHEN = 7072; // 'Chuquimamani-Condori' / 'Edits'
const PROBE_ALT = 7074; // 'DJ Krush' / 'Cold Krush Cuts' / alternate 'DJ Krush & Coldcut'
const PROBES = [PROBE_SEAM, PROBE_HYPHEN, PROBE_ALT];

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

/** Rows among the probes whose search_doc matches `tsquery`. */
async function matchIds(sql, tsquery) {
  const rows = await sql.unsafe(
    `SELECT id FROM "${SCHEMA}".library
      WHERE id = ANY($1::int[]) AND search_doc @@ to_tsquery('simple', $2)
      ORDER BY id`,
    [PROBES, tsquery]
  );
  return rows.map((r) => r.id);
}

describe('library.search_doc position gap (BS#2714)', () => {
  let sql;

  beforeAll(async () => {
    sql = makeSql();
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, alternate_artist_name)
       VALUES ($1, $2, $3, $4, 'Angel Hair', 70, 'Todd Rundgren', NULL),
              ($5, $2, $3, $4, 'Edits', 72, 'Chuquimamani-Condori', NULL),
              ($6, $2, $3, $4, 'Cold Krush Cuts', 74, 'DJ Krush', 'DJ Krush & Coldcut')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_SEAM, ART, GEN, FMT, PROBE_HYPHEN, PROBE_ALT]
    );
  });

  afterAll(async () => {
    if (sql) {
      // flowsheet.album_id is ON DELETE SET NULL, so any play rows pointing at
      // a probe have to be reaped by album_id BEFORE the library row goes (the
      // column is NULL afterwards and they become unfindable). This spec seeds
      // none, but a concurrent spec could have linked one.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = ANY($1::int[])`, [PROBES]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [PROBES]);
      await sql.end();
    }
  });

  test('a phrase spanning the artist/album seam matches nothing', async () => {
    // `rundgren` ends artist_name and `angel` begins album_title. Before the
    // gap they were at adjacent positions (2 and 3) and this matched.
    expect(await matchIds(sql, `'rundgren' <-> 'angel'`)).toEqual([]);
  });

  test('the seam survives a prefix phrase too', async () => {
    // The reachable form: a prefix token that `to_tsquery` re-lexes into an
    // adjacency chain. This is what BS#670's builder emits, and why the gap is
    // a prerequisite for that work rather than a nicety.
    expect(await matchIds(sql, `'rundgren':* <-> 'ang':*`)).toEqual([]);
  });

  test.each([
    ['title -> alternate name', `'cuts' <-> 'dj'`],
    ['title -> alternate name, prefix phrase', `'cuts':* <-> 'dj':*`],
  ])('a phrase spanning the %s seam matches nothing (BS#3733)', async (_seam, tsquery) => {
    // `cuts` ends album_title and `dj` begins alternate_artist_name. Without
    // the second gap they would sit at adjacent positions and this would
    // match.
    expect(await matchIds(sql, tsquery)).toEqual([]);
  });

  test('a phrase within one field still matches', async () => {
    // The gap must not cost real within-field adjacency: artist-side,
    // album-side, and alternate-name-side.
    expect(await matchIds(sql, `'todd' <-> 'rundgren'`)).toEqual([PROBE_SEAM]);
    expect(await matchIds(sql, `'angel' <-> 'hair'`)).toEqual([PROBE_SEAM]);
    expect(await matchIds(sql, `'krush' <-> 'coldcut'`)).toEqual([PROBE_ALT]);
  });

  test.each([
    ['chuq', 4],
    ['chuquimamani', 12],
    ['chuquimamani-', 13],
    ['chuquimamani-c', 14],
    ['chuquimamani-condor', 19],
    ['chuquimamani-condori', 20],
  ])('every prefix of a hyphenated compound still matches it: %s (%i chars)', async (prefix) => {
    // A hyphenated token lexes to the compound PLUS its parts, so a prefix of
    // it becomes a multi-operand phrase query anchored inside one field --
    // `'chuquimamani-cond':* <-> 'chuquimamani':* <-> 'cond':*`. The gap must
    // leave that intact, which is the whole reason the sentinel sits between
    // the segments rather than the hyphen being sanitized away.
    expect(await matchIds(sql, `'${prefix}':*`)).toEqual([PROBE_HYPHEN]);
  });

  test('the gap sentinel is not reachable from any query', async () => {
    // `ts_delete` removes the sentinel's entry from the stored tsvector, so it
    // is not in the GIN index and no query can match it. This is the assertion
    // that makes leaving the sentinel in place unacceptable: a bare sentinel
    // lexeme would make `'w':*` match every row in the catalog.
    expect(await matchIds(sql, `'wxycsearchdocgap'`)).toEqual([]);
    expect(await matchIds(sql, `'wxycsearchdocgap':*`)).toEqual([]);
    expect(await matchIds(sql, `'w':*`)).toEqual([]);
  });

  test('the alternate name is weight C, behind its own gap (BS#3733)', async () => {
    // C sits below A (artist) and B (title), so an alternate-name-only hit
    // ranks after an artist or title hit on the same word.
    const [row] = await sql.unsafe(`SELECT search_doc::text AS doc FROM "${SCHEMA}".library WHERE id = $1`, [
      PROBE_ALT,
    ]);
    expect(row.doc).toMatch(/'coldcut':\d+C/);
    const titleLast = Number(row.doc.match(/'cuts':(\d+)B/)[1]);
    const altFirst = Number(row.doc.match(/'dj':(?:\d+A,)?(\d+)C/)[1]);
    expect(altFirst - titleLast).toBeGreaterThan(1);
  });

  test('both weight bands survive the rewrite', async () => {
    // Weight bands are what let ts_rank favour an artist hit over a title hit.
    // A/B are asserted through the stored vector rather than through ts_rank so
    // the assertion does not depend on the ranker, which BS#2714's sibling PR
    // changes.
    const [row] = await sql.unsafe(`SELECT search_doc::text AS doc FROM "${SCHEMA}".library WHERE id = $1`, [
      PROBE_SEAM,
    ]);
    expect(row.doc).toMatch(/'rundgren':\d+A/);
    expect(row.doc).toMatch(/'angel':\d+B/);
    // And the gap is visibly there: the album segment does not start at the
    // position right after the artist segment ends.
    const artistLast = Number(row.doc.match(/'rundgren':(\d+)A/)[1]);
    const albumFirst = Number(row.doc.match(/'angel':(\d+)B/)[1]);
    expect(albumFirst - artistLast).toBeGreaterThan(1);
  });
});
