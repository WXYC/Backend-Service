/**
 * Genuinely-rendered-SQL pin for the flowsheet -> library text-link candidate query (BS#3065, part 2 of BS#3057).
 *
 * The same candidate query runs in the edit path (`updateEntry`) and, later, the insert path, and
 * `scripts/direct-link-flowsheet.sql` runs its SQL twin. What this protects:
 *
 *  - both legs compare `wxyc_schema.text_match_key(...)` (migration 0191) on each side, so the album leg rides
 *    `library_text_match_album_idx`;
 *  - both `<> ''` guards are present. A symbols-only name keys to `''`, and without the guard `'' = ''` matches
 *    every library row whose own key is empty;
 *  - `artists` is joined, not the denormalized and nullable `library.artist_name`;
 *  - the candidate list is capped, so an ambiguous catalog cannot return an unbounded set;
 *  - the edit path's current link sorts first, so the cap can never truncate it out of the keep-current check;
 *    otherwise the order is by id, so a capped page is deterministic.
 *
 * The mechanism is the one `flowsheet.getOpenShows.sql.test.ts` established: the real schema plus a real,
 * never-connected drizzle instance, so `.toSQL()` renders without touching a client.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => jest.requireActual('../../utils/real-database-module').realDatabaseModule());

import { buildLibraryReleasesByTextQuery } from '../../../apps/backend/services/flowsheet.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const KEY = `"${SCHEMA}"."text_match_key"`;
const { sql: text, params } = buildLibraryReleasesByTextQuery('Jessica Pratt', 'Afterlife').toSQL();

describe('buildLibraryReleasesByTextQuery — rendered statement (BS#3065)', () => {
  it('selects only the library id', () => {
    expect(text).toMatch(new RegExp(`^select "${SCHEMA}"\\."library"\\."id" from "${SCHEMA}"\\."library"`));
  });

  it('joins artists on artist_id rather than reading library.artist_name', () => {
    expect(text).toContain(
      `inner join "${SCHEMA}"."artists" on "${SCHEMA}"."artists"."id" = "${SCHEMA}"."library"."artist_id"`
    );
    expect(text).not.toContain('"library"."artist_name"');
  });

  it('compares the album leg on text_match_key of library.album_title', () => {
    expect(text).toContain(`${KEY}("${SCHEMA}"."library"."album_title") = ${KEY}($1::text)`);
  });

  it('compares the artist leg on text_match_key of artists.artist_name', () => {
    expect(text).toContain(`${KEY}("${SCHEMA}"."artists"."artist_name") = ${KEY}($2::text)`);
  });

  it('guards both legs against an empty key', () => {
    expect(text).toContain(`${KEY}($3::text) <> ''`);
    expect(text).toContain(`${KEY}($4::text) <> ''`);
  });

  it('caps the candidate list at 10, ordered by id', () => {
    expect(text).toMatch(new RegExp(`order by "${SCHEMA}"\\."library"\\."id" limit \\$5$`));
    expect(params[4]).toBe(10);
  });

  it('sorts the current album_id first, ahead of the cap, when one is given', () => {
    const withCurrent = buildLibraryReleasesByTextQuery('Jessica Pratt', 'Afterlife', { currentAlbumId: 42 }).toSQL();
    expect(withCurrent.sql).toMatch(
      new RegExp(
        `order by \\("${SCHEMA}"\\."library"\\."id" = \\$5\\) desc, "${SCHEMA}"\\."library"\\."id" limit \\$6$`
      )
    );
    expect(withCurrent.params).toEqual(['Afterlife', 'Jessica Pratt', 'Afterlife', 'Jessica Pratt', 42, 10]);
  });

  it('binds album then artist, each twice, as parameters', () => {
    expect(params).toEqual(['Afterlife', 'Jessica Pratt', 'Afterlife', 'Jessica Pratt', 10]);
  });
});
