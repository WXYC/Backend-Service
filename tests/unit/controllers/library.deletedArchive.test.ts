import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import { listDeletedArchive } from '../../../apps/backend/controllers/library.controller';

function mockReqResNext(overrides: Partial<Request> = {}) {
  const req = { params: {}, query: {}, body: {}, auth: { id: 'test-user-id' }, ...overrides } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

const BATCH: libraryService.DeletedArchiveBatch = {
  batch_id: '11111111-1111-1111-1111-111111111111',
  captured_at: new Date('2026-09-10T12:00:00Z'),
  actor: { user_id: 'librarian-1', role: 'musicDirector' },
  entities: [
    {
      entity_kind: 'library',
      table: 'library',
      row: { id: 42, album_title: 'On Your Own Love Again', artist_name: 'Jessica Pratt' },
      // Counts, not rows (BS#2561 F2a review finding 1) — see
      // `childCounts` in `library.service.ts`.
      children: { bins: 1, reviews: 0 },
    },
  ],
  unrecoverable: [
    'album_metadata',
    'library_identity',
    'library_identity_source',
    'uncovered_release_search_markers',
    'album_review_submissions',
  ],
};

const mockedService = libraryService as jest.Mocked<typeof libraryService>;

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * GET /library/deleted (BS#2561 / F2a). Route-level write-gating is pinned by
 * `tests/unit/routes/library-deleted-permissions.route.test.ts`; this file
 * covers the request/response contract the controller owns: the page
 * envelope shape, the search param, and the page/limit validation this
 * endpoint reuses from `parsePageParams`.
 */
describe('GET /library/deleted', () => {
  it('answers the page envelope with one row per batch, newest first', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([BATCH]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(1);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listDeletedArchive(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ results: [BATCH], total: 1, page: 0, totalPages: 1 });
  });

  it('answers 200 with an empty page when nothing has been deleted', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(0);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listDeletedArchive(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 0, page: 0, totalPages: 0 });
  });

  it('names every batch as carrying five unrecoverable dependents, never album_review_submissions data', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([BATCH]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(1);

    const { req, res, next, jsonMock } = mockReqResNext();
    await listDeletedArchive(req, res, next);

    const [batch] = jsonMock.mock.calls[0][0].results;
    expect(batch.unrecoverable).toContain('album_review_submissions');
    expect(batch.entities.every((entity: { table: string }) => entity.table !== 'album_review_submissions')).toBe(true);
  });

  it('passes page and limit through to the service', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(120);

    const { req, res, next, jsonMock } = mockReqResNext({ query: { page: '2', limit: '50' } } as Partial<Request>);
    await listDeletedArchive(req, res, next);

    expect(mockedService.getDeletedArchivePage).toHaveBeenCalledWith(2, 50, undefined);
    expect(mockedService.countDeletedArchiveBatches).toHaveBeenCalledWith(undefined);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 120, page: 2, totalPages: 3 });
  });

  it('trims and passes a search term through to the service', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([BATCH]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(1);

    const { req, res, next } = mockReqResNext({ query: { search: '  pratt  ' } } as Partial<Request>);
    await listDeletedArchive(req, res, next);

    expect(mockedService.getDeletedArchivePage).toHaveBeenCalledWith(0, 50, 'pratt');
    expect(mockedService.countDeletedArchiveBatches).toHaveBeenCalledWith('pratt');
  });

  it('treats a blank search as no search at all', async () => {
    mockedService.getDeletedArchivePage.mockResolvedValue([]);
    mockedService.countDeletedArchiveBatches.mockResolvedValue(0);

    const { req, res, next } = mockReqResNext({ query: { search: '   ' } } as Partial<Request>);
    await listDeletedArchive(req, res, next);

    expect(mockedService.getDeletedArchivePage).toHaveBeenCalledWith(0, 50, undefined);
  });

  it('rejects a repeated search key with a 400 before reading anything', async () => {
    const { req, res, next } = mockReqResNext({ query: { search: ['a', 'b'] } } as Partial<Request>);
    await expect(listDeletedArchive(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.getDeletedArchivePage).not.toHaveBeenCalled();
  });

  it.each([
    ['a negative page', { page: '-1' }],
    ['a non-numeric page', { page: 'first' }],
    ['a limit over the maximum', { limit: '101' }],
    ['a zero limit', { limit: '0' }],
  ])('rejects %s with a 400 before reading anything', async (_label, query) => {
    const { req, res, next } = mockReqResNext({ query } as Partial<Request>);
    await expect(listDeletedArchive(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.getDeletedArchivePage).not.toHaveBeenCalled();
    expect(mockedService.countDeletedArchiveBatches).not.toHaveBeenCalled();
  });
});
