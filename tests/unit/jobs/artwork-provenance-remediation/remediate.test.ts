/**
 * Unit tests for artwork-provenance-remediation `remediate.ts` (BS#2258).
 *
 * The drain's whole risk is writing the wrong thing over a row that already
 * renders *something*. These pin the four rules that bound that risk:
 *
 *   1. **Narrow write.** `artwork_url` + `updated_at`, nothing else. The
 *      defect is one column; the other nine were written by the canonical
 *      writer under conditions this drain has not re-measured.
 *   2. **Exact-value race guard.** The UPDATE's WHERE pins the artwork_url
 *      the selector classified. If anything moved it since the SELECT — a
 *      concurrent enrichment healing it to a real cover — the write matches
 *      zero rows instead of clobbering fresher data.
 *   3. **Only strictly-better answers land.** A replacement that is itself
 *      an artist image or label logo is `still_wrong` and is NOT written:
 *      swapping a label logo for an artist photo buys nothing and spends
 *      the row's `updated_at`.
 *   4. **Never null out.** A lookup that comes back without artwork is
 *      `no_match` with no write — a wrong image is bad, a blank tile is a
 *      visible regression (BS#2258's "leave as-is" constraint).
 */
import { jest } from '@jest/globals';

import { album_metadata, db } from '@wxyc/database';
import { remediateAlbum, type WrongArtworkRow } from '../../../../jobs/artwork-provenance-remediation/remediate';
import type { LookupResponse } from '@wxyc/lml-client';

const LABEL_LOGO =
  'https://i.discogs.com/JuO51-lZvasOtw8-yLUjsen-4O17uPH1A9SILCO-lG4/rs:fit/g:sm/q:90/h:300/w:299/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9MLTE4NjYt/MTIzMzE5MzU1Ny5q/cGVn.jpeg';
const ARTIST_IMAGE =
  'https://i.discogs.com/Lj7_VfsOG9ZjqxZAxm0VEjQSQHvbG-wy-Zj9KRaEIgo/rs:fit/g:sm/q:90/h:606/w:600/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9BLTMyNjgt/MTY2Mzg3MTI0OS0z/MzY1LmpwZWc.jpeg';
const RELEASE_COVER =
  'https://i.discogs.com/FnUJPxhECqKDvFoT-z2-GT9g5uRYLE8rjIetCX4lsMs/rs:fit/g:sm/q:90/h:600/w:593/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTEzNzEy/OS0xMjIyODc4OTE5/LmpwZWc.jpeg';
const APPLE_ARTWORK =
  'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b6/05/21/b605217c-42ee-8c1e-238b-0fc18570b10d/196873025063.jpg/600x600bb.jpg';

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

/** Autechre — *Chiastic Slide*, the row BS#2258 names by hand. */
const row: WrongArtworkRow = {
  album_id: 4242,
  artist_name: 'Autechre',
  album_title: 'Chiastic Slide',
  artwork_url: LABEL_LOGO,
};

const responseWith = (artworkUrl: string | null): LookupResponse => ({
  results: [{ artwork: artworkUrl === null ? null : { artwork_url: artworkUrl } }],
});

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

/**
 * The interpolated params of a `sql` template, in order. Two shapes occur:
 * the unit suite's `drizzle-orm` stub exposes a flat `values` array, real
 * drizzle carries `Param` objects in `queryChunks` (same reason `renderSql`
 * handles both `sql` and `queryChunks` here and in the sibling job's suite).
 */
const boundValues = (value: unknown): unknown[] => {
  const obj = value as { values?: unknown[]; queryChunks?: Array<{ value?: unknown }> } | null | undefined;
  if (Array.isArray(obj?.values)) return obj.values;
  return (obj?.queryChunks ?? [])
    .filter((chunk) => typeof chunk === 'object' && chunk !== null && 'value' in chunk && !Array.isArray(chunk.value))
    .map((chunk) => chunk.value);
};

beforeEach(() => {
  mockDb._chain.returning.mockResolvedValue([{ album_id: row.album_id }]);
});

describe('remediateAlbum — writes', () => {
  it('heals a label logo to the release cover LML now resolves', async () => {
    const outcome = await remediateAlbum(row, responseWith(RELEASE_COVER));

    expect(outcome).toBe('healed');
    expect(mockDb.update).toHaveBeenCalledWith(album_metadata);
    expect(mockDb._chain.set).toHaveBeenCalledTimes(1);
    const [setArgs] = mockDb._chain.set.mock.calls[0] as [Record<string, unknown>];
    expect(setArgs.artwork_url).toBe(RELEASE_COVER);
  });

  it('writes only artwork_url and updated_at, never the other metadata columns', async () => {
    await remediateAlbum(row, responseWith(RELEASE_COVER));

    const [setArgs] = mockDb._chain.set.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(setArgs).sort()).toEqual(['artwork_url', 'updated_at']);
  });

  it('pins the selected artwork_url in the WHERE so a concurrent heal cannot be clobbered', async () => {
    await remediateAlbum(row, responseWith(RELEASE_COVER));

    const [whereArg] = mockDb._chain.where.mock.calls[0] as [unknown];
    expect(renderSql(whereArg)).toBe('"album_id" = ' + ' AND "artwork_url" = ' + '');
    // The pinned value, not just the column: a guard on `album_id` alone
    // would happily overwrite a row a live enrichment had already healed.
    expect(boundValues(whereArg)).toEqual([row.album_id, LABEL_LOGO]);
  });

  it('reports `raced` when the guarded UPDATE matches no rows', async () => {
    mockDb._chain.returning.mockResolvedValue([]);

    expect(await remediateAlbum(row, responseWith(RELEASE_COVER))).toBe('raced');
  });

  it('accepts a non-Discogs cover as a heal — an Apple cover is a real cover', async () => {
    expect(await remediateAlbum(row, responseWith(APPLE_ARTWORK))).toBe('healed');
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('remediateAlbum — refusals', () => {
  it.each([
    ['another label logo', LABEL_LOGO],
    ['an artist image', ARTIST_IMAGE],
  ])('refuses to write %s over the existing wrong artwork', async (_label, url) => {
    expect(await remediateAlbum(row, responseWith(url))).toBe('still_wrong');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it.each([
    ['artwork is null', responseWith(null)],
    ['artwork_url is null', { results: [{ artwork: { artwork_url: null } }] } as unknown as LookupResponse],
    ['there are no results', { results: [] } as unknown as LookupResponse],
    ['results is absent', {} as unknown as LookupResponse],
  ])('leaves the row alone and reports `no_match` when %s', async (_label, response) => {
    expect(await remediateAlbum(row, response)).toBe('no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('treats a Discogs spacer.gif as no_match rather than writing a broken image', async () => {
    const outcome = await remediateAlbum(row, responseWith('https://i.discogs.com/img/spacer.gif'));

    expect(outcome).toBe('no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('reports `still_wrong` without writing when LML returns the exact same wrong URL', async () => {
    expect(await remediateAlbum(row, responseWith(row.artwork_url))).toBe('still_wrong');
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
