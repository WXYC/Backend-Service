import { jest } from '@jest/globals';

const mockGetLabelById =
  jest.fn<(id: number, tx?: unknown) => Promise<{ id: number; label_name: string } | undefined>>();
const mockCreateLabel = jest.fn<(name: string, parent?: number, tx?: unknown) => Promise<{ id: number }>>();

jest.mock('../../../apps/backend/services/labels.service', () => ({
  getLabelById: mockGetLabelById,
  createLabel: mockCreateLabel,
}));

const mockInsertArtistWithGenreCrossreference =
  jest.fn<
    (
      artist: { artist_name: string; alphabetical_name: string; code_letters: string },
      genreId: number,
      codeNumber: number,
      tx?: unknown
    ) => Promise<{ id: number; artist_name: string; alphabetical_name: string; code_letters: string }>
  >();
const mockGenerateAlbumCodeNumber = jest.fn<(artistId: number, genreId: number, tx?: unknown) => Promise<number>>();
const mockInsertAlbum = jest.fn<(album: unknown, tx?: unknown) => Promise<{ id: number }>>();
const mockAddToRotation = jest.fn<(rotation: unknown, urls?: string[], tx?: unknown) => Promise<unknown>>();
const mockGenerateArtistNumber = jest.fn<(letters: string, genreId: number) => Promise<number>>();
const mockGetArtistByCode = jest.fn<(letters: string, genreId: number, n: number) => Promise<unknown>>();
const mockArtistIdFromName = jest.fn<(name: string, genreId: number) => Promise<number | null>>();
const mockGetArtistCardByIdInGenre = jest.fn<(id: number, genreId: number) => Promise<unknown>>();
const mockGetArtistById = jest.fn<(id: number) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  RotationCardBinMismatchError: class RotationCardBinMismatchError extends Error {},
  generateArtistNumber: mockGenerateArtistNumber,
  getArtistByCode: mockGetArtistByCode,
  artistIdFromName: mockArtistIdFromName,
  getArtistCardByIdInGenre: mockGetArtistCardByIdInGenre,
  getArtistById: mockGetArtistById,
  insertArtistWithGenreCrossreference: mockInsertArtistWithGenreCrossreference,
  generateAlbumCodeNumber: mockGenerateAlbumCodeNumber,
  insertAlbum: mockInsertAlbum,
  addToRotation: mockAddToRotation,
}));

import { db } from '@wxyc/database';
import * as libraryService from '../../../apps/backend/services/library.service';
import WxycError from '../../../apps/backend/utils/error';
import {
  resolveNewAlbumLabel,
  fileLibraryRelease,
  planLibraryFiling,
  mapLibraryFilingError,
} from '../../../apps/backend/services/library-filing.service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveNewAlbumLabel', () => {
  it('resolves an existing label_id, preferring the stored label name when no label text is given', async () => {
    mockGetLabelById.mockResolvedValue({ id: 7, label_name: 'Drag City' });

    const result = await resolveNewAlbumLabel({ label_id: 7 });

    expect(result).toEqual({ label_id: 7, label: 'Drag City' });
  });

  it('rejects a label_id that does not reference a label', async () => {
    mockGetLabelById.mockResolvedValue(undefined);

    await expect(resolveNewAlbumLabel({ label_id: 999 })).rejects.toThrow(
      'label_id does not reference an existing label'
    );
  });

  it('creates-or-reuses a label from text on the supplied transaction', async () => {
    const tx = { marker: 'tx' };
    mockCreateLabel.mockResolvedValue({ id: 12 });

    const result = await resolveNewAlbumLabel({ label: 'Sonamos' }, tx as never);

    expect(mockCreateLabel).toHaveBeenCalledWith('Sonamos', undefined, tx);
    expect(result).toEqual({ label_id: 12, label: 'Sonamos' });
  });

  it('returns no label when neither label_id nor label text is given', async () => {
    const result = await resolveNewAlbumLabel({});

    expect(result).toEqual({ label_id: undefined, label: undefined });
    expect(mockCreateLabel).not.toHaveBeenCalled();
  });
});

describe('fileLibraryRelease', () => {
  const baseInput = {
    filingPlan: {
      kind: 'create' as const,
      artist_name: 'Chuquimamani-Condori',
      alphabetical_name: 'Chuquimamani-Condori',
      code_letters: 'CH',
      code_number: 5,
    },
    release: { album_title: 'Edits', label: 'self-released', genre_id: 3, format_id: 1 },
  };

  it('runs directly on a given outer transaction and lets a failure inside propagate, rather than swallowing it or opening its own transaction', async () => {
    const outerTx = { marker: 'outer-tx' };
    mockCreateLabel.mockResolvedValue({ id: 21 });
    mockInsertArtistWithGenreCrossreference.mockResolvedValue({
      id: 9,
      artist_name: 'Chuquimamani-Condori',
      alphabetical_name: 'Chuquimamani-Condori',
      code_letters: 'CH',
    });
    const failure = new Error('insertAlbum exploded');
    mockInsertAlbum.mockRejectedValue(failure);

    await expect(fileLibraryRelease(baseInput, outerTx as never)).rejects.toThrow(failure);

    // Every write that ran before the failure rode the SAME outer handle —
    // never a second, nested transaction of its own — which is what lets the
    // caller's own `db.transaction` wrapper roll all of it back together,
    // including the artist insert above, when it sees this rejection.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockCreateLabel).toHaveBeenCalledWith('self-released', undefined, outerTx);
    expect(mockInsertArtistWithGenreCrossreference).toHaveBeenCalledWith(expect.anything(), 3, 5, outerTx);
    expect(mockInsertAlbum).toHaveBeenCalledWith(expect.anything(), outerTx);
    expect(mockAddToRotation).not.toHaveBeenCalled();
  });
});

describe('fileLibraryRelease transaction handles', () => {
  const input = {
    filingPlan: {
      kind: 'existing' as const,
      artist: { id: 9, artist_name: 'Juana Molina', code_letters: 'JU', code_artist_number: 2, genre_id: 3 },
    },
    release: { album_title: 'DOGA', label: 'Sonamos', genre_id: 3, format_id: 1 },
    rotation: { rotation_bin: 'S' as const },
  };

  beforeEach(() => {
    mockCreateLabel.mockResolvedValue({ id: 21 });
    mockGenerateAlbumCodeNumber.mockResolvedValue(4);
    mockInsertAlbum.mockResolvedValue({ id: 70 });
    mockAddToRotation.mockResolvedValue({ id: 80 });
  });

  it('opens exactly one transaction without an outer handle and threads it through every write', async () => {
    const tx = { marker: 'own-tx' };
    (db.transaction as jest.Mock).mockImplementationOnce((cb: unknown) => (cb as (t: unknown) => unknown)(tx));

    await fileLibraryRelease(input);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockCreateLabel).toHaveBeenCalledWith('Sonamos', undefined, tx);
    expect(mockGenerateAlbumCodeNumber).toHaveBeenCalledWith(9, 3, tx);
    expect(mockInsertAlbum).toHaveBeenCalledWith(expect.anything(), tx);
    expect(mockAddToRotation).toHaveBeenCalledWith(expect.anything(), undefined, tx);
  });

  it('threads a given outer handle through the code-number generator and the rotation write', async () => {
    const outerTx = { marker: 'outer-tx' };

    await fileLibraryRelease(input, outerTx as never);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockGenerateAlbumCodeNumber).toHaveBeenCalledWith(9, 3, outerTx);
    expect(mockAddToRotation).toHaveBeenCalledWith(expect.anything(), undefined, outerTx);
  });
});

describe('planLibraryFiling', () => {
  const release = { album_title: 'DOGA', label: 'Sonamos', genre_id: 3, format_id: 1 };
  const createArtist = { kind: 'create' as const, artist_name: 'Juana Molina', code_letters: 'JU', genre_id: 3 };

  it.each([
    ['missing artist', {}, 'Missing Parameters: artist'],
    ['bad artist kind', { artist: { kind: 'x' } }, "Invalid Parameter: artist.kind must be 'create' or 'existing'"],
    ['missing release', { artist: createArtist }, 'Missing Parameters: release'],
    [
      'genre disagreement',
      { artist: { ...createArtist, genre_id: 4 }, release },
      'artist.genre_id must equal release.genre_id: the release is shelved under the artist code the create arm files in that genre',
    ],
    [
      'bad rotation bin',
      { artist: createArtist, release, rotation: { rotation_bin: 'nope' } },
      'Invalid rotation.rotation_bin "nope"',
    ],
  ])('rejects %s with a 400', async (_name, body, message) => {
    const rejection = expect(planLibraryFiling(body as never)).rejects;
    await rejection.toMatchObject({ statusCode: 400 });
    await rejection.toThrow(message);
  });

  it('returns the validated input with the assigned code number for a free artist code', async () => {
    mockGenerateArtistNumber.mockResolvedValue(6);
    mockGetArtistByCode.mockResolvedValue(undefined);
    mockArtistIdFromName.mockResolvedValue(null);

    const plan = await planLibraryFiling({ artist: createArtist, release, rotation: { rotation_bin: 'S' } });

    expect(plan).toEqual({
      kind: 'ok',
      input: {
        filingPlan: {
          kind: 'create',
          artist_name: 'Juana Molina',
          alphabetical_name: 'Juana Molina',
          code_letters: 'JU',
          code_number: 6,
        },
        release: { ...release, supplied_code_number: undefined, code_volume_letters: undefined },
        rotation: { rotation_bin: 'S', card_id: undefined, urls: undefined },
      },
    });
  });

  it('answers an artist_code_conflict body naming the holder of a supplied code', async () => {
    mockGetArtistByCode.mockResolvedValue({ artist_id: 9, artist_name: 'Jessica Pratt', code_letters: 'JU' });

    const plan = await planLibraryFiling({ artist: { ...createArtist, code_number: 2 }, release });

    expect(plan).toEqual({
      kind: 'conflict',
      body: {
        message: 'Artist code already exists for that genre and code letters.',
        reason: 'artist_code_conflict',
        artist: { id: 9, artist_name: 'Jessica Pratt', code_letters: 'JU', code_artist_number: 2, genre_id: 3 },
      },
    });
  });

  it('answers an artist_code_conflict with the exhaustion code when no number is assignable', async () => {
    mockGenerateArtistNumber.mockResolvedValue(2 ** 31);

    const plan = await planLibraryFiling({ artist: createArtist, release });

    expect(plan).toMatchObject({
      kind: 'conflict',
      body: { reason: 'artist_code_conflict', code: 'artist_code_number_exhausted' },
    });
  });
});

describe('mapLibraryFilingError', () => {
  it('maps a rotation card/bin mismatch onto its 409 body', () => {
    const err = new libraryService.RotationCardBinMismatchError(1, 'S', 'A');

    expect(mapLibraryFilingError(err)).toEqual({ message: err.message, reason: 'rotation_card_bin_mismatch' });
  });

  it('remaps a dangling rotation card onto a 400, code intact', () => {
    const err = new WxycError('no such card', 404, { code: 'rotation_card_not_found' });

    expect(() => mapLibraryFilingError(err)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'rotation_card_not_found' })
    );
  });

  it('rethrows anything else', () => {
    const err = new Error('boom');

    expect(() => mapLibraryFilingError(err)).toThrow(err);
  });
});
