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

jest.mock('../../../apps/backend/services/library.service', () => ({
  insertArtistWithGenreCrossreference: mockInsertArtistWithGenreCrossreference,
  generateAlbumCodeNumber: mockGenerateAlbumCodeNumber,
  insertAlbum: mockInsertAlbum,
  addToRotation: mockAddToRotation,
}));

import { db } from '@wxyc/database';
import { resolveNewAlbumLabel, fileLibraryRelease } from '../../../apps/backend/services/library-filing.service';

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
    release_genre_id: 3,
    release_format_id: 1,
    album_title: 'Edits',
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
