const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectArray } = require('../utils/test_helpers');
const charsetTorture = require('../fixtures/charset-torture.json');

/**
 * Prefix-tsvector catalog search (BS#670).
 *
 * dj-site issues a `/library` query on every keystroke, so the common query
 * is a *partial* token. `websearch_to_tsquery('simple','autec')` lexes to
 * `autec` and the catalog holds `autechre` -- two lexemes, no overlap, zero
 * rows -- so every keystroke before the last fell through to the trigram
 * path at 11-232 ms instead of being answered from `library_search_doc_idx`
 * at 3-5 ms.
 *
 * `apps/backend/utils/tsquery.ts` builds a last-token-prefix tsquery pair
 * instead -- `tsquery` (`:*` on the last token) drives WHERE, `exactTsquery`
 * (no `:*` anywhere) drives `match_tier`. The unit suite at
 * tests/unit/utils/tsquery.test.ts pins the SQL the builder renders; these
 * tests assert the schema, seed fixture and `simple` text-search config
 * compose so the published endpoint actually returns the row and ranks it
 * correctly -- a syntactically valid tsquery that lexes differently than the
 * STORED generated column would pass the unit tests and match nothing here,
 * and a correct WHERE predicate with a dormant match_tier seam would still
 * return the right ROWS in the wrong ORDER.
 *
 * Both-mode (the path the ranker exists for) is triggered by sending the
 * same string as `artist_name` and `album_title`, which is the dj-site
 * default.
 *
 * Every assertion here is re-derived against this branch's behavior -- the
 * previous version of this file was written against the pre-gap,
 * pre-tiering, prefix-every-token builder from the superseded
 * WXYC/Backend-Service#2709 and asserted a different contract than the one
 * ADR 0015 and this issue settle on.
 *
 * Seed/probe ids live in the 7900-7999 block, clear of the shape fixture
 * (7000-7099), the ranking spec's probes (7080-7086), and every other
 * integration spec's explicit-id ranges (7100-7199, 7140-7143, 7150-7151).
 */
describe('GET /library — prefix tsvector (BS#670)', () => {
  const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
  const ART = 7000; // shape fixture artist ('XA'), reused by several specs
  const GEN = 11; // 'Rock'
  const FMT = 1; // 'cd'

  let auth;
  let sql;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
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
    if (sql) await sql.end();
  });

  const bothMode = (q) => auth.get('/library').query({ artist_name: q, album_title: q });

  /** Insert one probe album, optionally with `plays` flowsheet rows, and refresh the MV. */
  async function seedProbe({ id, codeNumber, artistName, albumTitle, plays = 0 }) {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET artist_name = EXCLUDED.artist_name, album_title = EXCLUDED.album_title`,
      [id, ART, GEN, FMT, albumTitle, codeNumber, artistName]
    );
    for (let i = 0; i < plays; i++) {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, 'track', $2, $3, $4, $5)`,
        [id, 980000 + id * 10 + i, artistName, albumTitle, `probe track ${i}`]
      );
    }
    if (plays > 0) await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  }

  async function teardownProbes(ids) {
    for (const id of ids) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [id]);
    }
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1)`, [ids]);
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  }

  describe('every prefix of a seeded artist name matches that row', () => {
    // Chuquimamani-Condori exercises the hyphenated-compound case migration
    // 0178 bought a position gap to protect: `to_tsvector` lexes it to the
    // compound plus its two parts, so a prefix anywhere in the name --
    // including one that lands exactly at or just past the hyphen -- must
    // still resolve to a phrase-adjacency query that matches the stored row.
    const HYPHEN_ID = 7910;
    const HYPHEN_NAME = 'Chuquimamani-Condori';

    // Csillagrablók exercises a non-ASCII letter class (the `simple` config
    // keeps diacritics in the lexeme) with no internal punctuation. The sweep
    // starts at two characters, like the hyphen sweep above. The tsvector path
    // has no minimum token length (docs/catalog-search/README.md "Why the
    // prefix path has no minimum token length"), but a one-character prefix
    // such as `'c':*` matches a large share of the catalog, so whether this
    // one row lands inside the top `n` depends on the rest of the seed data,
    // not on the builder. The one-character shape is pinned in the unit tier.
    const DIACRITIC_ID = 7911;
    const DIACRITIC_NAME = 'Csillagrablók';

    beforeAll(async () => {
      await seedProbe({ id: HYPHEN_ID, codeNumber: 910, artistName: HYPHEN_NAME, albumTitle: 'Prefix Sweep Probe' });
      await seedProbe({
        id: DIACRITIC_ID,
        codeNumber: 911,
        artistName: DIACRITIC_NAME,
        albumTitle: 'Prefix Sweep Probe',
      });
    });

    afterAll(async () => {
      await teardownProbes([HYPHEN_ID, DIACRITIC_ID]);
    });

    test.each(Array.from({ length: HYPHEN_NAME.length - 1 }, (_, i) => HYPHEN_NAME.slice(0, i + 2)))(
      'prefix %s of "Chuquimamani-Condori" matches the seeded row',
      async (prefix) => {
        const res = await bothMode(prefix).expect(200);
        expectArray(res);
        expect(res.body.some((row) => row.id === HYPHEN_ID)).toBe(true);
      }
    );

    test.each(Array.from({ length: DIACRITIC_NAME.length - 1 }, (_, i) => DIACRITIC_NAME.slice(0, i + 2)))(
      'prefix %s of "Csillagrablók" matches the seeded row',
      async (prefix) => {
        const res = await bothMode(prefix).expect(200);
        expectArray(res);
        expect(res.body.some((row) => row.id === DIACRITIC_ID)).toBe(true);
      }
    );
  });

  describe('charset-torture corpus (tests/fixtures/charset-torture.json)', () => {
    const HAS_LEXEME_CHARACTER = /[\p{L}\p{N}]/u;
    const entries = Object.entries(charsetTorture.categories).flatMap(([category, list]) =>
      list.map((entry) => ({ category, ...entry }))
    );

    // Postgres TEXT cannot store a NUL byte at all (raises 22021) -- the
    // fixture documents this itself ("Match/ascii forms undefined -- WX-2
    // may reject or strip"). Excluded from seeding; nothing about BS#670
    // changes that ceiling.
    const seedable = entries.filter((e) => !e.expected_storage.includes('\u0000'));

    // Seeded with `expected_storage` -- the canonical form the storage layer
    // (a separate concern from this builder) is responsible for producing --
    // and queried with the same string. Mojibake repair and NFD-to-NFC
    // re-normalization happen before a value ever reaches `library
    // .artist_name`; this suite is only responsible for the tsquery builder
    // matching what is actually stored, not for repairing what a DJ pastes.
    const withLexeme = seedable.filter((e) => HAS_LEXEME_CHARACTER.test(e.expected_storage));
    const withoutLexeme = seedable.filter((e) => !HAS_LEXEME_CHARACTER.test(e.expected_storage));

    const BASE_ID = 7920;
    const ids = withLexeme.map((_, i) => BASE_ID + i);

    beforeAll(async () => {
      for (let i = 0; i < withLexeme.length; i++) {
        await seedProbe({
          id: ids[i],
          codeNumber: 920 + i,
          artistName: withLexeme[i].expected_storage,
          albumTitle: 'Charset Torture Probe',
        });
      }
    });

    afterAll(async () => {
      await teardownProbes(ids);
    });

    // What this guarantees is narrower than "the tsvector tier matches it":
    // the query is byte-identical to the stored name, so for any entry of two
    // or more characters the Both-mode trigram fallback finds the row at
    // similarity 1.0 even if the tsvector tier missed. Only the one-character
    // entries (the trigram gate is `length >= 2`) exercise the tsvector tier
    // alone. For the rest this pins that no corpus input 500s and every seeded
    // row stays reachable through the cascade.
    test.each(withLexeme.map((e, i) => [e.category, e.expected_storage, ids[i]]))(
      '%s entry %j is reachable through the Both-mode cascade without raising',
      async (_category, value, id) => {
        const res = await bothMode(value).expect(200);
        expectArray(res);
        expect(res.body.some((row) => row.id === id)).toBe(true);
      }
    );

    // Classified on `expected_storage` but queried with `input`, and those can
    // differ: the mojibake entry `â€™` is stored as `’` (no lexeme), but its
    // input carries `â`, a letter, so `hasAlphanumeric` passes and that request
    // runs the full cascade (tsvector, trigram, then the track-search cascade)
    // rather than short-circuiting. It returns empty only because nothing
    // seeded matches it. The emoji entries do short-circuit, like `!!!`.
    test.each(withoutLexeme.map((e) => [e.category, e.input]))(
      '%s entry %j returns empty without raising',
      async (_category, value) => {
        const res = await bothMode(value).expect(200);
        expectArray(res);
        expect(res.body.length).toBe(0);
      }
    );
  });

  describe('tier activation (match_tier seam) — the red case', () => {
    // BS#2725 landed match_tier with `const exactTsquery = tsquery;` --
    // deliberately dormant until this builder feeds it a genuinely
    // un-prefixed token list. If that alias regresses, EXACT and PREFIXONLY
    // both read as tier 2 (their WHERE-predicate tsquery is identical, so
    // match_tier's CASE -- checking the SAME predicate against itself --
    // is trivially true for both), ts_rank does not meaningfully separate
    // an exact lexeme from a longer word it merely prefixes, and the
    // ranking falls through to plays: PREFIXONLY's 40 plays would outrank
    // EXACT's 0, exactly the #2709 popularity-collapse regression.
    const EXACT_ID = 7990; // artist_name is the whole query token -> tier 2
    const PREFIXONLY_ID = 7991; // artist_name only starts with the query token -> tier 1

    beforeAll(async () => {
      await seedProbe({
        id: EXACT_ID,
        codeNumber: 990,
        artistName: 'Zzprefixprobetier',
        albumTitle: 'Probe Album Exact',
        plays: 0,
      });
      await seedProbe({
        id: PREFIXONLY_ID,
        codeNumber: 991,
        artistName: 'Zzprefixprobetierine',
        albumTitle: 'Probe Album Prefix',
        plays: 40,
      });
    });

    afterAll(async () => {
      await teardownProbes([EXACT_ID, PREFIXONLY_ID]);
    });

    test('an exact-lexeme match outranks a prefix-only match regardless of plays', async () => {
      const res = await bothMode('zzprefixprobetier').expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      expect(ids.indexOf(EXACT_ID)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(PREFIXONLY_ID)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(EXACT_ID)).toBeLessThan(ids.indexOf(PREFIXONLY_ID));
    });
  });

  describe('within-tier ordering (exact_score)', () => {
    // Both rows are tier 2: each contains `zzqx` as a whole lexeme. They
    // differ in how the rest of the row scores. WHOLE matches it in the
    // weight-A artist field; SPLIT matches it only in the weight-B album
    // field and prefix-matches it in the artist field (`zzqxs`). Scored on the
    // prefixed tsquery, SPLIT collects credit from both fields and wins
    // (0.85 vs 0.61 on PG 18.6) -- the shape that put Gene Loves Jezebel
    // above Love for `love`. Scored on the exact tsquery, WHOLE wins
    // (0.61 vs 0.24). Plays are equal, so only `exact_score` decides this.
    const WHOLE_ID = 7980;
    const SPLIT_ID = 7981;

    beforeAll(async () => {
      await seedProbe({ id: WHOLE_ID, codeNumber: 980, artistName: 'Zzqx', albumTitle: 'Probe One' });
      await seedProbe({ id: SPLIT_ID, codeNumber: 981, artistName: 'Zzqxs', albumTitle: 'Zzqx Tapes' });
    });

    afterAll(async () => {
      await teardownProbes([WHOLE_ID, SPLIT_ID]);
    });

    test('a whole-word hit in the artist field outranks a prefix hit that adds a second field', async () => {
      const res = await bothMode('zzqx').expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      expect(ids.indexOf(WHOLE_ID)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(SPLIT_ID)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(WHOLE_ID)).toBeLessThan(ids.indexOf(SPLIT_ID));
    });
  });

  describe('leading "-" is a literal, not exclusion (ADR 0015)', () => {
    // Asserted on match behaviour, never on the emitted string: a test that
    // checked the `-` was removed would certify the regression below.
    const DASH_ID = 7982;
    const NODASH_ID = 7983;

    beforeAll(async () => {
      await seedProbe({ id: DASH_ID, codeNumber: 982, artistName: 'Zzminus Probe', albumTitle: 'Minus 5 -3d World' });
      await seedProbe({ id: NODASH_ID, codeNumber: 983, artistName: 'Zzminus Probe', albumTitle: 'Minus 5 3d World' });
    });

    afterAll(async () => {
      await teardownProbes([DASH_ID, NODASH_ID]);
    });

    test('a leading "-" does not exclude the term', async () => {
      // `-transient` is not an exclusion: quoting makes to_tsquery discard the
      // `-`, so this narrows to the Transient album like `stereolab transient`.
      const res = await bothMode('stereolab -transient').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].album_title.toLowerCase()).toContain('transient');
    });

    test('a "-" before a digit is kept as the sign of the lexeme', async () => {
      // `'-3d':*` re-lexes to `'-3':* <-> 'd':*`, which matches the dashed row
      // only. Stripping the `-` would emit `'3d':*`, which matches the
      // dashless row only -- and because that is still a tsvector hit, the
      // trigram fallback never runs to mask it.
      const res = await bothMode('zzminus -3d').expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      expect(ids).toContain(DASH_ID);
      expect(ids).not.toContain(NODASH_ID);
    });
  });

  describe('operator retirement (ADR 0015)', () => {
    const CAT_ID = 7995;
    const POWER_ID = 7996;
    const BOTH_ID = 7997;

    beforeAll(async () => {
      await seedProbe({ id: CAT_ID, codeNumber: 995, artistName: 'Zzorprobe Cat', albumTitle: 'Probe Album A' });
      await seedProbe({ id: POWER_ID, codeNumber: 996, artistName: 'Zzorprobe Power', albumTitle: 'Probe Album B' });
      await seedProbe({
        id: BOTH_ID,
        codeNumber: 997,
        // Holds the literal word `or`, so `zzorprobe cat or power` has a
        // tsvector hit and the Both-mode trigram fallback never runs. Without
        // it the tsvector tier correctly returns zero rows, and the typo
        // fallback -- which interprets no operators and is outside ADR 0015's
        // contract -- returns the fuzzy look-alikes, cat-only and power-only
        // rows included, making the union assertion below test the wrong tier.
        artistName: 'Zzorprobe Cat Or Power',
        albumTitle: 'Probe Album C',
      });
    });

    afterAll(async () => {
      await teardownProbes([CAT_ID, POWER_ID, BOTH_ID]);
    });

    test('a bare "or" is not disjunction -- it narrows like any other AND-combined token, never widens to the union', async () => {
      // Do NOT assert equality with the bare AND query: `or` is a fourth
      // required literal token, so `cat or power` matches only rows that
      // contain the word -- a strict subset of what `cat power` matches. What
      // this pins is the absence of the union of "cat"-only and "power"-only
      // rows -- neither CAT_ID nor POWER_ID may appear.
      const res = await bothMode('zzorprobe cat or power').expect(200);

      expectArray(res);
      const ids = res.body.map((row) => row.id);
      // `or` is a required literal: the one row containing it matches...
      expect(ids).toContain(BOTH_ID);
      // ...and nothing that a disjunction would have added does.
      expect(ids).not.toContain(CAT_ID);
      expect(ids).not.toContain(POWER_ID);
    });

    test('a "quoted" term is not a tsquery phrase -- it returns the same rows as the same words unquoted', async () => {
      const quoted = await bothMode('"zzorprobe cat power"').expect(200);
      const bare = await bothMode('zzorprobe cat power').expect(200);

      expectArray(quoted);
      expectArray(bare);
      expect(quoted.body.map((r) => r.id).sort()).toEqual(bare.body.map((r) => r.id).sort());
      expect(quoted.body.some((row) => row.id === BOTH_ID)).toBe(true);
    });
  });

  describe('AND semantics', () => {
    // Reuses the seed_db.sql Stereolab fixture (two albums, one artist) so
    // this keeps holding against the same data library.search-ranking.spec.js
    // exercises: a second, still-partial token must narrow rather than widen.
    test('a second partial token narrows results rather than returning the whole discography', async () => {
      // Only the LAST token is a prefix; every earlier token is an exact
      // lexeme, so the first word must be complete. `stereola transien` is
      // correctly a tsvector miss (the fallback then serves the discography).
      const res = await bothMode('stereolab transien').expect(200);

      expectArray(res);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].artist_name.toLowerCase()).toContain('stereolab');
      expect(res.body[0].album_title.toLowerCase()).toContain('transient');
      for (const row of res.body) {
        expect(row.album_title.toLowerCase()).not.toContain('mars audiac');
      }
    });
  });

  describe('trigram fallback', () => {
    test('a misspelled prefix still reaches the trigram fallback', async () => {
      // `sterolab` misspells the prefix itself, so no prefix of it is a
      // prefix of a real lexeme and the tsvector tier cannot help -- this is
      // the case the fallback exists for, and BS#670 must not have closed it.
      const res = await bothMode('sterolab').expect(200);

      expectArray(res);
      expect(res.body.some((row) => row.artist_name.toLowerCase().includes('stereolab'))).toBe(true);
    });
  });

  describe('pure punctuation and no-lexeme queries', () => {
    test.each([
      ['!!!', 'pure punctuation'],
      ['&|!', 'tsquery operators only'],
      ['$$$ ...', 'no token carries a lexeme'],
    ])('%s (%s) returns empty without raising', async (q) => {
      // None of these carries a letter or digit, so `hasAlphanumeric` returns
      // empty before the builder or `to_tsquery` runs. These pin that
      // short-circuit; the letter-bearing cases below are what reach
      // `to_tsquery` and exercise the sanitizer.
      const res = await bothMode(q).expect(200);

      expectArray(res);
      expect(res.body.length).toBe(0);
    });

    test.each([['foo\\'], ['cat:'], ['(cat'], ['a<b'], ['x|y'], ["it's"], ['cat*'], ['a&'], ['!cat']])(
      '%s (a metacharacter beside a letter) does not raise',
      async (q) => {
        // Unlike the cases above, these carry a letter, so they pass
        // `hasAlphanumeric` and reach `to_tsquery`. Each metacharacter here is
        // one the sanitizer must neutralize; `'foo\':*` raises 42601 if the
        // backslash gets through. A 500 means the escape set was narrowed.
        const res = await bothMode(q).expect(200);

        expectArray(res);
      }
    );

    test('an apostrophe in the query does not raise', async () => {
      // Doubled inside the quoted lexeme by the builder. Not asserting a
      // match here -- only that the escaping survives the round trip to
      // Postgres without a syntax error (ADR 0015: `-` and `"` handling are
      // pinned separately, above and at the unit tier).
      const res = await bothMode("d'ang").expect(200);

      expectArray(res);
    });
  });
});
