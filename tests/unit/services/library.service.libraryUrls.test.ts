/**
 * Unit tests for the release-scoped definitive-links store (BS#2491):
 *
 *   1. `deriveLibraryUrlIdentity(url)` — pure. Maps a stored URL to the LML
 *      `(source, external_id)` it reconciles to, or null when the host maps to
 *      no known source. Bare-domain tolerant; only http(s).
 *   2. `replaceLibraryUrls(tx, libraryId, urls)` — replace-wholesale write:
 *      delete the release's rows, insert the new set position-ordered.
 *   3. `reconcileLibraryUrlsToLml(urls)` — fail-open reconcile: resolveIdentity
 *      per derivable URL, a throw is classified + counted, never rethrown.
 *   4. `setLibraryUrls(libraryId, urls)` — write + reconcile + re-read, and the
 *      fail-open guarantee at that seam (a reconcile throw never fails the
 *      write).
 *   5. `addToRotation`'s catalogued arm ALSO writes `library_urls` (release-
 *      scoped), while the uncatalogued arm does not.
 *
 * Drizzle and LML are mocked (the established `database.mock` + a fake
 * `@wxyc/lml-client`), so the tests assert on the INSERT/DELETE values and the
 * resolveIdentity requests directly without any DB or network.
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation, rotation_urls, library_urls } from '../../mocks/database.mock';

class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

const mockResolveIdentity = jest.fn<() => Promise<{ identity_id: number; kind: 'release'; minted: boolean }>>();
const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<() => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  resolveIdentity: mockResolveIdentity,
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
  getRelease: mockGetRelease,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: MockLmlClientError,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));

const mockSentryMetricsCount = jest.fn<(name: string, value: number, opts: unknown) => void>();
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: () => T | Promise<T>): Promise<T> => Promise.resolve(callback()),
  getActiveSpan: () => ({ setAttribute: jest.fn(), setAttributes: jest.fn() }),
  metrics: { count: mockSentryMetricsCount },
}));

import {
  addToRotation,
  deriveLibraryUrlIdentity,
  reconcileLibraryUrlsToLml,
  replaceLibraryUrls,
  setLibraryUrls,
} from '../../../apps/backend/services/library.service';

describe('deriveLibraryUrlIdentity', () => {
  test.each([
    // discogs releases — numeric id extracted, across URL shapes
    ['https://www.discogs.com/release/1234567-Album-Title', { source: 'discogs_release', external_id: '1234567' }],
    ['https://www.discogs.com/release/1234567', { source: 'discogs_release', external_id: '1234567' }],
    ['discogs.com/release/999', { source: 'discogs_release', external_id: '999' }],
    ['https://www.discogs.com/es/release/555-Titulo', { source: 'discogs_release', external_id: '555' }],
    ['https://www.discogs.com/Artist-Album/release/777', { source: 'discogs_release', external_id: '777' }],
    // bandcamp / spotify / apple music — the canonical URL is the external_id
    [
      'https://juana-molina.bandcamp.com/album/doga',
      { source: 'bandcamp', external_id: 'https://juana-molina.bandcamp.com/album/doga' },
    ],
    [
      'juana-molina.bandcamp.com/album/doga',
      { source: 'bandcamp', external_id: 'https://juana-molina.bandcamp.com/album/doga' },
    ],
    [
      'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc',
      { source: 'spotify', external_id: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc' },
    ],
    ['https://spotify.com/album/abc', { source: 'spotify', external_id: 'https://spotify.com/album/abc' }],
    [
      'https://music.apple.com/us/album/doga/123456789',
      { source: 'apple_music', external_id: 'https://music.apple.com/us/album/doga/123456789' },
    ],
  ])('%s → recognised source', (url, expected) => {
    expect(deriveLibraryUrlIdentity(url)).toEqual({ kind: 'release', ...expected });
  });

  test.each([
    ['https://www.discogs.com/master/42', 'discogs master carries no release id'],
    ['https://www.discogs.com/artist/12', 'discogs artist is not a release'],
    ['https://example.com/some/album', 'unknown host'],
    ['https://apple.com/store', 'apple.com but not music.apple.com'],
    ['javascript:alert(1)', 'non-http(s) scheme'],
    ['   ', 'blank'],
    ['', 'empty'],
  ])('%s → null (%s)', (url) => {
    expect(deriveLibraryUrlIdentity(url)).toBeNull();
  });
});

describe('replaceLibraryUrls (replace-wholesale, position order)', () => {
  const LIBRARY_ID = 4242;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("deletes the release's existing rows then inserts the new set, positioned by array index", async () => {
    const insertChain = createMockQueryChain([]);
    db.insert.mockReturnValue(insertChain);

    await replaceLibraryUrls(db as never, LIBRARY_ID, ['https://a.example', 'https://b.example', 'https://c.example']);

    // Existing rows for this release are cleared first (replace-wholesale).
    expect(db.delete).toHaveBeenCalledWith(library_urls);
    // Then the new set is inserted, position = array index.
    expect(db.insert).toHaveBeenCalledWith(library_urls);
    expect(insertChain.values).toHaveBeenCalledWith([
      { library_id: LIBRARY_ID, url: 'https://a.example', position: 0 },
      { library_id: LIBRARY_ID, url: 'https://b.example', position: 1 },
      { library_id: LIBRARY_ID, url: 'https://c.example', position: 2 },
    ]);
  });

  test('an empty set clears the release (delete, no insert)', async () => {
    const insertChain = createMockQueryChain([]);
    db.insert.mockReturnValue(insertChain);

    await replaceLibraryUrls(db as never, LIBRARY_ID, []);

    expect(db.delete).toHaveBeenCalledWith(library_urls);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('reconcileLibraryUrlsToLml (fail-open)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves each derivable URL and skips ones with no known source', async () => {
    mockResolveIdentity.mockResolvedValue({ identity_id: 1, kind: 'release', minted: true });

    await reconcileLibraryUrlsToLml([
      'https://www.discogs.com/release/5',
      'https://example.com/not-a-known-source',
      'https://juana-molina.bandcamp.com/album/doga',
    ]);

    expect(mockResolveIdentity).toHaveBeenCalledTimes(2);
    expect(mockResolveIdentity).toHaveBeenNthCalledWith(1, {
      kind: 'release',
      source: 'discogs_release',
      external_id: '5',
    });
    expect(mockResolveIdentity).toHaveBeenNthCalledWith(2, {
      kind: 'release',
      source: 'bandcamp',
      external_id: 'https://juana-molina.bandcamp.com/album/doga',
    });
  });

  test('a resolve throw does not reject; it is classified and counted under caller=library_urls', async () => {
    mockResolveIdentity.mockRejectedValue(new MockLmlClientError('LML request timed out', 504));

    await expect(reconcileLibraryUrlsToLml(['https://www.discogs.com/release/9'])).resolves.toBeUndefined();

    expect(mockSentryMetricsCount).toHaveBeenCalledTimes(1);
    expect(mockSentryMetricsCount).toHaveBeenCalledWith('lml.resolve.fallback_to_null', 1, {
      attributes: { caller: 'library_urls', reason: 'timeout' },
    });
  });

  test('no derivable URLs → no resolve calls, no counter', async () => {
    await reconcileLibraryUrlsToLml(['https://example.com/x', '   ']);
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockSentryMetricsCount).not.toHaveBeenCalled();
  });
});

describe('setLibraryUrls (write + reconcile + re-read)', () => {
  const LIBRARY_ID = 808;
  const albumRow = { id: LIBRARY_ID, album_title: 'DOGA', discogs_unavailable: false };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const primeReread = () => {
    const selectChain = createMockQueryChain([albumRow]);
    selectChain.limit = jest.fn().mockResolvedValue([albumRow]);
    db.select.mockReturnValue(selectChain);
  };

  test('writes replace-wholesale in a transaction, reconciles, and returns the re-read album', async () => {
    const insertChain = createMockQueryChain([]);
    db.insert.mockReturnValue(insertChain);
    mockResolveIdentity.mockResolvedValue({ identity_id: 1, kind: 'release', minted: true });
    primeReread();

    const result = await setLibraryUrls(LIBRARY_ID, ['https://www.discogs.com/release/3']);

    expect(db.transaction).toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledWith(library_urls);
    expect(db.insert).toHaveBeenCalledWith(library_urls);
    expect(insertChain.values).toHaveBeenCalledWith([
      { library_id: LIBRARY_ID, url: 'https://www.discogs.com/release/3', position: 0 },
    ]);
    expect(mockResolveIdentity).toHaveBeenCalledWith({ kind: 'release', source: 'discogs_release', external_id: '3' });
    expect(result?.id).toBe(LIBRARY_ID);
  });

  test('a reconcile throw does not fail the write — the row still landed and the album re-reads', async () => {
    const insertChain = createMockQueryChain([]);
    db.insert.mockReturnValue(insertChain);
    mockResolveIdentity.mockRejectedValue(new MockLmlClientError('LML request timed out', 504));
    primeReread();

    const result = await setLibraryUrls(LIBRARY_ID, ['https://www.discogs.com/release/3']);

    expect(db.insert).toHaveBeenCalledWith(library_urls);
    expect(mockSentryMetricsCount).toHaveBeenCalledWith('lml.resolve.fallback_to_null', 1, {
      attributes: { caller: 'library_urls', reason: 'timeout' },
    });
    expect(result?.id).toBe(LIBRARY_ID);
  });
});

describe('addToRotation writes library_urls for the catalogued arm (BS#2491)', () => {
  const ALBUM_ID = 500;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const primeIdentityMiss = () => {
    const selectChain = createMockQueryChain([]);
    selectChain.limit = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);
  };

  test('catalogued add with urls writes rotation_urls AND library_urls (release-scoped, position-ordered)', async () => {
    primeIdentityMiss();
    const insertChain = createMockQueryChain([{ id: 77, album_id: ALBUM_ID, rotation_bin: 'M' }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ album_id: ALBUM_ID, rotation_bin: 'M' }, ['https://a.example', 'https://b.example']);

    // rotation row, then rotation_urls, then the release-scoped library_urls.
    expect(db.insert.mock.calls.map((c) => c[0])).toEqual([rotation, rotation_urls, library_urls]);
    // library_urls carries the release id and array-index positions.
    expect(insertChain.values.mock.calls[2][0]).toEqual([
      { library_id: ALBUM_ID, url: 'https://a.example', position: 0 },
      { library_id: ALBUM_ID, url: 'https://b.example', position: 1 },
    ]);
    // Replace-wholesale: the release's prior links are cleared first.
    expect(db.delete).toHaveBeenCalledWith(library_urls);
  });

  test('uncatalogued add with urls writes rotation_urls only — no library_urls', async () => {
    primeIdentityMiss();
    const insertChain = createMockQueryChain([{ id: 78, rotation_bin: 'M' }]);
    db.insert.mockReturnValue(insertChain);

    await addToRotation({ rotation_bin: 'M', artist_name: 'Juana Molina', album_title: 'DOGA' }, ['https://a.example']);

    expect(db.insert.mock.calls.map((c) => c[0])).toEqual([rotation, rotation_urls]);
    expect(db.delete).not.toHaveBeenCalledWith(library_urls);
  });
});
