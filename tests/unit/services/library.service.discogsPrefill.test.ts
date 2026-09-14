/**
 * Unit tests for `resolveDiscogsReleasePrefill` — the LML resolve behind the
 * add-to-rotation bench's "Autopopulate with Discogs link". LML's
 * `getRelease` is mocked so the tests cover the field mapping and the
 * 404-to-null / everything-else-bubbles error contract without a live LML.
 */

import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockLookupBySong = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
const mockGetRelease = jest.fn<(releaseId: number) => Promise<unknown>>();
const mockResolveIdentity = jest.fn<() => Promise<unknown>>();

// Mirror the real `LmlClientError` shape so the service's
// `err instanceof LmlClientError` branch picks up the mocked rejection. The
// real class lives in `shared/lml-client/src/index.ts`.
class MockLmlClientError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LmlClientError';
    this.statusCode = statusCode;
  }
}

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  lookupBySong: mockLookupBySong,
  isLmlConfigured: mockIsLmlConfigured,
  getRelease: mockGetRelease,
  resolveIdentity: mockResolveIdentity,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: MockLmlClientError,
}));

jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));

jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: () => T | Promise<T>): Promise<T> => Promise.resolve(callback()),
  getActiveSpan: () => ({ setAttribute: jest.fn(), setAttributes: jest.fn() }),
  metrics: { count: jest.fn() },
}));

import { resolveDiscogsReleasePrefill } from '../../../apps/backend/services/library.service';

// A fully-populated LML release, WXYC-representative (Juana Molina, DOGA on
// Sonamos). Field names match `DiscogsReleaseMetadata`.
const fullRelease = {
  release_id: 249504,
  master_id: 55123,
  title: 'DOGA',
  artist: 'Juana Molina',
  year: 2022,
  label: 'Sonamos',
  artist_id: 314159,
  label_id: 27182,
  genres: ['Rock'],
  styles: ['Folk, World, & Country'],
  tracklist: [],
  artwork_url: 'https://img.discogs.com/doga.jpg',
};

describe('resolveDiscogsReleasePrefill', () => {
  beforeEach(() => {
    mockGetRelease.mockReset();
    // The service module opens no DB connection on this path; keep the shared
    // mock chain quiet in case an unrelated import touches it.
    void db;
  });

  it('maps a resolved release to the bench prefill shape', async () => {
    mockGetRelease.mockResolvedValue(fullRelease);

    const prefill = await resolveDiscogsReleasePrefill(249504);

    expect(mockGetRelease).toHaveBeenCalledWith(249504);
    expect(prefill).toEqual({
      discogs_release_id: 249504,
      discogs_master_id: 55123,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      label: 'Sonamos',
      label_id: 27182,
      year: 2022,
      discogs_artist_id: 314159,
      genres: ['Rock'],
      styles: ['Folk, World, & Country'],
      artwork_url: 'https://img.discogs.com/doga.jpg',
    });
  });

  it('coerces the Discogs "year unknown" sentinel (0) to null', async () => {
    mockGetRelease.mockResolvedValue({ ...fullRelease, year: 0 });

    const prefill = await resolveDiscogsReleasePrefill(249504);

    expect(prefill?.year).toBeNull();
  });

  it('normalizes nullable release fields and absent arrays', async () => {
    mockGetRelease.mockResolvedValue({
      release_id: 777,
      master_id: null,
      title: 'Self-Released EP',
      artist: 'Chuquimamani-Condori',
      year: null,
      label: null,
      artist_id: null,
      label_id: null,
      // genres/styles omitted entirely (LML default is `[]`, but guard for absence)
      tracklist: [],
      artwork_url: null,
    });

    const prefill = await resolveDiscogsReleasePrefill(777);

    expect(prefill).toEqual({
      discogs_release_id: 777,
      discogs_master_id: null,
      artist_name: 'Chuquimamani-Condori',
      album_title: 'Self-Released EP',
      label: null,
      label_id: null,
      year: null,
      discogs_artist_id: null,
      genres: [],
      styles: [],
      artwork_url: null,
    });
  });

  it('drops a Discogs spacer.gif placeholder artwork URL to null', async () => {
    mockGetRelease.mockResolvedValue({
      ...fullRelease,
      artwork_url: 'https://img.discogs.com/spacer.gif',
    });

    const prefill = await resolveDiscogsReleasePrefill(249504);

    expect(prefill?.artwork_url).toBeNull();
  });

  it('returns null when LML reports Discogs has no such release (404)', async () => {
    mockGetRelease.mockRejectedValue(new MockLmlClientError('not found', 404));

    await expect(resolveDiscogsReleasePrefill(999999999)).resolves.toBeNull();
  });

  it('bubbles a non-404 LML failure (timeout, 5xx) rather than degrading to null', async () => {
    mockGetRelease.mockRejectedValue(new MockLmlClientError('bad gateway', 502));

    await expect(resolveDiscogsReleasePrefill(249504)).rejects.toThrow('bad gateway');
  });
});
