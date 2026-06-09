import { jest } from '@jest/globals';
import { db } from '../../mocks/database.mock';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();
jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
}));

import * as Sentry from '@sentry/node';

import {
  checkLibraryArtistNameHealth,
  checkLibraryArtistNameDrift,
  _resetLibraryArtistNameHealthCheckForTests,
  _resetLibraryArtistNameDriftCheckForTests,
} from '../../../apps/backend/services/library-artist-name-assertion.service';

describe('library-artist-name-assertion', () => {
  beforeEach(() => {
    _resetLibraryArtistNameHealthCheckForTests();
    _resetLibraryArtistNameDriftCheckForTests();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  describe('checkLibraryArtistNameHealth', () => {
    // The wrapper fans out to BOTH the NULL check and the drift check
    // (BS#1092). Each first-call invocation issues two db.execute calls —
    // one per check. Tests that only care about the NULL-check behavior
    // mock the drift-check result as the second response.

    it('passes silently when count is 0', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
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
      db.execute.mockResolvedValueOnce([{ n: 1 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('regression: does not throw on the original 64,163-row degraded state either', async () => {
      // The 2026-04-28 backfill-missing scenario the assertion was originally
      // built for. With the soft-check pattern, even a fully-degraded column
      // doesn't throw — the column is denormalized from `artists.artist_name`
      // anyway, so search results stay correct via the JOIN projection.
      db.execute.mockResolvedValueOnce([{ n: 64163 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('emits a Sentry warning with tool/step/count tags when the column is degraded', async () => {
      db.execute.mockResolvedValueOnce([{ n: 42 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
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
      db.execute.mockResolvedValueOnce([{ n: '7' }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await checkLibraryArtistNameHealth();
      // Sentry fires for the NULL leg only; drift leg is clean.
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('caches across multiple invocations — two db calls (one per check), no repeats', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('caches the degraded state — only one Sentry warning per process for the NULL leg', async () => {
      db.execute.mockResolvedValueOnce([{ n: 100 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(2);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('regression (BS#1310): does not propagate inner-check rejection — drift query timing out must not 503 search', async () => {
      // The drift query (`library × artists JOIN WHERE artist_name IS DISTINCT FROM`)
      // has a non-indexable predicate and can exceed DB_STATEMENT_TIMEOUT_MS under
      // load. A `Promise.all` wrapper would propagate the rejection to every
      // catalog-search code path that awaits this assertion — the same failure
      // shape the 2026-04-30 OPN incident (#685) closed for the NULL check.
      // The wrapper must use Promise.allSettled and never throw.
      db.execute.mockResolvedValueOnce([{ n: 0 }]).mockRejectedValueOnce(new Error('statement timeout'));
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('regression (BS#1310): both legs rejecting still does not propagate to caller', async () => {
      db.execute
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(new Error('statement timeout'));
      await expect(checkLibraryArtistNameHealth()).resolves.toBeUndefined();
    });

    it('regression (BS#1310): rejected drift check stays memoized — no storm-pattern re-runs', async () => {
      // Under a persistent timeout condition, clearing memoization on rejection
      // would let every subsequent search call re-issue the expensive JOIN,
      // amplifying the upstream load that caused the timeout in the first place.
      // Operator restart is the retry mechanism; the cached rejection is the
      // backpressure.
      db.execute.mockResolvedValueOnce([{ n: 0 }]).mockRejectedValueOnce(new Error('statement timeout'));
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      // First call: NULL success + drift rejected (2 db calls).
      // Subsequent calls: both legs memoized, zero new db calls.
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('regression (BS#1310): rejected NULL check stays memoized — no storm-pattern re-runs', async () => {
      db.execute.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkLibraryArtistNameDrift', () => {
    // Drift detection (BS#1092): `library.artist_name` is denormalized from
    // `artists.artist_name` and kept in sync via a cascade trigger (migration
    // 0060). The trigger fires on `UPDATE OF artist_name ON artists`, but
    // ad-hoc admin SQL or future write paths that bypass the trigger leave
    // the denorm stale. Catalog list views (joined through `library_artist_view`)
    // show the new name while trigram search (which reads the denorm) returns
    // nothing — the search-not-found case is silent and user-invisible.
    // The drift check is a soft observability signal.

    it('passes silently when no rows drift', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await expect(checkLibraryArtistNameDrift()).resolves.toBeUndefined();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('emits a Sentry warning with count, sample library_ids, and the canonical tags when drift is detected', async () => {
      db.execute.mockResolvedValueOnce([{ n: 3, sample_ids: [101, 202, 303] }]);
      await checkLibraryArtistNameDrift();

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('3 row(s) drift'),
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({ tool: 'library-search', step: 'drift-check' }),
          extra: expect.objectContaining({
            count: 3,
            sample_library_ids: [101, 202, 303],
          }),
        })
      );
    });

    it('treats string count from Postgres as numeric', async () => {
      db.execute.mockResolvedValueOnce([{ n: '5', sample_ids: [1, 2, 3, 4, 5] }]);
      await checkLibraryArtistNameDrift();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('tolerates a missing sample_ids field (null or undefined)', async () => {
      db.execute.mockResolvedValueOnce([{ n: 4, sample_ids: null }]);
      await checkLibraryArtistNameDrift();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          extra: expect.objectContaining({ count: 4, sample_library_ids: [] }),
        })
      );
    });

    it('caches across multiple invocations — only one db call, one Sentry warning per process', async () => {
      db.execute.mockResolvedValueOnce([{ n: 12, sample_ids: [1, 2] }]);
      await checkLibraryArtistNameDrift();
      await checkLibraryArtistNameDrift();
      await checkLibraryArtistNameDrift();
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    });

    it('BS#1310: the rejected promise stays memoized — no storm-pattern re-runs of an expensive failed query', async () => {
      // Direct invocation of the drift check (not through the wrapper) still
      // exposes the underlying rejection — callers that opt in get the raw
      // outcome. But the failure is memoized: a second call returns the same
      // rejected promise without re-running the query. The wrapper
      // (`checkLibraryArtistNameHealth`) absorbs the rejection so search
      // callers never see it.
      db.execute.mockRejectedValueOnce(new Error('statement timeout'));
      await expect(checkLibraryArtistNameDrift()).rejects.toThrow('statement timeout');
      await expect(checkLibraryArtistNameDrift()).rejects.toThrow('statement timeout');
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('does not throw when drift is detected — degraded data must not take catalog search down', async () => {
      // Mirrors the NULL-check post-mortem contract: this is observability,
      // not a hard gate. A future write path that bypasses the cascade trigger
      // must not be allowed to 503 the catalog.
      db.execute.mockResolvedValueOnce([{ n: 9999, sample_ids: [1, 2, 3] }]);
      await expect(checkLibraryArtistNameDrift()).resolves.toBeUndefined();
    });
  });

  describe('checkLibraryArtistNameHealth — sweep wiring', () => {
    it('runs both the NULL check and the drift check', async () => {
      // Both checks share `db.execute`. The wrapper fans out so a single
      // post-startup call exercises both observability paths.
      db.execute.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([{ n: 0, sample_ids: [] }]);
      await checkLibraryArtistNameHealth();
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });
});
