/**
 * Unit pin for `insertArtistWithGenreCrossreference`'s rollback invariant
 * (BS#2475): the `artists` insert and its `genre_artist_crossreference`
 * filing run inside ONE `db.transaction`, on the transaction handle the
 * callback receives — never on the bare `db`. That containment is what makes
 * a crossreference failure (INT4 overflow, SQLSTATE 22003; or FK 23503 on a
 * nonexistent `genre_id`, which `addArtist` never validates) roll the artist
 * row back instead of committing it orphaned — filed in no genre, invisible
 * to the very pre-checks that would prevent re-creating it.
 *
 * The mock db cannot execute a real ROLLBACK, so these tests pin the
 * properties the rollback derives from: both writes go through the tx handle
 * inside the one callback, nothing is written on the bare `db`, and a
 * second-insert rejection propagates out of `db.transaction` (the abort
 * signal in real Postgres). A refactor that splits the inserts apart or
 * moves one outside the transaction callback fails these assertions.
 */
import { jest } from '@jest/globals';
import { db, createMockDb, artists, genre_artist_crossreference } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
  envInt: (_name: string, fallback: number) => fallback,
}));

import { insertArtistWithGenreCrossreference } from '../../../apps/backend/services/library.service';

// A distinct tx double, so "went through the transaction handle" and "went
// through the bare db" are distinguishable calls — the default mock hands the
// callback `db` itself, which would make the two the same jest.fn and the
// containment assertions below vacuously true.
const tx = createMockDb();

const newArtist = {
  artist_name: 'Jessica Pratt',
  alphabetical_name: 'Pratt, Jessica',
  code_letters: 'PR',
};

describe('insertArtistWithGenreCrossreference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.transaction as jest.Mock).mockImplementation(async (fn) => (fn as (t: unknown) => Promise<unknown>)(tx));
  });

  it('runs both inserts on the transaction handle, artists first, and never writes on the bare db', async () => {
    tx._chain.returning.mockResolvedValueOnce([{ id: 55, ...newArtist }]);

    const artist = await insertArtistWithGenreCrossreference(newArtist, 15, 12);

    expect(artist).toEqual({ id: 55, ...newArtist });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenNthCalledWith(1, artists);
    expect(tx.insert).toHaveBeenNthCalledWith(2, genre_artist_crossreference);
    expect(tx._chain.values).toHaveBeenNthCalledWith(2, { artist_id: 55, genre_id: 15, artist_genre_code: 12 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('propagates a crossreference-insert failure out of the transaction, with no write outside it to survive the rollback', async () => {
    const overflow = Object.assign(new Error('numeric field overflow'), { code: '22003' });
    tx._chain.returning.mockResolvedValueOnce([{ id: 55, ...newArtist }]);
    tx._chain.values
      .mockReturnValueOnce(tx._chain) // artists insert: chain continues to .returning()
      .mockImplementationOnce(() => Promise.reject(overflow)); // crossreference insert is awaited directly: reject it

    await expect(insertArtistWithGenreCrossreference(newArtist, 15, 2147483648)).rejects.toBe(overflow);

    // The artists insert happened only inside the transaction the rejection
    // aborts; with no write on the bare `db`, there is no path by which the
    // row could persist past the rollback.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
