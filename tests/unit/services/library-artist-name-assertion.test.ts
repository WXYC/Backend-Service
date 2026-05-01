import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import * as Sentry from '@sentry/node';

import {
  checkLibraryArtistNameHealth,
  _resetLibraryArtistNameHealthCheckForTests,
} from '../../../apps/backend/services/library-artist-name-assertion.service';

describe('library-artist-name-assertion', () => {
  beforeEach(() => {
    _resetLibraryArtistNameHealthCheckForTests();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  describe('checkLibraryArtistNameHealth', () => {
    it('passes silently when count is 0', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('regression: does not throw when count > 0 — degraded data must not take catalog search down', async () => {
      // Production incident 2026-04-30: a DJ on-air could not enter any track
      // because every /library/?artist_name=... call returned 503. LML was
      // healthy. The cause was a single NULL row in `library.artist_name`
      // (Oneohtrix Point Never, "Tranquilizer", added 2026-04-28 by the
      // library ETL which had not been wired to set artist_name) tripping
      // the precondition, which then cached the 503 for the lifetime of
      // the Node process. Every search permanently 503'd until the box
      // restarted AND the data was clean.
      //
      // Post-fix contract: degraded data is observability, not a hard gate.
      // The health check fires a Sentry warning and returns; search continues
      // to serve. Trigram and tsvector predicates can't match a NULL with `%`
      // or `@@`, so degraded rows fall out of search organically — no need
      // to refuse service.
      db.execute.mockResolvedValueOnce([{ n: 1 }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('regression: does not throw on the original 64,163-row degraded state either', async () => {
      // The 2026-04-28 backfill-missing scenario the assertion was originally
      // built for. With the soft-check pattern, even a fully-degraded column
      // doesn't throw — the column is denormalized from `artists.artist_name`
      // anyway, so search results stay correct via the JOIN projection.
      db.execute.mockResolvedValueOnce([{ n: 64163 }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('emits a Sentry warning with tool/step/count tags when the column is degraded', async () => {
      db.execute.mockResolvedValueOnce([{ n: 42 }]);
      await checkLibraryArtistNameHealth();

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('42 NULL row(s)'),
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({ tool: 'library-search', step: 'health-check' }),
          extra: expect.objectContaining({ count: 42 }),
        })
      );
    });

    it('treats string count from Postgres as numeric', async () => {
      // postgres-js sometimes returns count(*) as a stringified bigint.
      db.execute.mockResolvedValueOnce([{ n: '7' }]);
      await checkLibraryArtistNameHealth();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('caches across multiple invocations — only one db call', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('caches the degraded state — only one Sentry warning per process', async () => {
      db.execute.mockResolvedValueOnce([{ n: 100 }]);
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('clears the cache on transient DB errors so the next call retries', async () => {
      db.execute.mockRejectedValueOnce(new Error('connection reset'));
      await expect(checkLibraryArtistNameHealth()).rejects.toThrow('connection reset');

      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });
});
