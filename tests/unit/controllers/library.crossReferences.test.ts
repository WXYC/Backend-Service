import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import {
  listArtistCrossReferences,
  listReleaseCrossReferences,
} from '../../../apps/backend/controllers/library.controller';

function mockReqResNext(overrides: Partial<Request> = {}) {
  const req = { params: {}, query: {}, body: {}, auth: { id: 'test-user-id' }, ...overrides } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

// Real rows from the tubafrenzy set these endpoints exist to preserve — the
// "Barry Black is filed w/ Eric Bachmann" pointer and the Don Caballero /
// Thee Speaking Canaries pair both appear in
// scripts/audit/bs_2117_crossref_backfill.sql's enumerated source data.
const ARTIST_CROSSREFERENCES: libraryService.ArtistCrossReferenceRow[] = [
  {
    source_artist_id: 4102,
    source_artist_name: 'Barry Black',
    target_artist_id: 991,
    target_artist_name: 'Eric Bachmann',
    target_code_letters: 'BA',
    target_code_artist_number: 42,
    comment: 'Barry Black is filed w/ Eric Bachmann',
  },
  {
    source_artist_id: 1200,
    source_artist_name: 'Don Caballero',
    target_artist_id: 1855,
    target_artist_name: 'Thee Speaking Canaries',
    target_code_letters: 'SP',
    target_code_artist_number: 72,
    comment: null,
  },
];

const RELEASE_CROSSREFERENCES: libraryService.ReleaseCrossReferenceRow[] = [
  {
    artist_id: 4102,
    artist_name: 'Barry Black',
    library_id: 20114,
    album_title: 'To The Races',
    album_artist_name: 'Eric Bachmann',
    alternate_artist_name: null,
    format_name: 'CD',
    genre_id: 11,
    code_letters: 'BA',
    code_artist_number: 42,
    code_number: 7,
    code_volume_letters: null,
    comment: 'see also Barry Black',
  },
];

const mockedService = libraryService as jest.Mocked<typeof libraryService>;

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * The two frozen `/wxycdb` cross-reference listings (`xrefsToLibraryCodes.jsp`
 * and `xrefsToLibraryReleases.jsp`). Read-only by decision — WXYC/wiki#89 D5
 * freezes the artist set and drops the release set — so these cover the read
 * contract only: the page shape, the empty-collection state each JSP renders
 * as "There are no ... Cross-References", and the page/limit bounds.
 */
describe('GET /library/crossreferences/artists', () => {
  it('answers the page envelope with one row per cross-reference', async () => {
    mockedService.getArtistCrossReferences.mockResolvedValue(ARTIST_CROSSREFERENCES);
    mockedService.countArtistCrossReferences.mockResolvedValue(2);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listArtistCrossReferences(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      results: ARTIST_CROSSREFERENCES,
      total: 2,
      page: 0,
      totalPages: 1,
    });
  });

  it('projects both endpoints of the pair, with the call number on the target only', async () => {
    mockedService.getArtistCrossReferences.mockResolvedValue(ARTIST_CROSSREFERENCES);
    mockedService.countArtistCrossReferences.mockResolvedValue(2);

    const { req, res, next, jsonMock } = mockReqResNext();
    await listArtistCrossReferences(req, res, next);

    // The JSP renders a bare presentation name for the cross-REFERENCING
    // artist and code + name for the cross-REFERENCED one; a row that carried
    // a code for both, or for neither, would not reproduce that table.
    const [row] = jsonMock.mock.calls[0][0].results;
    expect(Object.keys(row).sort()).toEqual(
      [
        'comment',
        'source_artist_id',
        'source_artist_name',
        'target_artist_id',
        'target_artist_name',
        'target_code_artist_number',
        'target_code_letters',
      ].sort()
    );
  });

  it('answers 200 with an empty page when there are no cross-references', async () => {
    mockedService.getArtistCrossReferences.mockResolvedValue([]);
    mockedService.countArtistCrossReferences.mockResolvedValue(0);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listArtistCrossReferences(req, res, next);

    // A 200 with total 0, NOT a 404: the collection exists and is empty, which
    // is what the JSP's "There are no Library Code Cross-References" row is.
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 0, page: 0, totalPages: 0 });
  });

  it('defaults to a limit that covers the whole frozen collection in one request', async () => {
    mockedService.getArtistCrossReferences.mockResolvedValue(ARTIST_CROSSREFERENCES);
    mockedService.countArtistCrossReferences.mockResolvedValue(2);

    const { req, res, next } = mockReqResNext();
    await listArtistCrossReferences(req, res, next);

    // 119 is the full size of tubafrenzy's LIBRARY_CODE_CROSS_REFERENCE, the
    // ceiling D5's freeze pins this table to. A default at or below 100 would
    // make the collection permanently un-fetchable in one call.
    const [, limit] = mockedService.getArtistCrossReferences.mock.calls[0];
    expect(limit).toBeGreaterThanOrEqual(119);
  });

  it('passes page and limit through to the service', async () => {
    mockedService.getArtistCrossReferences.mockResolvedValue([]);
    mockedService.countArtistCrossReferences.mockResolvedValue(240);

    const { req, res, next, jsonMock } = mockReqResNext({ query: { page: '2', limit: '100' } } as Partial<Request>);
    await listArtistCrossReferences(req, res, next);

    expect(mockedService.getArtistCrossReferences).toHaveBeenCalledWith(2, 100);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 240, page: 2, totalPages: 3 });
  });

  it.each([
    ['a negative page', { page: '-1' }],
    ['a non-numeric page', { page: 'first' }],
    ['a repeated page key', { page: ['0', '1'] }],
    ['a zero limit', { limit: '0' }],
    ['a non-numeric limit', { limit: 'all' }],
    ['a limit over the maximum', { limit: '501' }],
    ['a repeated limit key', { limit: ['10', '20'] }],
  ])('rejects %s with a 400 before reading anything', async (_label, query) => {
    const { req, res, next } = mockReqResNext({ query } as Partial<Request>);
    await expect(listArtistCrossReferences(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.getArtistCrossReferences).not.toHaveBeenCalled();
    expect(mockedService.countArtistCrossReferences).not.toHaveBeenCalled();
  });
});

describe('GET /library/crossreferences/releases', () => {
  it('answers the page envelope with one row per cross-reference', async () => {
    mockedService.getReleaseCrossReferences.mockResolvedValue(RELEASE_CROSSREFERENCES);
    mockedService.countReleaseCrossReferences.mockResolvedValue(1);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listReleaseCrossReferences(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      results: RELEASE_CROSSREFERENCES,
      total: 1,
      page: 0,
      totalPages: 1,
    });
  });

  it('carries the referencing artist and the release separately', async () => {
    mockedService.getReleaseCrossReferences.mockResolvedValue(RELEASE_CROSSREFERENCES);
    mockedService.countReleaseCrossReferences.mockResolvedValue(1);

    const { req, res, next, jsonMock } = mockReqResNext();
    await listReleaseCrossReferences(req, res, next);

    // The referencing artist is usually NOT the release's own artist -- that
    // difference is the association the row records -- so the two must not
    // collapse into one name field.
    const [row] = jsonMock.mock.calls[0][0].results;
    expect(row.artist_name).toBe('Barry Black');
    expect(row.album_artist_name).toBe('Eric Bachmann');
    // Call-number PARTS, not a composed "BA 42/7" string, matching every other
    // catalog projection in this service.
    expect(Object.keys(row).sort()).toEqual(
      [
        'album_artist_name',
        'album_title',
        'alternate_artist_name',
        'artist_id',
        'artist_name',
        'code_artist_number',
        'code_letters',
        'code_number',
        'code_volume_letters',
        'comment',
        'format_name',
        'genre_id',
        'library_id',
      ].sort()
    );
  });

  it('answers 200 with an empty page when there are no cross-references', async () => {
    mockedService.getReleaseCrossReferences.mockResolvedValue([]);
    mockedService.countReleaseCrossReferences.mockResolvedValue(0);

    const { req, res, next, statusMock, jsonMock } = mockReqResNext();
    await listReleaseCrossReferences(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 0, page: 0, totalPages: 0 });
  });

  it('passes page and limit through to the service', async () => {
    mockedService.getReleaseCrossReferences.mockResolvedValue([]);
    mockedService.countReleaseCrossReferences.mockResolvedValue(35);

    const { req, res, next, jsonMock } = mockReqResNext({ query: { page: '1', limit: '20' } } as Partial<Request>);
    await listReleaseCrossReferences(req, res, next);

    expect(mockedService.getReleaseCrossReferences).toHaveBeenCalledWith(1, 20);
    expect(jsonMock).toHaveBeenCalledWith({ results: [], total: 35, page: 1, totalPages: 2 });
  });

  it.each([
    ['a negative page', { page: '-1' }],
    ['a limit over the maximum', { limit: '501' }],
  ])('rejects %s with a 400 before reading anything', async (_label, query) => {
    const { req, res, next } = mockReqResNext({ query } as Partial<Request>);
    await expect(listReleaseCrossReferences(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.getReleaseCrossReferences).not.toHaveBeenCalled();
    expect(mockedService.countReleaseCrossReferences).not.toHaveBeenCalled();
  });
});
