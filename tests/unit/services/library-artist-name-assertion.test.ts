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
  assertLibraryArtistNamePopulated,
  LibraryArtistNameMissingError,
  _resetLibraryArtistNameAssertionForTests,
} from '../../../apps/backend/services/library-artist-name-assertion.service';
import {
  searchLibrary,
  fuzzySearchLibrary,
  searchByArtist,
  searchAlbumsByTitle,
  findSimilarArtist,
} from '../../../apps/backend/services/library.service';
import errorHandler from '../../../apps/backend/middleware/errorHandler';
import type { Request, Response, NextFunction } from 'express';

describe('library-artist-name-assertion', () => {
  beforeEach(() => {
    _resetLibraryArtistNameAssertionForTests();
  });

  describe('assertLibraryArtistNamePopulated', () => {
    it('passes when count is 0', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await expect(assertLibraryArtistNamePopulated()).resolves.toBeUndefined();
    });

    it('throws LibraryArtistNameMissingError when count > 0', async () => {
      db.execute.mockResolvedValueOnce([{ n: 64163 }]);
      await expect(assertLibraryArtistNamePopulated()).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('attaches statusCode 503 and a backfill runbook pointer to the error', async () => {
      db.execute.mockResolvedValueOnce([{ n: 100 }]);
      await expect(assertLibraryArtistNamePopulated()).rejects.toMatchObject({
        statusCode: 503,
        message: expect.stringContaining('jobs/library-artist-name-backfill'),
      });
    });

    it('logs to Sentry with tool/step/count tags when the assertion fails', async () => {
      db.execute.mockResolvedValueOnce([{ n: 42 }]);
      await assertLibraryArtistNamePopulated().catch(() => undefined);

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          level: 'error',
          tags: expect.objectContaining({ tool: 'library-search', step: 'startup-assertion' }),
          extra: expect.objectContaining({ count: 42 }),
        })
      );
    });

    it('treats string count from Postgres as numeric', async () => {
      // postgres-js sometimes returns count(*) as a stringified bigint.
      db.execute.mockResolvedValueOnce([{ n: '7' }]);
      await expect(assertLibraryArtistNamePopulated()).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('caches the success result — only one db call across multiple invocations', async () => {
      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await assertLibraryArtistNamePopulated();
      await assertLibraryArtistNamePopulated();
      await assertLibraryArtistNamePopulated();
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('caches the missing-backfill failure — only one db call, repeated rejections', async () => {
      db.execute.mockResolvedValueOnce([{ n: 100 }]);
      await expect(assertLibraryArtistNamePopulated()).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
      await expect(assertLibraryArtistNamePopulated()).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
      await expect(assertLibraryArtistNamePopulated()).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('clears the cache on transient DB errors so the next call retries', async () => {
      db.execute.mockRejectedValueOnce(new Error('connection reset'));
      await expect(assertLibraryArtistNamePopulated()).rejects.toThrow('connection reset');

      db.execute.mockResolvedValueOnce([{ n: 0 }]);
      await expect(assertLibraryArtistNamePopulated()).resolves.toBeUndefined();
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('catalog search functions are gated by the assertion', () => {
    beforeEach(() => {
      // Each test resets the cache (parent beforeEach) and primes the next
      // db.execute call to report a non-empty NULL count.
      db.execute.mockResolvedValueOnce([{ n: 100 }]);
    });

    it('searchLibrary refuses to serve when artist_name has NULLs', async () => {
      await expect(searchLibrary('autechre')).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('fuzzySearchLibrary refuses to serve when artist_name has NULLs', async () => {
      await expect(fuzzySearchLibrary('autechre')).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('searchByArtist refuses to serve when artist_name has NULLs', async () => {
      await expect(searchByArtist('autechre')).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('searchAlbumsByTitle refuses to serve when artist_name has NULLs', async () => {
      await expect(searchAlbumsByTitle('confield')).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });

    it('findSimilarArtist refuses to serve when artist_name has NULLs', async () => {
      await expect(findSimilarArtist('autechre')).rejects.toBeInstanceOf(LibraryArtistNameMissingError);
    });
  });

  describe('errorHandler middleware → 503 with runbook pointer', () => {
    it('translates LibraryArtistNameMissingError into a 503 response whose body points at the backfill job', () => {
      const error = new LibraryArtistNameMissingError(64163);
      const status = jest.fn().mockReturnThis();
      const json = jest.fn().mockReturnThis();
      const res = { status, json } as unknown as Response;
      const req = { method: 'GET', url: '/library' } as Request;
      const next = jest.fn() as NextFunction;

      errorHandler(error, req, res, next);

      expect(status).toHaveBeenCalledWith(503);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('jobs/library-artist-name-backfill'),
        })
      );
    });
  });
});
