/**
 * The review gate on `insertAlbum` and `addToRotation` (BS#2807, slice 15 of #2791): each takes a required `gateBasis`
 * and verifies it inside its own transaction. `isGateOn` is mocked: no integration spec may set
 * `REVIEW_GATE_CUTOVER_DATE`, so every date-dependent case lives here.
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, library, intake_items, rotation } from '../../mocks/database.mock';

const mockResolveIdentity = jest.fn<() => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  resolveIdentity: mockResolveIdentity,
  lookupMetadata: jest.fn(),
  lookupBySong: jest.fn(),
  isLmlConfigured: jest.fn(),
  getRelease: jest.fn(),
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: class extends Error {},
}));
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: () => Promise.resolve(null) },
}));
jest.mock('@sentry/node', () => ({
  startSpan: <T>(_opts: unknown, callback: () => T | Promise<T>): Promise<T> => Promise.resolve(callback()),
  getActiveSpan: () => ({ setAttribute: jest.fn(), setAttributes: jest.fn() }),
  metrics: { count: jest.fn() },
}));
const mockIsGateOn = jest.fn<() => boolean>();
jest.mock('../../../apps/backend/utils/review-gate-cutover', () => ({ isGateOn: mockIsGateOn }));

import { addToRotation, insertAlbum } from '../../../apps/backend/services/library.service';
import { ReviewRequiredError, type GateBasis } from '../../../apps/backend/utils/review-gate-basis';
import WxycError from '../../../apps/backend/utils/error';

const ALBUM = { artist_id: 1, genre_id: 1, format_id: 1, album_title: 'DOGA', code_number: 1 };
const GATE_STATES = [
  ['off', false],
  ['on', true],
] as const;

/** Both reads a basis check can make end at `.for(...)`; the identity read ends at `.limit()` and finds nothing. */
const seedReads = (rows: unknown[]) => {
  const select = createMockQueryChain(rows);
  select.for = jest.fn().mockResolvedValue(rows);
  select.limit = jest.fn().mockResolvedValue([]);
  db.select.mockReturnValue(select);
  return select;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsGateOn.mockReturnValue(false);
  db.insert.mockReturnValue(createMockQueryChain([{ id: 5 }]));
});

describe('insertAlbum', () => {
  it.each(GATE_STATES)('pre_cutover with the gate %s', async (_label, on) => {
    mockIsGateOn.mockReturnValue(on);
    const outcome = insertAlbum(ALBUM, { kind: 'pre_cutover' });
    if (on) {
      await expect(outcome).rejects.toBeInstanceOf(ReviewRequiredError);
      expect(db.insert).not.toHaveBeenCalled();
    } else {
      await expect(outcome).resolves.toEqual({ id: 5 });
    }
  });

  it('opens its own transaction when given none, so the check and the insert are atomic', async () => {
    await insertAlbum(ALBUM, { kind: 'pre_cutover' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('runs on the transaction it is given, opening none', async () => {
    await insertAlbum(ALBUM, { kind: 'pre_cutover' }, db as never);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  describe('intake basis', () => {
    it.each(GATE_STATES)('is accepted for an item with an accepted review, gate %s', async (_label, on) => {
      mockIsGateOn.mockReturnValue(on);
      const select = seedReads([{ accepted_review_id: 7 }]);
      await expect(insertAlbum(ALBUM, { kind: 'intake', intakeItemId: 3 })).resolves.toEqual({ id: 5 });
      expect(select.from).toHaveBeenCalledWith(intake_items);
      expect(select.for).toHaveBeenCalledWith('update');
    });

    it.each([
      [
        'no accepted review, whatever the item cites or has submitted',
        [{ accepted_review_id: null, cited_album_id: 9 }],
      ],
      ['no such item', []],
    ])('is refused for %s', async (_label, rows) => {
      seedReads(rows);
      await expect(insertAlbum(ALBUM, { kind: 'intake', intakeItemId: 3 })).rejects.toBeInstanceOf(ReviewRequiredError);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});

describe('addToRotation', () => {
  const typed = { rotation_bin: 'M', artist_name: 'Juana Molina', album_title: 'DOGA' } as never;

  it.each(GATE_STATES)('pre_cutover (the typed-text arm) with the gate %s', async (_label, on) => {
    mockIsGateOn.mockReturnValue(on);
    const outcome = addToRotation(typed, { kind: 'pre_cutover' });
    if (on) {
      await expect(outcome).rejects.toBeInstanceOf(ReviewRequiredError);
      expect(db.insert).not.toHaveBeenCalled();
    } else {
      await expect(outcome).resolves.toEqual({ id: 5 });
    }
  });

  describe('existing_release basis', () => {
    const basis: GateBasis = { kind: 'existing_release', albumId: 100 };

    it.each(GATE_STATES)('re-rotates an existing release, gate %s', async (_label, on) => {
      mockIsGateOn.mockReturnValue(on);
      const select = seedReads([{ id: 100 }]);
      await expect(addToRotation({ album_id: 100, rotation_bin: 'M' }, basis)).resolves.toEqual({ id: 5 });
      expect(select.from).toHaveBeenCalledWith(library);
      expect(select.for).toHaveBeenCalledWith('key share');
      expect(db.insert).toHaveBeenCalledWith(rotation);
    });

    it('is a 404 when the library row is gone', async () => {
      seedReads([]);
      await expect(addToRotation({ album_id: 100, rotation_bin: 'M' }, basis)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses a basis that names a different release than the row it would write', async () => {
      seedReads([{ id: 100 }]);
      await expect(addToRotation({ album_id: 101, rotation_bin: 'M' }, basis)).rejects.toThrow('gate basis');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('intake basis', () => {
    it.each(GATE_STATES)('is accepted for an item with an accepted review, gate %s', async (_label, on) => {
      mockIsGateOn.mockReturnValue(on);
      seedReads([{ accepted_review_id: 7 }]);
      await expect(
        addToRotation({ album_id: 100, rotation_bin: 'M' }, { kind: 'intake', intakeItemId: 3 })
      ).resolves.toEqual({ id: 5 });
    });

    it('is refused for an item with no accepted review', async () => {
      seedReads([{ accepted_review_id: null }]);
      await expect(
        addToRotation({ album_id: 100, rotation_bin: 'M' }, { kind: 'intake', intakeItemId: 3 })
      ).rejects.toBeInstanceOf(ReviewRequiredError);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  it.each<GateBasis>([
    { kind: 'pre_cutover' },
    { kind: 'existing_release', albumId: 100 },
    { kind: 'intake', intakeItemId: 3 },
  ])('parses rotation_bin first: album_id with bin X is a 400 and nothing is read (%j)', async (basis) => {
    await expect(addToRotation({ album_id: 100, rotation_bin: 'X' } as never, basis)).rejects.toBeInstanceOf(WxycError);
    await expect(addToRotation({ album_id: 100, rotation_bin: 'X' } as never, basis)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockIsGateOn).not.toHaveBeenCalled();
  });
});
