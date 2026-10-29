const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

/**
 * BS#3733: classic catalog search finds a release by any word of its
 * alternate artist name, as soon as the name is saved.
 *
 * The station librarian filed a CD under Kath Bloom with the alternate artist
 * name `Kath Bloom & David Shapiro`, and searching `shapiro` did not return it.
 * `/wxycdb` indexed every word of the alternate name when the release was
 * saved, so that search used to work. Before this change `library.search_doc`
 * held only `artist_name` (A) and `album_title` (B), so stage 1 of Both-mode
 * search could not see the alternate name. The only other route was the
 * `artist_search_alias` path, which scores the whole credit (`shapiro`
 * against `Kath Bloom & David Shapiro` is 0.32, under its 0.40 floor) and is
 * filled by a daily job.
 *
 * Each row files the release with `filedAs`, sets the alternate name with
 * `PATCH /library/:id`, and searches at once with no job run, so every row
 * also checks that a saved name is searchable straight away. A direct release
 * whose `artist_name` holds the query word (Sally Shapiro, Coldcut) is seeded
 * for each query. It makes stage 1 non-empty, so a miss means "not in
 * stage 1" rather than a fall-through to the trigram tier, and it is the
 * artist-name hit that must rank above an alternate-name-only hit.
 *
 * The phrase-seam case (a phrase across the title's last word and the
 * alternate name's first word does not match) is a property of the stored
 * vector, so it lives at the SQL level in
 * `library-search-doc-position-gap.spec.js`. Over HTTP a stage-1 miss falls
 * through to the trigram tier, which matches the same release on its title.
 *
 * IDs 9733-9736 (artists and library) avoid `tests/fixtures/shape.sql`
 * (7000s), `dev_env/seed_db.sql` (1-9) and the alias spec (9001-9612).
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE = 11; // Rock, seeded by dev_env/seed_db.sql
const FORMAT = 1; // CD, seeded by dev_env/seed_db.sql

// Each artist files one release, and the two share an id.
const KATH = 9733; // Kath Bloom, carries the alternate name under test
const SALLY = 9734; // Sally Shapiro, the artist-name `shapiro` hit
const KRUSH = 9735; // DJ Krush, carries the alternate name under test
const COLDCUT = 9736; // Coldcut, the artist-name `coldcut` hit
const IDS = [KATH, SALLY, KRUSH, COLDCUT];

const KATH_CREDIT = 'Kath Bloom & David Shapiro';
const KRUSH_CREDIT = 'DJ Krush & Coldcut';

describe('GET /library/ Both-mode: alternate artist name in search_doc (BS#3733)', () => {
  let auth;
  let sql;

  async function cleanup() {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE album_id = ANY($1::int[])`, [IDS]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.library WHERE id = ANY($1::int[])`, [IDS]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.genre_artist_crossreference WHERE artist_id = ANY($1::int[])`, [IDS]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.artists WHERE id = ANY($1::int[])`, [IDS]);
  }

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanup();

    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.artists (id, artist_name, alphabetical_name, code_letters)
       VALUES ($1, 'Kath Bloom', 'Bloom, Kath', 'BL'),
              ($2, 'Sally Shapiro', 'Shapiro, Sally', 'SH'),
              ($3, 'DJ Krush', 'DJ Krush', 'DJ'),
              ($4, 'Coldcut', 'Coldcut', 'CO')`,
      [KATH, SALLY, KRUSH, COLDCUT]
    );
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
       VALUES ($1, $5, $1), ($2, $5, $2), ($3, $5, $3), ($4, $5, $4)`,
      [KATH, SALLY, KRUSH, COLDCUT, GENRE]
    );
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.library (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $1, $5, $6, 'Come Here', 239, 'Kath Bloom'),
              ($2, $2, $5, $6, 'Disko Kaine', 1, 'Sally Shapiro'),
              ($3, $3, $5, $6, 'Cold Krush Cuts', 3, 'DJ Krush'),
              ($4, $4, $5, $6, 'Let Us Play', 6, 'Coldcut')`,
      [KATH, SALLY, KRUSH, COLDCUT, GENRE, FORMAT]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  test.each([
    {
      label: 'a surname inside an & credit, set by PATCH, is found by the next search',
      id: KATH,
      filedAs: null,
      patchTo: KATH_CREDIT,
      query: 'shapiro',
      found: true,
      after: SALLY,
    },
    {
      label: 'a one-word name inside an & credit is found',
      id: KRUSH,
      filedAs: null,
      patchTo: KRUSH_CREDIT,
      query: 'coldcut',
      found: true,
      after: COLDCUT,
    },
    {
      label: 'the full credit still finds the release',
      id: KATH,
      filedAs: null,
      patchTo: KATH_CREDIT,
      query: 'kath bloom & david shapiro',
      found: true,
      after: null,
    },
    {
      label: 'a cleared alternate name no longer finds the release by that word',
      id: KATH,
      filedAs: KATH_CREDIT,
      patchTo: null,
      query: 'shapiro',
      found: false,
      after: null,
    },
  ])('$label', async ({ id, filedAs, patchTo, query, found, after }) => {
    await sql.unsafe(`UPDATE ${SCHEMA}.library SET alternate_artist_name = $2 WHERE id = $1`, [id, filedAs]);

    const patched = await auth.patch(`/library/${id}`).send({ alternate_artist_name: patchTo }).expect(200);
    expect(patched.body.alternate_artist_name ?? null).toBe(patchTo);

    const res = await auth.get('/library/').query({ artist_name: query, album_title: query, n: 50 }).expect(200);
    const ids = res.body.map((r) => r.id);

    if (!found) {
      expect(ids).not.toContain(id);
      return;
    }
    expect(ids).toContain(id);
    const hit = res.body.find((r) => r.id === id);
    // A stage-1 row: not an alias row, and not a track-search cascade row.
    expect(hit.matched_via_alias).toBeUndefined();
    expect(hit.matched_via).toBeUndefined();
    if (after !== null) {
      // Weight C: the artist-name hit on the same word ranks first.
      expect(ids).toContain(after);
      expect(ids.indexOf(after)).toBeLessThan(ids.indexOf(id));
    }
  });
});
