const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

/**
 * GET /flowsheet/search — gapped-vector seam guard (BS#2726, SQL-routed per
 * the BS#2753 review).
 *
 * `flowsheet.search_doc` concatenates five weighted tsvector segments
 * (artist A, track B, dj_name B, album C, label D — migration 0054) with NO
 * position gap between them, so a `<->` phrase built from a
 * punctuation-bearing token can match text that was never adjacent in any
 * real row — e.g. an artist's last word immediately followed, in tsvector
 * position terms, by the next field's first word. `apps/backend/services/search.service.ts`'s
 * `buildAllFieldMatch` closes this by ANDing a second predicate against a
 * gapped rebuild of the same five segments (`gappedSearchDocSql`), guarded by
 * `strpos(q::text, '<') = 0 OR gapped @@ q` — Postgres's own answer to
 * whether the tsquery it built contains a phrase operator, not a JS
 * prediction. This spec is the one place the fix is checked against a REAL
 * Postgres GIN index and the REAL `simple` text-search parser — the unit
 * tier (`tests/unit/services/search.service.seam-guard.test.ts`) only pins
 * the SQL shape.
 *
 * No trigram fallback is in play anywhere here (every query below is
 * `shouldUseTsvector`-eligible: 3+ chars, contains an ASCII letter), so a
 * seam row's absence from the results is unambiguous — there is no fallback
 * path that could still surface it.
 *
 * Scoping: every probe row carries a fixed PAST `add_time` on one shared day,
 * and every request scopes with `dateRange:<day>..<day> <token>`, following
 * flowsheet-search-cursor-walk.spec.js's explicit-`add_time` + `afterAll`
 * delete-by-id pattern. No marker lexeme sits near a field seam by accident:
 * each seam row's OTHER three fields use vocabulary that shares no lexeme
 * with the row's own seam token.
 *
 * `exactExpr` literals below (e.g. `'pratt''back'` for the token
 * `pratt'back`) are the parameter text `buildPrefixTsquery(value).exactTsquery`
 * builds for that input — every token here is a single word with no `&`-class
 * metacharacter, so the builder's output is just the token quoted and its
 * interior apostrophes doubled (`apps/backend/utils/tsquery.ts`'s `quote`
 * helper). Read off the real builder (BS#2753) rather than hand-derived.
 */
describe('GET /flowsheet/search — gapped-vector seam guard (BS#2726)', () => {
  const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const DAY = '2019-05-02';
  const dateRange = `dateRange:${DAY}..${DAY}`;

  let sql;
  let insertedIds = [];

  beforeAll(() => {
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
      max: 2,
    });
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
    if (sql) await sql.end();
  });

  /** Insert one probe track row on the shared probe day; returns its id. */
  async function seedRow({ artist, track, album, label, djName }) {
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, artist_name, track_title, album_title, record_label, dj_name, play_order, add_time)
       VALUES ('track', $1, $2, $3, $4, $5, $6, TIMESTAMPTZ '${DAY} 12:00:00+00')
       RETURNING id`,
      [artist, track, album ?? null, label ?? null, djName ?? 'DJ Probe', Math.floor(Math.random() * 1e9)]
    );
    insertedIds.push(rows[0].id);
    return rows[0].id;
  }

  /**
   * Direct DB check that a seeded row matches the UNGAPPED `search_doc`
   * column for the given token's exact tsquery expression — i.e. that
   * WITHOUT the guard this row would be a false cross-seam match. Proves
   * each seam test's absence assertion is meaningful rather than vacuous
   * (BS#2753 finding 4): a row that never matched the ungapped column in the
   * first place would "not match" under the guard for a reason that has
   * nothing to do with the guard.
   */
  async function expectUngappedMatch(id, exactExpr) {
    const rows = await sql.unsafe(
      `SELECT 1 FROM "${SCHEMA}".flowsheet WHERE id = $1 AND search_doc @@ to_tsquery('simple', $2)`,
      [id, exactExpr]
    );
    expect(rows.length).toBe(1);
  }

  const search = (q) => request.get('/flowsheet/search').query({ q, page: 0, limit: 50, sort: 'date', order: 'desc' });
  const idsOf = (res) => res.body.results.map((r) => r.id);

  describe('the four field seams', () => {
    let artistTrackId, trackDjId, djAlbumId, albumLabelId;

    beforeAll(async () => {
      // artist -> track: "Jessica Pratt" (last lexeme 'pratt') || "Back, Baby"
      // (first lexeme 'back'). Canonical WXYC example fixture row
      // (wxyc-shared/src/test-utils/wxyc-example-data.json), reused here
      // because #2726's own production measurement table uses this exact
      // cross-seam token.
      artistTrackId = await seedRow({
        artist: 'Jessica Pratt',
        track: 'Back, Baby',
        album: 'On Your Own Love Again',
        label: 'Drag City',
      });
      // track -> dj_name: "Wayward Harbor" (last lexeme 'harbor') || dj_name
      // "Lumen Danvers" (first lexeme 'lumen').
      trackDjId = await seedRow({
        artist: 'Seam Probe Artist',
        track: 'Wayward Harbor',
        album: 'Unrelated Album One',
        label: 'Unrelated Label One',
        djName: 'Lumen Danvers',
      });
      // dj_name -> album: dj_name "Danvers Quill" (last lexeme 'quill') ||
      // album_title "Ember Fathom" (first lexeme 'ember').
      djAlbumId = await seedRow({
        artist: 'Seam Probe Artist',
        track: 'Unrelated Track One',
        album: 'Ember Fathom',
        label: 'Unrelated Label Two',
        djName: 'Danvers Quill',
      });
      // album -> label: album_title "Cinder Lattice" (last lexeme 'lattice')
      // || record_label "Hollow Vantage" (first lexeme 'hollow').
      albumLabelId = await seedRow({
        artist: 'Seam Probe Artist',
        track: 'Unrelated Track Two',
        album: 'Cinder Lattice',
        label: 'Hollow Vantage',
      });
    });

    test('artist -> track seam: the row matches the UNGAPPED column (the absence below is meaningful)', async () => {
      await expectUngappedMatch(artistTrackId, "'pratt''back'");
    });

    test('artist -> track seam: "pratt\'back" does not match the cross-seam row', async () => {
      const res = await search(`${dateRange} pratt'back`).expect(200);
      expect(idsOf(res)).not.toContain(artistTrackId);
    });

    test('track -> dj_name seam: the row matches the UNGAPPED column (the absence below is meaningful)', async () => {
      await expectUngappedMatch(trackDjId, "'harbor''lumen'");
    });

    test('track -> dj_name seam: "harbor\'lumen" does not match the cross-seam row', async () => {
      const res = await search(`${dateRange} harbor'lumen`).expect(200);
      expect(idsOf(res)).not.toContain(trackDjId);
    });

    test('dj_name -> album seam: the row matches the UNGAPPED column (the absence below is meaningful)', async () => {
      await expectUngappedMatch(djAlbumId, "'quill''ember'");
    });

    test('dj_name -> album seam: "quill\'ember" does not match the cross-seam row', async () => {
      const res = await search(`${dateRange} quill'ember`).expect(200);
      expect(idsOf(res)).not.toContain(djAlbumId);
    });

    test('album -> label seam: the row matches the UNGAPPED column (the absence below is meaningful)', async () => {
      await expectUngappedMatch(albumLabelId, "'lattice''hollow'");
    });

    test('album -> label seam: "lattice\'hollow" does not match the cross-seam row', async () => {
      const res = await search(`${dateRange} lattice'hollow`).expect(200);
      expect(idsOf(res)).not.toContain(albumLabelId);
    });

    test('NOT "pratt\'back" DOES return the cross-seam row — negation wraps the whole ANDed guard', async () => {
      // The row does not match the (un-negated) phrase across the seam, so
      // negating that non-match is true for this row. Proves `negated ?
      // NOT (${fragment}) : fragment` wraps the entire guard — including the
      // strpos-gated OR — not just the stored-column recheck's first half.
      const res = await search(`${dateRange} NOT pratt'back`).expect(200);
      expect(idsOf(res)).toContain(artistTrackId);
    });

    // Mutation proof (BS#2753): deleting the `OR ${gappedSearchDocSql()} @@
    // ${q}` arm from buildAllFieldMatch's tsvector branch (leaving only
    // `strpos(...) = 0` as the whole second AND operand, which Postgres then
    // evaluates as plain FALSE for every one of these guarded tokens since
    // their tsquery text always contains `<`) makes the four
    // "does not match the cross-seam row" tests above fail — the guard
    // would always deny the match instead of denying it only across a seam,
    // and the four within-field controls below would also start failing
    // (`don't`, the hyphenated compound). Run manually: this file has
    // nothing left to assert the guard's narrowing once that arm is gone.
  });

  describe('controls that must still be returned', () => {
    let dontStopId, nullFieldsId, hyphenId, plainWordId, janeId;

    beforeAll(async () => {
      dontStopId = await seedRow({
        artist: 'Seam Probe Artist',
        track: "Don't Stop",
        album: 'Some Other Album',
        label: 'Some Other Label',
      });
      // Proves `coalesce`: album_title and record_label are NULL, so without
      // coalesce the `||` chain in gappedSearchDocSql would be NULL and the
      // AND'd guard would silently drop this row even though the phrase
      // lives entirely inside track_title.
      nullFieldsId = await seedRow({
        artist: 'Seam Probe Artist',
        track: "Don't Look Back",
        album: null,
        label: null,
      });
      hyphenId = await seedRow({
        artist: 'Chuquimamani-Condori',
        track: 'Unrelated Track Three',
        album: 'Unrelated Album Three',
        label: 'Unrelated Label Three',
      });
      plainWordId = await seedRow({
        artist: 'Wxycseamguardplainword',
        track: 'Unrelated Track Four',
        album: 'Unrelated Album Four',
        label: 'Unrelated Label Four',
      });
      janeId = await seedRow({
        artist: 'Jane Marker',
        track: 'Unrelated Track Five',
        album: 'Unrelated Album Five',
        label: 'Unrelated Label Five',
      });
    });

    test('within-field apostrophe phrase ("don\'t") still matches — not a seam', async () => {
      const res = await search(`${dateRange} don't`).expect(200);
      expect(idsOf(res)).toContain(dontStopId);
    });

    test('NULL album_title/record_label do not null out the gapped guard (coalesce)', async () => {
      const res = await search(`${dateRange} don't`).expect(200);
      expect(idsOf(res)).toContain(nullFieldsId);
    });

    test('within-field hyphenated compound ("chuquimamani-condori") still matches — not a seam', async () => {
      const res = await search(`${dateRange} chuquimamani-condori`).expect(200);
      expect(idsOf(res)).toContain(hyphenId);
    });

    test('a plain word (no phrase operator in its tsquery) still matches via the bare predicate', async () => {
      const res = await search(`${dateRange} wxycseamguardplainword`).expect(200);
      expect(idsOf(res)).toContain(plainWordId);
    });

    test('behaviour change: a leading "-" no longer excludes ("-jane" returns the jane row)', async () => {
      // Old behaviour (websearch_to_tsquery): `-jane` meant "exclude jane".
      // buildPrefixTsquery quotes the token, and to_tsquery's re-lex
      // discards the leading `-` as a blank, so the same query text is now a
      // POSITIVE match on `jane`. The parser's own NOT operator (see the
      // seam block above) is the supported way to exclude.
      const res = await search(`${dateRange} -jane`).expect(200);
      expect(idsOf(res)).toContain(janeId);
    });
  });

  /**
   * The builder's `exactTsquery` for a phrase-forming apostrophe word is
   * text-identical to what `websearch_to_tsquery` built before BS#2726 --
   * which is what licenses reusing the plan's `websearch_to_tsquery`-era
   * production cost measurements (cursor pages, capped count, forced walk
   * plan) for the post-#2726 builder in docs/playlist-search/README.md,
   * rather than needing a fresh production measurement. `exactExpr` literals
   * are read off the real builder (BS#2753's `compute_exact` check), not
   * re-derived here -- this integration tier has no TS/ESM import path into
   * apps/backend from a CommonJS `.spec.js`.
   */
  describe.each([
    ["it's", "'it''s'"],
    ["don't", "'don''t'"],
    ["i'm", "'i''m'"],
    ['b_side', "'b_side'"],
  ])('builder/websearch tsquery-text equivalence for %j', (word, exactExpr) => {
    test('to_tsquery(exactExpr) equals websearch_to_tsquery(word), as text', async () => {
      const [{ a }] = await sql.unsafe(`SELECT (to_tsquery('simple', $1))::text AS a`, [exactExpr]);
      const [{ b }] = await sql.unsafe(`SELECT (websearch_to_tsquery('simple', $1))::text AS b`, [word]);
      expect(a).toBe(b);
    });
  });
});
