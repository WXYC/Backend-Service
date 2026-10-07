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
const mockInsertAlbum = jest.fn<(album: unknown, basis: unknown, tx?: unknown) => Promise<{ id: number }>>();
const mockAddToRotation =
  jest.fn<(rotation: unknown, basis: unknown, urls?: string[], tx?: unknown) => Promise<unknown>>();
const mockGenerateArtistNumber = jest.fn<(letters: string, genreId: number) => Promise<number>>();
const mockGetArtistByCode = jest.fn<(letters: string, genreId: number, n: number) => Promise<unknown>>();
const mockArtistIdFromName = jest.fn<(name: string, genreId: number) => Promise<number | null>>();
const mockGetArtistCardByIdInGenre = jest.fn<(id: number, genreId: number) => Promise<unknown>>();
const mockGetArtistById = jest.fn<(id: number) => Promise<unknown>>();
const mockCheckStreamingAvailability = jest.fn<(artist: string, album: string, opts?: unknown) => Promise<unknown>>();
const mockLmlLookup = jest.fn<(artist: string, album: string, song?: unknown, opts?: unknown) => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  isLmlConfigured: () => !!process.env.LIBRARY_METADATA_URL,
  checkStreamingAvailability: mockCheckStreamingAvailability,
}));
jest.mock('../../../apps/backend/services/lml/index', () => ({
  lmlLookupCoordinator: { lookup: mockLmlLookup },
}));

const mockReconcileLibraryUrlsToLml = jest.fn<(urls: string[]) => Promise<void>>();

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
  reconcileLibraryUrlsToLml: mockReconcileLibraryUrlsToLml,
}));

import { db } from '@wxyc/database';
import * as libraryService from '../../../apps/backend/services/library.service';
import WxycError from '../../../apps/backend/utils/error';
import { ReviewRequiredError } from '../../../apps/backend/utils/review-gate-basis';
import {
  resolveNewAlbumLabel,
  fileLibraryRelease,
  completeLibraryFiling,
  planLibraryFiling,
  mapLibraryFilingError,
} from '../../../apps/backend/services/library-filing.service';

const BASIS = { kind: 'pre_cutover' } as const;

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

    await expect(fileLibraryRelease(baseInput, BASIS, outerTx as never)).rejects.toThrow(failure);

    // Every write that ran before the failure rode the SAME outer handle —
    // never a second, nested transaction of its own — which is what lets the
    // caller's own `db.transaction` wrapper roll all of it back together,
    // including the artist insert above, when it sees this rejection.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockCreateLabel).toHaveBeenCalledWith('self-released', undefined, outerTx);
    expect(mockInsertArtistWithGenreCrossreference).toHaveBeenCalledWith(expect.anything(), 3, 5, outerTx);
    expect(mockInsertAlbum).toHaveBeenCalledWith(expect.anything(), BASIS, outerTx);
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

    await fileLibraryRelease(input, BASIS);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockCreateLabel).toHaveBeenCalledWith('Sonamos', undefined, tx);
    expect(mockGenerateAlbumCodeNumber).toHaveBeenCalledWith(9, 3, tx);
    expect(mockInsertAlbum).toHaveBeenCalledWith(expect.anything(), BASIS, tx);
    expect(mockAddToRotation).toHaveBeenCalledWith(expect.anything(), BASIS, undefined, tx);
  });

  it('threads the transaction it opens through the create arm artist insert when no outer handle is given', async () => {
    const tx = { marker: 'own-tx' };
    (db.transaction as jest.Mock).mockImplementationOnce((cb: unknown) => (cb as (t: unknown) => unknown)(tx));
    mockInsertArtistWithGenreCrossreference.mockResolvedValue({
      id: 9,
      artist_name: 'Stereolab',
      alphabetical_name: 'Stereolab',
      code_letters: 'ST',
    });

    await fileLibraryRelease(
      {
        filingPlan: {
          kind: 'create',
          artist_name: 'Stereolab',
          alphabetical_name: 'Stereolab',
          code_letters: 'ST',
          code_number: 5,
        },
        release: input.release,
      },
      BASIS
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockInsertArtistWithGenreCrossreference).toHaveBeenCalledWith(expect.anything(), 3, 5, tx);
  });

  it('answers code_comp_letter: null for an artist the create arm just filed (a lettered V/A slot is already a 409)', async () => {
    mockInsertArtistWithGenreCrossreference.mockResolvedValue({
      id: 9,
      artist_name: 'Stereolab',
      alphabetical_name: 'Stereolab',
      code_letters: 'ST',
    });

    const result = await fileLibraryRelease(
      {
        filingPlan: {
          kind: 'create',
          artist_name: 'Stereolab',
          alphabetical_name: 'Stereolab',
          code_letters: 'ST',
          code_number: 5,
        },
        release: input.release,
      },
      BASIS,
      {} as never
    );

    expect(result.artist).toHaveProperty('code_comp_letter', null);
  });

  it('files the release under the supplied call number and volume letters, generating a number only when none is supplied', async () => {
    await fileLibraryRelease(
      { ...input, release: { ...input.release, supplied_code_number: 12, code_volume_letters: 'ab' } },
      BASIS,
      {} as never
    );
    expect(mockInsertAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ code_number: 12, code_volume_letters: 'ab' }),
      BASIS,
      expect.anything()
    );
    expect(mockGenerateAlbumCodeNumber).not.toHaveBeenCalled();

    await fileLibraryRelease(input, BASIS, {} as never);
    expect(mockInsertAlbum).toHaveBeenLastCalledWith(
      expect.objectContaining({ code_number: 4 }),
      BASIS,
      expect.anything()
    );
  });

  it('hands the one gate basis to both the release insert and the rotation entry', async () => {
    const intake = { kind: 'intake', intakeItemId: 12 } as const;

    await fileLibraryRelease(input, intake, {} as never);

    expect(mockInsertAlbum).toHaveBeenCalledWith(expect.anything(), intake, expect.anything());
    expect(mockAddToRotation).toHaveBeenCalledWith(expect.anything(), intake, undefined, expect.anything());
  });

  it('threads a given outer handle through the code-number generator and the rotation write', async () => {
    const outerTx = { marker: 'outer-tx' };

    await fileLibraryRelease(input, BASIS, outerTx as never);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockGenerateAlbumCodeNumber).toHaveBeenCalledWith(9, 3, outerTx);
    expect(mockAddToRotation).toHaveBeenCalledWith(expect.anything(), BASIS, undefined, outerTx);
  });
});

describe('completeLibraryFiling', () => {
  const album = { id: 70, album_title: 'DOGA' };
  const result = {
    artist: { id: 9, artist_name: 'Juana Molina', code_letters: 'JU', code_artist_number: 2, genre_id: 3 },
    release: album,
    rotation: undefined,
  };
  const existingPlan = { kind: 'existing' as const, artist: result.artist };
  const release = { album_title: 'DOGA', genre_id: 3, format_id: 1 };
  const originalLmlUrl = process.env.LIBRARY_METADATA_URL;

  beforeEach(() => {
    // Unconfigured LML makes `enrichNewAlbum` return the inserted row as-is.
    delete process.env.LIBRARY_METADATA_URL;
    mockReconcileLibraryUrlsToLml.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalLmlUrl === undefined) delete process.env.LIBRARY_METADATA_URL;
    else process.env.LIBRARY_METADATA_URL = originalLmlUrl;
  });

  it('reconciles the rotation urls to LML after the commit and returns the enriched release', async () => {
    const urls = ['https://sonamos.example/doga'];

    const body = await completeLibraryFiling(result as never, {
      filingPlan: existingPlan,
      release,
      rotation: { rotation_bin: 'S', urls },
    });

    expect(mockReconcileLibraryUrlsToLml).toHaveBeenCalledWith(urls);
    expect(body).toEqual({ ...result, release: album });
  });

  it('enriches under the credited alternate artist name, not the catalog name', async () => {
    process.env.LIBRARY_METADATA_URL = 'http://lml.test';
    mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: null });
    mockLmlLookup.mockResolvedValue(null);

    await completeLibraryFiling(result as never, {
      filingPlan: existingPlan,
      release: { ...release, alternate_artist_name: 'Molina, Juana' },
    });

    expect(mockCheckStreamingAvailability).toHaveBeenCalledWith('Molina, Juana', 'DOGA', expect.anything());
    expect(mockLmlLookup).toHaveBeenCalledWith('Molina, Juana', 'DOGA', undefined, expect.anything());
  });

  it('enriches under the catalog artist name when no alternate name is given', async () => {
    process.env.LIBRARY_METADATA_URL = 'http://lml.test';
    mockCheckStreamingAvailability.mockResolvedValue({ on_streaming: null });
    mockLmlLookup.mockResolvedValue(null);

    await completeLibraryFiling(result as never, { filingPlan: existingPlan, release });

    expect(mockCheckStreamingAvailability).toHaveBeenCalledWith('Juana Molina', 'DOGA', expect.anything());
  });

  it.each([
    ['no rotation', undefined],
    ['a rotation without urls', { rotation_bin: 'S' as const }],
    ['an empty urls list', { rotation_bin: 'S' as const, urls: [] }],
  ])('does not reconcile with %s', async (_name, rotation) => {
    await completeLibraryFiling(result as never, { filingPlan: existingPlan, release, rotation });

    expect(mockReconcileLibraryUrlsToLml).not.toHaveBeenCalled();
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

  it('recomputes a server-assigned code number once when the first one is already taken', async () => {
    mockGenerateArtistNumber.mockResolvedValueOnce(6).mockResolvedValueOnce(7);
    mockGetArtistByCode
      .mockResolvedValueOnce({ artist_id: 9, artist_name: 'Jessica Pratt', code_letters: 'JU' })
      .mockResolvedValueOnce(undefined);
    mockArtistIdFromName.mockResolvedValue(null);

    const plan = await planLibraryFiling({ artist: createArtist, release });

    expect(mockGenerateArtistNumber).toHaveBeenCalledTimes(2);
    expect(mockGetArtistByCode).toHaveBeenNthCalledWith(2, 'JU', 3, 7);
    expect(plan).toMatchObject({ kind: 'ok', input: { filingPlan: { kind: 'create', code_number: 7 } } });
  });

  it('hands on the validated call-code values, not the raw release values it spreads', async () => {
    mockGenerateArtistNumber.mockResolvedValue(6);
    mockGetArtistByCode.mockResolvedValue(undefined);
    mockArtistIdFromName.mockResolvedValue(null);

    const trimmed = await planLibraryFiling({
      artist: createArtist,
      release: { ...release, code_number: 12, code_volume_letters: '  ab  ' },
    });
    const blank = await planLibraryFiling({
      artist: createArtist,
      release: { ...release, code_volume_letters: '' },
    });

    if (trimmed.kind !== 'ok' || blank.kind !== 'ok') throw new Error('expected ok plans');
    expect(trimmed.input.release.code_volume_letters).toBe('ab');
    expect(trimmed.input.release.supplied_code_number).toBe(12);
    expect(blank.input.release.code_volume_letters).toBeUndefined();
    expect(blank.input.release.supplied_code_number).toBeUndefined();
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

  // BS#2835: `kind: 'existing'` and both 409 bodies build the contract's `Artist` through a field-by-field copy, so
  // the slot's compilation letter has to be carried by hand.
  it.each([
    ['a lettered compilation slot', 'M'],
    ['a named-artist slot', null],
  ])('carries code_comp_letter on the existing arm for %s', async (_label, letter) => {
    mockGetArtistCardByIdInGenre.mockResolvedValue({
      artist_id: 9,
      artist_name: 'Various Artists',
      alphabetical_name: 'Various Artists',
      genre_id: 3,
      code_letters: 'V/A',
      code_artist_number: 0,
      code_comp_letter: letter,
    });

    const plan = await planLibraryFiling({ artist: { kind: 'existing', artist_id: 9 }, release });

    expect(plan).toMatchObject({
      kind: 'ok',
      input: { filingPlan: { kind: 'existing', artist: { id: 9, code_comp_letter: letter } } },
    });
  });

  it('carries the holder’s code_comp_letter on both artist_code_conflict and artist_name_conflict bodies', async () => {
    mockGetArtistByCode.mockResolvedValueOnce({
      artist_id: 9,
      artist_name: 'Various Artists',
      code_letters: 'V/A',
      code_comp_letter: 'M',
    });
    const codeConflict = await planLibraryFiling({ artist: { ...createArtist, code_number: 0 }, release });

    mockGetArtistByCode.mockResolvedValueOnce(undefined);
    mockArtistIdFromName.mockResolvedValueOnce(9);
    mockGetArtistCardByIdInGenre.mockResolvedValueOnce({
      artist_id: 9,
      artist_name: 'Juana Molina',
      alphabetical_name: 'Juana Molina',
      genre_id: 3,
      code_letters: 'JU',
      code_artist_number: 2,
      code_comp_letter: null,
    });
    const nameConflict = await planLibraryFiling({ artist: { ...createArtist, code_number: 2 }, release });

    expect(codeConflict).toMatchObject({ kind: 'conflict', body: { artist: { code_comp_letter: 'M' } } });
    expect(nameConflict).toMatchObject({ kind: 'conflict', body: { artist: { code_comp_letter: null } } });
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

// BS#2844: the create text is bounded at 128 code points (`varchar(128)`), in
// code points, and a refusal writes nothing. Astral characters are two UTF-16
// units, so a bare `.length` would refuse the 128 case.
describe('create text bounds on POST /library/filings', () => {
  const astral = (n: number) => '\u{1F600}'.repeat(n);
  const createArtist = { kind: 'create' as const, artist_name: 'Juana Molina', code_letters: 'JU', genre_id: 3 };
  const baseRelease = { album_title: 'DOGA', label: 'Sonamos', genre_id: 3, format_id: 1 };
  const filingInput = (release: Record<string, unknown>) => ({
    filingPlan: {
      kind: 'create' as const,
      artist_name: 'Juana Molina',
      alphabetical_name: 'Juana Molina',
      code_letters: 'JU',
      code_number: 6,
    },
    release: { ...baseRelease, ...release } as never,
  });

  beforeEach(() => {
    mockGenerateArtistNumber.mockResolvedValue(6);
    mockGetArtistByCode.mockResolvedValue(undefined);
    mockArtistIdFromName.mockResolvedValue(null);
    mockCreateLabel.mockResolvedValue({ id: 12 });
  });

  // album_title and alternate_artist_name are refused in the plan, before the transaction.
  it.each(['album_title', 'alternate_artist_name'])(
    '%s: accepts 128 code points, refuses 129 with a 400',
    async (field) => {
      await expect(
        planLibraryFiling({ artist: createArtist, release: { ...baseRelease, [field]: astral(128) } })
      ).resolves.toMatchObject({ kind: 'ok' });

      const rejection = expect(
        planLibraryFiling({ artist: createArtist, release: { ...baseRelease, [field]: astral(129) } })
      ).rejects;
      await rejection.toMatchObject({ statusCode: 400 });
      await rejection.toThrow(`release.${field} must be 128 characters or fewer`);
      expect(mockInsertAlbum).not.toHaveBeenCalled();
    }
  );

  it('trims album_title and nulls a blank alternate_artist_name', async () => {
    const plan = await planLibraryFiling({
      artist: createArtist,
      release: { ...baseRelease, album_title: `  ${astral(128)}  `, alternate_artist_name: '   ' },
    });

    expect(plan).toMatchObject({
      input: { release: { album_title: astral(128), alternate_artist_name: null } },
    });
  });

  it('refuses a 129-code-point label, minting no labels row and writing no album', async () => {
    mockInsertArtistWithGenreCrossreference.mockResolvedValue({
      id: 9,
      artist_name: 'Juana Molina',
      alphabetical_name: 'Juana Molina',
      code_letters: 'JU',
    });
    const outerTx = { marker: 'tx' };

    const rejection = expect(fileLibraryRelease(filingInput({ label: astral(129) }), BASIS, outerTx as never)).rejects;
    await rejection.toMatchObject({ statusCode: 400 });
    await rejection.toThrow('release.label must be 128 characters or fewer');

    expect(mockCreateLabel).not.toHaveBeenCalled();
    expect(mockInsertAlbum).not.toHaveBeenCalled();
  });

  it('accepts a 128-code-point label, trimmed, on the transaction', async () => {
    mockInsertArtistWithGenreCrossreference.mockResolvedValue({
      id: 9,
      artist_name: 'Juana Molina',
      alphabetical_name: 'Juana Molina',
      code_letters: 'JU',
    });
    mockInsertAlbum.mockResolvedValue({ id: 1 });
    const outerTx = { marker: 'tx' };

    await fileLibraryRelease(filingInput({ label: `  ${astral(128)}  ` }), BASIS, outerTx as never);

    expect(mockCreateLabel).toHaveBeenCalledWith(astral(128), undefined, outerTx);
  });
});

describe('mapLibraryFilingError', () => {
  it('maps a rotation card/bin mismatch onto its 409 body', () => {
    const err = new libraryService.RotationCardBinMismatchError(1, 'S', 'A');

    expect(mapLibraryFilingError(err)).toEqual({ message: err.message, reason: 'rotation_card_bin_mismatch' });
  });

  it('maps a refused review gate onto its 409 body, with the reason the bench branches on', () => {
    const err = new ReviewRequiredError('Every new release needs a review');

    expect(mapLibraryFilingError(err)).toEqual({ message: err.message, reason: 'review_required' });
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
