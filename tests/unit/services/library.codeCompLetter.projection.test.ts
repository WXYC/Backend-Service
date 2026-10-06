/**
 * BS#2835 (epic BS#2828): every read that projects `genre_artist_crossreference.artist_genre_code` for a response
 * that identifies a shelf slot also projects `genre_artist_crossreference.code_comp_letter` beside it.
 *
 * The shared DB double ignores its arguments, so what these pin is the projection object each read hands to
 * `db.select(...)`: the letter must be selected from the SAME crossreference row as the artist number, never from
 * another table. The values themselves (a lettered slot answers `'M'`, a named artist `null`) are the integration
 * suite's to settle; the mapper-level cases live beside the mappers (`library-search.code-comp-letter.test.ts`,
 * `library-filing.service.test.ts`, `catalog-export.serialize.test.ts`).
 */
import { jest } from '@jest/globals';

import { db, genre_artist_crossreference } from '../../mocks/database.mock';
import {
  browseArtistsInCodeBucket,
  getAlbumFromDB,
  getArtistByCode,
  getArtistCardById,
  getArtistCardByIdInGenre,
  getArtistCrossReferences,
  getArtistsByCode,
  getReleaseCrossReferences,
  getReleasesForArtist,
  searchArtistsInGenre,
} from '../../../apps/backend/services/library.service';
import { getBinFromDB } from '../../../apps/backend/services/djs.service';

const LETTER = genre_artist_crossreference.code_comp_letter;

/** The projection object passed to the first `db.select(...)` a call makes. */
const firstProjection = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => {
  db.select.mockClear();
  await run();
  return db.select.mock.calls[0]?.[0] as Record<string, unknown>;
};

describe('code_comp_letter rides beside the slot artist number (BS#2835)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['getBinFromDB', () => getBinFromDB('dj-1')],
    ['getAlbumFromDB', () => getAlbumFromDB(7)],
    ['getArtistCardById', () => getArtistCardById(7)],
    ['getArtistCardByIdInGenre', () => getArtistCardByIdInGenre(7, 11)],
    ['getReleasesForArtist', () => getReleasesForArtist(7, 0, 10)],
    ['getReleaseCrossReferences', () => getReleaseCrossReferences(0, 10)],
    ['searchArtistsInGenre', () => searchArtistsInGenre(11, 'va', 5)],
    ['getArtistByCode (the by-code owner read)', () => getArtistByCode('V/A', 11, 0)],
    ['getArtistsByCode (the by-code owner list)', () => getArtistsByCode('V/A', 11, 0)],
    ['browseArtistsInCodeBucket (the by-code bucket browse)', () => browseArtistsInCodeBucket('V/A', 11)],
  ])('%s selects the letter from genre_artist_crossreference', async (_name, run) => {
    const projection = await firstProjection(run);

    expect(projection).toHaveProperty('code_comp_letter', LETTER);
  });

  it('getArtistCrossReferences projects the target filing’s letter from the same lowest-genre subquery', async () => {
    const projection = await firstProjection(() => getArtistCrossReferences(0, 10));

    expect(projection).toHaveProperty('target_code_comp_letter');
  });
});
