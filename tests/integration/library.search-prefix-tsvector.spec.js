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

    test.each(withLexeme.map((e, i) => [e.category, e.expected_storage, ids[i]]))(
      '%s entry %j round-trips through the tsvector path',
      async (_category, value, id) => {
        const res = await bothMode(value).expect(200);
        expectArray(res);
        expect(res.body.some((row) => row.id === id)).toBe(true);
      }
    );

    // No letter or digit anywhere (the emoji category) -- `hasAlphanumeric`
    // short-circuits before the tsvector path is even reached, same as
    // `!!!`. Nothing to seed; only asserting the request doesn't 500.
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
      // `to_tsquery` is the one *_to_tsquery variant with no input
      // forgiveness: these reach it as operators, and an unbalanced one
      // raises rather than returning no rows. A 500 here means the
      // sanitizer let something through.
      const res = await bothMode(q).expect(200);

      expectArray(res);
      expect(res.body.length).toBe(0);
    });

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
