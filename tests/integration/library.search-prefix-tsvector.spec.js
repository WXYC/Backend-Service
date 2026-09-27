const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectArray } = require('../utils/test_helpers');

/**
 * Prefix-tsvector catalog search (BS#670).
 *
 * dj-site issues a `/library` query on every keystroke, so the common query is
 * a *partial* token. `websearch_to_tsquery('simple','autec')` lexes to `autec`
 * and the catalog holds `autechre` — two lexemes, no overlap, zero rows — so
 * every keystroke before the last fell through to the trigram path at
 * 11-232 ms instead of being answered from `library_search_doc_idx` at 3-5 ms.
 *
 * `apps/backend/utils/tsquery.ts` builds a `:*`-suffixed tsquery instead. The
 * unit suite at tests/unit/utils/tsquery.test.ts pins the string it emits;
 * these tests assert the schema, seed fixture and `simple` text-search config
 * compose so that the published endpoint actually returns the row — a prefix
 * tsquery that is syntactically correct but lexes differently than the STORED
 * generated column would pass the unit tests and match nothing here.
 *
 * Both-mode (the path the ranker exists for) is triggered by sending the same
 * string as `artist_name` and `album_title`, which is the dj-site default.
 */

describe('GET /library — prefix tsvector (BS#670)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  const bothMode = (q) => auth.get('/library').query({ artist_name: q, album_title: q });

  test.each([
    ['autec', 'autechre'],
    ['autech', 'autechre'],
    ['stereola', 'stereolab'],
    ['stereo', 'stereolab'],
  ])('a partial artist token (%s) resolves to %s', async (q, expected) => {
    const res = await bothMode(q).expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.some((row) => row.artist_name.toLowerCase().includes(expected))).toBe(true);
  });

  test('a complete token still matches, so the prefix form is a superset', async () => {
    // Regression guard on the swap itself: `:*` must not break exact matching,
    // which is all `websearch_to_tsquery` ever gave us here.
    const res = await bothMode('autechre').expect(200);

    expectArray(res);
    expect(res.body.some((row) => row.artist_name.toLowerCase().includes('autechre'))).toBe(true);
  });

  test('multi-token prefixes AND-restrict rather than widening', async () => {
    // Every token is prefixed and the tokens are AND-combined, so a partial
    // second token must still narrow: the other Stereolab album (Mars Audiac
    // Quintet) has no `transient`-prefixed lexeme and must drop out.
    const res = await bothMode('stereola transien').expect(200);

    expectArray(res);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].artist_name.toLowerCase()).toContain('stereolab');
    expect(res.body[0].album_title.toLowerCase()).toContain('transient');
    for (const row of res.body) {
      expect(row.album_title.toLowerCase()).not.toContain('mars audiac');
    }
  });

  test('the trigram fallback still serves a misspelled prefix', async () => {
    // `sterolab` misspells the prefix itself, so no prefix of it is a prefix of
    // a real lexeme and the tsvector tier cannot help. This is the case the
    // fallback now exists for, and BS#670 must not have closed it off.
    const res = await bothMode('sterolab').expect(200);

    expectArray(res);
    expect(res.body.some((row) => row.artist_name.toLowerCase().includes('stereolab'))).toBe(true);
  });

  test.each([
    ['!!!', 'pure punctuation'],
    ['&|!', 'tsquery operators only'],
    ['$$$ ...', 'no token carries a lexeme'],
  ])('%s (%s) returns empty without raising', async (q) => {
    // `to_tsquery` is the one *_to_tsquery variant with no input forgiveness:
    // these reach it as operators, and an unbalanced one raises rather than
    // returning no rows. A 500 here means the sanitizer let something through.
    const res = await bothMode(q).expect(200);

    expectArray(res);
    expect(res.body.length).toBe(0);
  });

  test('an apostrophe in the query does not raise', async () => {
    // Doubled inside the quoted lexeme. An unescaped one would terminate the
    // literal and leave a dangling `:*` for the parser.
    const res = await bothMode("d'ang").expect(200);

    expectArray(res);
  });
});
