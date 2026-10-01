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
 * As of WXYC/Backend-Service#2712 PR 2, every query below IS tsvector-eligible
 * (3+ chars, contains an ASCII letter) and so also runs the `'substring'`
 * tier when the earlier tiers come back empty — which every seam query here
 * does, by design (the cross-seam phrase never matches the ungapped column
 * as a whole word either). That tier ORs in a four-column ILIKE-contains
 * predicate per eligible token, but a seam row's absence stays meaningful:
 * the cross-seam STRING (e.g. `pratt'back`, with the apostrophe) never
 * appears as a literal substring of any ONE column — it is only the gapped
 * vector's seam-adjacency that could have matched it, and ILIKE has no seam
 * to cross. Confirmed by running this spec end to end after PR 2 landed; no
 * seam assertion below changed.
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

  /**
   * Tiered matching and the cascade (WXYC/Backend-Service#2712): the
   * `'word'` tier runs first (today's whole-lexeme-only predicate,
   * byte-identical to pre-#2712 `main`), and `searchFlowsheet` only tries
   * the `'prefix'` tier when the `'word'` tier's page comes back EMPTY.
   * Every fixture below is deliberately disambiguated (a `wxycprefixprobe*`
   * vocabulary unique to this describe block) so the word tier is
   * provably empty or provably non-empty for the exact query under test,
   * rather than relying on luck against the rest of this file's shared
   * dateRange data. Reuses this file's `seedRow` / `search` / `idsOf` /
   * `dateRange` helpers and the same real-Postgres GIN index this whole
   * spec exercises.
   */
  describe('tiered matching and the cascade (WXYC/Backend-Service#2712)', () => {
    let autechreId, warpaintId, artFormId, artifactsId, canId, candyId, prattBaWithinFieldId, trailingShortTermId;

    beforeAll(async () => {
      autechreId = await seedRow({
        artist: 'Wxycprefixprobe Autechre',
        track: 'Unrelated Track Six',
        album: 'Unrelated Album Six',
        label: 'Unrelated Label Six',
      });
      // Dedicated fixture for the "trailing short term ends the search FOR
      // THE PREFIX TIER" case: "am" is a genuine whole-word lexeme here (not
      // just filler), so under the pre-#2712 rule (skip past an ineligible
      // trailing term) "autec" would be reachable as the typing term and the
      // row would match via the 'prefix' tier's CASE; under the shipped rule
      // the typing-term SCAN ends at "am" (too short for shouldUseTsvector),
      // so there is no typing term and the 'prefix' tier never runs. As of
      // PR 2, that does NOT mean no cascade at all: `tiersFor`'s 'substring'
      // gate is independent of the typing term ("autec" alone still
      // qualifies as an eligible condition), so the cascade still advances
      // from 'word' to 'substring' once 'word' is empty, and ILIKE-contains
      // matches "autec" against "autechretrailing" there -- see the test
      // below, which now expects the row, not its absence.
      trailingShortTermId = await seedRow({
        artist: 'Wxycprefixprobetrailing Autechretrailing',
        track: 'Am Unrelated Track Fourteen',
        album: 'Unrelated Album Fourteen',
        label: 'Unrelated Label Fourteen',
      });
      warpaintId = await seedRow({
        artist: 'Wxycprefixprobedeeper Warpaintprobe',
        track: 'Unrelated Track Seven',
        album: 'Unrelated Album Seven',
        label: 'Unrelated Label Seven',
      });
      // Two-word-query pair, the plan's own worked example ("art ens does
      // not match artifacts"): the query term "wxycprefixprobeart" is a
      // true STRING prefix of both "wxycprefixprobeart" (artFormId's whole
      // first word) and "wxycprefixprobeartifacts" (artifactsId's whole
      // first word, which merely STARTS WITH the query term); the second
      // query term "wxycprefixprobeens" is a true prefix of both rows'
      // track first word. Neither row matches BOTH conditions as complete
      // words, so the 'word' tier is empty for this query and the cascade
      // reaches 'prefix'; there, only the LAST term (the typing term) is
      // prefix-matched, so only artFormId -- whose first word is an EXACT
      // match on the first (non-typing) term -- should return.
      artFormId = await seedRow({
        artist: 'Wxycprefixprobeart Form',
        track: 'Wxycprefixprobeensemble Live',
        album: 'Unrelated Album Eight',
        label: 'Unrelated Label Eight',
      });
      artifactsId = await seedRow({
        artist: 'Wxycprefixprobeartifacts Collective',
        track: 'Wxycprefixprobeensemble Suite',
        album: 'Unrelated Album Nine',
        label: 'Unrelated Label Nine',
      });
      // The "can"/"candy" case from the plan: canId's artist IS the exact
      // word "wxycprefixprobecan"; candyId's artist merely STARTS WITH it
      // ("wxycprefixprobecandy"). Querying the bare word must return ONLY
      // canId -- the 'word' tier already matches it (non-empty page), so
      // the cascade stops there and never reaches the 'prefix' tier that
      // would (wrongly) also prefix-match candyId.
      canId = await seedRow({
        artist: 'Wxycprefixprobecan',
        track: 'Unrelated Track Eleven',
        album: 'Unrelated Album Eleven',
        label: 'Unrelated Label Eleven',
      });
      candyId = await seedRow({
        artist: 'Wxycprefixprobecandy',
        track: 'Unrelated Track Twelve',
        album: 'Unrelated Album Twelve',
        label: 'Unrelated Label Twelve',
      });
      // WITHIN-FIELD phrase fixture (not the cross-seam artist->track one
      // above): "wxycprefixprobepratt'back" lives entirely inside
      // track_title, so no field-seam gap is in play at all -- the gapped
      // guard cannot be what keeps this row out. "wxycprefixprobepratt'ba"
      // tokenizes to the phrase 'wxycprefixprobepratt' <-> 'ba' (two
      // lexemes -- `exactTsquery` contains `<`), so the 'prefix' tier's
      // CASE must take the ELSE arm (exact phrase, unprefixed) rather than
      // prefix the phrase's last lexeme ('ba':*), which WOULD match
      // '...back' and wrongly return this row. Proven by mutation: see the
      // test below.
      prattBaWithinFieldId = await seedRow({
        artist: 'Unrelated Artist Thirteen',
        track: "Wxycprefixprobepratt'back Suite",
        album: 'Unrelated Album Thirteen',
        label: 'Unrelated Label Thirteen',
      });
    });

    test('a partial of a seeded artist returns the row via the prefix-tier cascade ("autec" matches "Autechre")', async () => {
      const res = await search(`${dateRange} wxycprefixprobe autec`).expect(200);
      expect(idsOf(res)).toContain(autechreId);
    });

    test('the word tier stops the cascade: a completed word returns only the whole-word row, never a same-prefix row ("can" vs "candy")', async () => {
      const res = await search(`${dateRange} wxycprefixprobecan`).expect(200);
      const ids = idsOf(res);
      expect(ids).toContain(canId);
      // candyId would ALSO match if the cascade reached the 'prefix' tier
      // (a true string prefix of "wxycprefixprobecandy") -- it must not,
      // because the 'word' tier already matched canId and the cascade
      // never advances past a non-empty page.
      expect(ids).not.toContain(candyId);
    });

    test('a partial of the first word in a two-word query does not match by prefix (matches only the row whose first word is the complete word)', async () => {
      const res = await search(`${dateRange} wxycprefixprobeart wxycprefixprobeens`).expect(200);
      const ids = idsOf(res);
      expect(ids).toContain(artFormId);
      expect(ids).not.toContain(artifactsId);
    });

    test('NOT <partial> does not exclude the full word, even via the prefix-tier cascade ("NOT warp" does not exclude "Warpaintprobe")', async () => {
      // Sanity: the row is reachable at all.
      const sanity = await search(`${dateRange} warpaintprobe`).expect(200);
      expect(idsOf(sanity)).toContain(warpaintId);

      // "wxycprefixprobedeep" (dropping the row's trailing "er") is only a
      // PREFIX of the row's actual first word "wxycprefixprobedeeper", not
      // a complete word anywhere -- the 'word' tier is empty for this
      // query, forcing the cascade into 'prefix', so this exercises the
      // negation skip under the SAME tier the earlier tests do.
      const negated = await search(`${dateRange} wxycprefixprobedeep NOT warp`).expect(200);
      // A negated term is never the typing term (`findTypingTermIndex`
      // skips it), so "warp" stays an exact lexeme in EVERY tier and does
      // not match "warpaintprobe" -- `NOT warp` is true for this row, not
      // false.
      expect(idsOf(negated)).toContain(warpaintId);
    });

    test('a within-field phrase-shaped partial ("pratt\'ba") is not prefix-matched -- pinned to the "prefix" tier directly, the row is absent', async () => {
      // A cursor pins its own tier and never cascades (see
      // flowsheet-search-cursor-walk.spec.js), so requesting with a cursor
      // already marked `_pfx` runs ONLY the 'prefix' tier end to end against
      // real Postgres -- the same invariant this test pinned before PR 2
      // added a 'substring' tier that would otherwise recover this same row
      // (see the test below) and mask a regression here. The cursor's
      // boundary is set after every row this file seeds on `DAY`, so nothing
      // seeded is excluded by the cursor predicate itself.
      const pinnedToPrefix = `${DAY}T12:00:01.000000Z_1_pfx`;
      const res = await search(`${dateRange} wxycprefixprobepratt'ba`).query({ cursor: pinnedToPrefix }).expect(200);
      expect(idsOf(res)).not.toContain(prattBaWithinFieldId);
    });

    test('a within-field phrase-shaped partial ("pratt\'ba") IS recovered by the substring tier (WXYC/Backend-Service#2712, PR 2)', async () => {
      // Unlike the pinned-prefix check above, the ordinary (cascading)
      // request reaches 'substring' once 'word' and 'prefix' both come back
      // empty -- "wxycprefixprobepratt'ba" is a literal substring of the
      // row's own track_title "Wxycprefixprobepratt'back Suite" (its first
      // 23 characters), so the four-column ILIKE-contains predicate matches
      // it even though no tsquery-shaped predicate ever did.
      const res = await search(`${dateRange} wxycprefixprobepratt'ba`).expect(200);
      expect(idsOf(res)).toContain(prattBaWithinFieldId);
    });

    test('a trailing 1-2 char bare term ends the search for the PREFIX tier only -- the SUBSTRING tier still reaches the row (WXYC/Backend-Service#2712, PR 2)', async () => {
      // "am" (2 chars) ends findTypingTermIndex's backward scan, so there is
      // no typing term and the 'prefix' tier's CASE never runs -- "autec"
      // never gets prefix-matched. But `tiersFor`'s 'substring' gate does not
      // key off the typing term at all: "wxycprefixprobetrailing" and
      // "autec" both independently qualify as eligible conditions, so once
      // the 'word' tier comes back empty (the row's artist/track words don't
      // EXACTLY equal "autec"), the cascade advances to 'substring', where
      // "autec" matches via ILIKE-contains against "...Autechretrailing" and
      // "am" matches (as it always has) via its own ILIKE-contains branch.
      const res = await search(`${dateRange} wxycprefixprobetrailing autec am`).expect(200);
      expect(idsOf(res)).toContain(trailingShortTermId);
    });

    // Mutation proof (manual; run during implementation, against this real
    // backend + Postgres, not just the unit mocks): swapping `E` for `P`
    // throughout the 'prefix' tier's ELSE arm -- `(search_doc @@ P AND
    // gapped @@ P)` instead of `(search_doc @@ E AND gapped @@ E)`, keeping
    // the AND-gapped STRUCTURE but prefixing the phrase instead of falling
    // back to the exact form -- makes ONLY the pinned-prefix test above go
    // red (24 passed, 1 failed, confirmed, this file alone): "ba":*
    // prefix-matches "...back" even inside one field, where there is no seam
    // gap to stop it. As of PR 2, this mutation is observable ONLY through
    // the pinned-prefix request -- the ordinary cascading request (the
    // "IS recovered by the substring tier" test) returns the row in both the
    // buggy and the fixed world, since 'substring' independently recovers it
    // via ILIKE-contains regardless of what the 'prefix' tier's ELSE arm
    // does; pinning the cursor to 'prefix' is what isolates the regression
    // again. The four CROSS-SEAM tests above do NOT catch this mutation --
    // confirmed by running it -- because the gapped vector's position
    // shift still defeats `gapped @@ P` across a field seam exactly as it
    // defeats `gapped @@ E`; that half of the guard is prefix-agnostic. A
    // CRUDER mutation that also drops the `AND gapped @@` half entirely
    // (bare `search_doc @@ P`) does NOT isolate the two questions -- it
    // breaks the seam guard too and the cross-seam tests go red alongside
    // this one -- which is why the pinned-prefix fixture exists: it is the
    // only one of the two that proves the prefix-vs-exact choice
    // specifically, independent of the seam guard.
  });

  /**
   * The 'substring' tier (WXYC/Backend-Service#2712, PR 2): recall that
   * neither 'word' nor 'prefix' can reach -- a mid-word fragment, a fragment
   * alongside a word that only matches via `dj_name` (not ILIKE-covered, so
   * the OR must fall back to the word-tier predicate to keep it), and the
   * complementary case to PR 1's "art ens" fixture (both terms a true
   * fragment, neither a prefix, so 'word' AND 'prefix' are both empty and
   * only 'substring' matches). Dedicated `wxycsubprobe*` vocabulary, same
   * pattern as the "tiered matching and the cascade" fixtures above.
   */
  describe("the 'substring' tier (WXYC/Backend-Service#2712, PR 2)", () => {
    let midWordId, djWordId, bothFragmentsId;

    beforeAll(async () => {
      // "olvear" is a true middle fragment of "Convolvearoo" (not a prefix,
      // not the whole word) -- 'word' and 'prefix' both stay empty for it.
      midWordId = await seedRow({
        artist: 'Wxycsubprobemidword Convolvearoo',
        track: 'Unrelated Track Sub One',
        album: 'Unrelated Album Sub One',
        label: 'Unrelated Label Sub One',
      });
      // dj_name supplies the SECOND query word as a whole-word match.
      // search_doc includes dj_name (weight B) but ilikeContainsFragment
      // does not cover it, so this row proves the OR's wordMatch side -- not
      // ILIKE -- is what keeps dj_name reachable in this tier.
      djWordId = await seedRow({
        artist: 'Wxycsubprobedjword Convolvearoo',
        track: 'Unrelated Track Sub Two',
        album: 'Unrelated Album Sub Two',
        label: 'Unrelated Label Sub Two',
        djName: 'Wxycsubprobedjhandle Somebody',
      });
      // Complementary case to the PR 1 "art ens" fixture above: BOTH query
      // terms are true fragments of their row's first word (neither a
      // prefix -- each row's first word starts with an "x" the query term
      // omits), so 'word' and 'prefix' are both empty and only 'substring'
      // recovers it.
      bothFragmentsId = await seedRow({
        artist: 'Xwxycsubprobefirstfragment Unrelated',
        track: 'Xwxycsubprobesecondfragment Live',
        album: 'Unrelated Album Sub Three',
        label: 'Unrelated Label Sub Three',
      });
    });

    test('a mid-word fragment recovers the seeded row ("olvear" matches "Convolvearoo")', async () => {
      const res = await search(`${dateRange} wxycsubprobemidword olvear`).expect(200);
      expect(idsOf(res)).toContain(midWordId);
    });

    test('a fragment plus a whole dj_name word still matches -- dj_name coverage survives the OR', async () => {
      const res = await search(`${dateRange} olvear wxycsubprobedjhandle`).expect(200);
      expect(idsOf(res)).toContain(djWordId);
    });

    test('a first-word fragment in a TWO-WORD query matches by substring once both earlier tiers are empty (neither term is a prefix)', async () => {
      const res = await search(`${dateRange} wxycsubprobefirstfragment wxycsubprobesecondfragment`).expect(200);
      expect(idsOf(res)).toContain(bothFragmentsId);
    });

    // Mutation proof (manual; run during implementation, confirmed both
    // directions): dropping `wordMatch` from the substring OR (replacing it
    // with a bare `FALSE`, keeping only the four-column ILIKE) fails ONLY
    // the dj_name test above (27 passed, 1 failed, this file) -- proving
    // that test depends on `wordMatch`, since dj_name has no ILIKE coverage.
    // Dropping `ilikeContainsFragment(value)` instead (replacing it with
    // `FALSE`, keeping only `wordMatch`) fails the mid-word, dj-word's own
    // fragment term, both-fragments, and the two "tiered matching" recovery
    // tests above (plus the sibling 'substring' cursor-walk spec's first
    // page) -- six failures total across both spec files, none of them a
    // 'word'/'prefix'-reachable test -- proving those five depend on the
    // ILIKE side specifically.
  });
});
