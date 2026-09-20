import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import { restoreDeletedBatch } from '../../../apps/backend/controllers/library.controller';

function mockReqResNext(overrides: Partial<Request> = {}) {
  const req = { params: {}, query: {}, body: {}, auth: { id: 'test-user-id' }, ...overrides } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

const BATCH_ID = '11111111-2222-4333-8444-555555555555';

const CONFLICT: libraryService.RestoreSlotConflict = {
  entity_id: 42,
  artist_id: 7,
  genre_id: 3,
  code_number: 7,
  code_volume_letters: null,
  occupied_by_library_id: 500,
  next_free_code_number: 9,
};

const RESTORED: libraryService.RestoredEntity = {
  entity_kind: 'library',
  entity_id: 42,
  table: 'library',
  relocated_code_number: null,
  children: { bins: 1, reviews: 0 },
};

const mockedService = libraryService as jest.Mocked<typeof libraryService>;

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * POST /library/deleted/:batchId/restore (BS#2585 / F2b). Route-level
 * write-gating is pinned by
 * `tests/unit/routes/library-restore-permissions.route.test.ts` and the replay
 * itself by `tests/unit/services/library.restoreDeletedBatch.test.ts`; this
 * file covers the wire contract the controller owns — which outcome becomes
 * which status, and which of them carry the conflict array the reissued-code
 * screen (dj-site#1572, mockup screen 6) renders from.
 */
describe('POST /library/deleted/:batchId/restore', () => {
  it('answers 200 with the replayed entities', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'restored', entities: [RESTORED] });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ batch_id: BATCH_ID, entities: [RESTORED] });
  });

  it('passes a resolution through to the service, and absence through as undefined', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'restored', entities: [RESTORED] });

    const withArm = mockReqResNext({ params: { batchId: BATCH_ID }, body: { resolution: 'next_free_code' } });
    await restoreDeletedBatch(withArm.req, withArm.res, withArm.next);
    expect(mockedService.restoreDeletedBatch).toHaveBeenCalledWith(BATCH_ID, 'next_free_code');

    const bare = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(bare.req, bare.res, bare.next);
    expect(mockedService.restoreDeletedBatch).toHaveBeenLastCalledWith(BATCH_ID, undefined);
  });

  // The interesting status. Both refusal arms carry `conflicts` so the screen
  // that asks the librarian which arm to take renders from either response.
  it('refuses an ambiguous request with a 400 that carries the conflict', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'resolution_required', conflicts: [CONFLICT] });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resolution_required', conflicts: [CONFLICT] })
    );
  });

  it('answers a declined restore with a 409 that carries the conflict', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'declined', conflicts: [CONFLICT] });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({
      params: { batchId: BATCH_ID },
      body: { resolution: 'decline' },
    });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'restore_declined', conflicts: [CONFLICT] })
    );
  });

  it('answers an already-restored batch with a 409 naming the ids', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'already_present', entity_ids: [42] });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'already_restored', entity_ids: [42] }));
  });

  // BS#2616: a batch holding a kind `RESTORE_PLAN` has no entry for (an
  // `artist` batch, today) is a named, permanent refusal -- never a 500.
  it('answers an unrestorable kind with a 409 naming it', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'unrestorable_kind', entity_kind: 'artist' });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(409);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unrestorable_kind', entity_kind: 'artist' })
    );
  });

  // Matches `DELETE /library/:id`: retryable, and deliberately not a 409.
  it('answers a stand-down with the same retryable 503 shape as the delete path', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'lock_unavailable' });

    const { req, res, next, statusMock, jsonMock } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lock_unavailable' }));
  });

  it('answers an unknown batch with a 404', async () => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'not_found' });

    const { req, res, next } = mockReqResNext({ params: { batchId: BATCH_ID } });
    await expect(restoreDeletedBatch(req, res, next)).rejects.toMatchObject({ statusCode: 404 });
  });

  // `batch_id` is a Postgres `uuid`; a non-UUID reaching the query is a 22P02,
  // which would answer 500 plus a Sentry capture instead of the honest 400.
  it.each([
    ['a non-UUID segment', 'not-a-uuid'],
    ['an empty segment', ''],
    ['a UUID with a trailing suffix', `${BATCH_ID}x`],
  ])('rejects %s with a 400 before touching the service', async (_label, batchId) => {
    const { req, res, next } = mockReqResNext({ params: { batchId } });
    await expect(restoreDeletedBatch(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.restoreDeletedBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['an unrecognized resolution', { resolution: 'relocate_silently' }],
    ['a non-string resolution', { resolution: 3 }],
    ['a null resolution', { resolution: null }],
  ])('rejects %s with a 400 before touching the service', async (_label, body) => {
    const { req, res, next } = mockReqResNext({ params: { batchId: BATCH_ID }, body });
    await expect(restoreDeletedBatch(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.restoreDeletedBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['an absent body', undefined],
    ['an empty body', {}],
  ])('treats %s as no resolution rather than a 500', async (_label, body) => {
    mockedService.restoreDeletedBatch.mockResolvedValue({ outcome: 'restored', entities: [RESTORED] });

    const { req, res, next, statusMock } = mockReqResNext({ params: { batchId: BATCH_ID }, body });
    await restoreDeletedBatch(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(mockedService.restoreDeletedBatch).toHaveBeenCalledWith(BATCH_ID, undefined);
  });

  it('rejects an array body with a 400', async () => {
    const { req, res, next } = mockReqResNext({ params: { batchId: BATCH_ID }, body: [] });
    await expect(restoreDeletedBatch(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedService.restoreDeletedBatch).not.toHaveBeenCalled();
  });
});
