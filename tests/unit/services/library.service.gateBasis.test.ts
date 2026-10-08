/**
 * The review gate on `insertAlbum` and `addToRotation` (BS#2807, slice 15 of #2791): each takes a required `gateBasis`
 * and verifies it inside its own transaction. `isGateOn` is mocked: no integration spec may set
 * `REVIEW_GATE_CUTOVER_DATE`, so every date-dependent case lives here.
 */

import { jest } from '@jest/globals';
import { db, createMockQueryChain, library, intake_items, rotation, flowsheet } from '../../mocks/database.mock';

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
jest.mock('../../../apps/backend/utils/review-gate-cutover', () => ({
  ...jest.requireActual<object>('../../../apps/backend/utils/review-gate-cutover'),
  isGateOn: mockIsGateOn,
}));

import { addToRotation, insertAlbum, linkRotationToAlbum } from '../../../apps/backend/services/library.service';
import {
  ReviewRequiredError,
  RotationNotEligibleError,
  type RotationInsertGateBasis,
} from '../../../apps/backend/utils/review-gate-basis';
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
      await expect(outcome).rejects.toThrow(
        new ReviewRequiredError('Every new release needs a review: put it on the review shelf first.')
      );
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
    const basis: RotationInsertGateBasis = { kind: 'existing_release', albumId: 100 };

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

  it.each<RotationInsertGateBasis>([
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

describe('the legacy bases (BS#2810)', () => {
  const CUTOVER = '2027-01-12';
  type Chain = {
    id: number;
    album_id: number | null;
    add_date: string;
    moved_from_rotation_id: number | null;
    has_successor?: boolean;
  };
  const row = (id: number, add_date: string, moved_from_rotation_id: number | null = null, album_id = null): Chain => ({
    id,
    album_id,
    add_date,
    moved_from_rotation_id,
  });
  const LEGACY = [row(1, '2026-12-01')];
  const POST_CUTOVER = [row(1, '2027-01-13')];
  const LINKED = [row(1, '2026-12-01', null, 7)];
  /** The chain read the legacy check makes, and the kill's UPDATE ... RETURNING. */
  const seedChain = (chain: Chain[], killed: unknown[] = [{ id: 1 }]) => {
    db.execute.mockResolvedValue(chain);
    db.update.mockReturnValue(createMockQueryChain(killed));
  };

  beforeEach(() => {
    process.env.REVIEW_GATE_CUTOVER_DATE = CUTOVER;
    mockIsGateOn.mockReturnValue(true);
  });
  afterEach(() => {
    delete process.env.REVIEW_GATE_CUTOVER_DATE;
  });

  describe('legacy_import, gate on', () => {
    const basis = { kind: 'legacy_import', rotationId: 1 } as const;

    it('inserts the release for an unlinked row added on or before the cutover', async () => {
      seedChain(LEGACY);
      await expect(insertAlbum(ALBUM, basis)).resolves.toEqual({ id: 5 });
      expect(db.insert).toHaveBeenCalledWith(library);
    });

    it.each([
      ['a post-cutover row', POST_CUTOVER],
      ['a linked row', LINKED],
      ['a row that does not exist', []],
    ])('refuses %s and writes nothing', async (_label, chain) => {
      seedChain(chain);
      await expect(insertAlbum(ALBUM, basis)).rejects.toBeInstanceOf(RotationNotEligibleError);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['a post-cutover row', POST_CUTOVER],
      ['a linked row', LINKED],
      ['a row that does not exist', []],
    ])('words the refusal of %s exactly', async (_label, chain) => {
      seedChain(chain);
      await expect(insertAlbum(ALBUM, basis)).rejects.toThrow(
        new RotationNotEligibleError(
          'This rotation entry is already linked to a release, or was added after reviews moved into the DJ site, so it needs a review before it can be catalogued.'
        )
      );
    });

    it('refuses a row that was moved to another bin, whatever its date, and writes nothing', async () => {
      seedChain([{ ...row(1, '2026-12-01'), has_successor: true }]);
      await expect(insertAlbum(ALBUM, basis)).rejects.toThrow(
        new RotationNotEligibleError('The rotation row was moved to another bin')
      );
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('imports the newest row of a chain whose ancestor was linked by old data', async () => {
      seedChain([{ ...row(2, '2027-02-01', 1), has_successor: false }, row(1, '2026-12-01', null, 7)]);
      await expect(insertAlbum(ALBUM, { kind: 'legacy_import', rotationId: 2 })).resolves.toEqual({ id: 5 });
    });

    it('answers the contract 409 body', () => {
      expect(new RotationNotEligibleError('no').toBody()).toEqual({ message: 'no', reason: 'rotation_not_eligible' });
    });
  });

  describe('legacy_move, gate on', () => {
    const typed = { rotation_bin: 'M', artist_name: 'Juana Molina', album_title: 'DOGA' } as never;
    const basis = { kind: 'legacy_move', fromRotationId: 1 } as const;

    it('kills the source and adds the new row, stamped with where it came from', async () => {
      seedChain(LEGACY);
      await expect(addToRotation(typed, basis)).resolves.toEqual({ id: 5 });
      expect(db.update).toHaveBeenCalledWith(rotation);
      const insert = db.insert.mock.results[0].value;
      expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({ moved_from_rotation_id: 1 }));
    });

    it('moves a post-cutover row that was itself moved from a legacy row', async () => {
      seedChain([row(2, '2027-02-01', 1), row(1, '2026-12-01')]);
      await expect(addToRotation(typed, { kind: 'legacy_move', fromRotationId: 2 })).resolves.toEqual({ id: 5 });
    });

    it.each([
      ['a post-cutover typed-text row', POST_CUTOVER],
      ['a linked row', LINKED],
    ])('refuses %s before touching the source', async (_label, chain) => {
      seedChain(chain);
      await expect(addToRotation(typed, basis)).rejects.toBeInstanceOf(RotationNotEligibleError);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses a second move of the same source: the guarded kill matches nothing, so no row is added', async () => {
      seedChain(LEGACY, []);
      await expect(addToRotation(typed, basis)).rejects.toBeInstanceOf(RotationNotEligibleError);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['a post-cutover typed-text row', POST_CUTOVER],
      ['a linked row', LINKED],
      ['a row that does not exist', []],
    ])('words the refusal of %s exactly, as a move and not an import', async (_label, chain) => {
      seedChain(chain);
      await expect(addToRotation(typed, basis)).rejects.toThrow(
        new RotationNotEligibleError(
          "This rotation entry can't be moved to another bin this way. It is already linked to a release, or it was added after reviews moved into the DJ site."
        )
      );
    });

    it('words the kill-guard refusal exactly (a lost race, or a source already out of rotation)', async () => {
      seedChain(LEGACY, []);
      await expect(addToRotation(typed, basis)).rejects.toThrow(
        new RotationNotEligibleError(
          'This rotation entry was taken out of rotation, linked, or moved before the move could save. Nothing was changed; reload to see where it stands.'
        )
      );
    });

    it('is accepted with the gate off too', async () => {
      mockIsGateOn.mockReturnValue(false);
      seedChain(LEGACY);
      await expect(addToRotation(typed, basis)).resolves.toEqual({ id: 5 });
    });
  });

  describe("linkRotationToAlbum on the caller's transaction", () => {
    it('joins it, and re-points the plays logged against the row', async () => {
      const select = createMockQueryChain();
      select.limit = jest
        .fn()
        .mockResolvedValueOnce([{ id: 5 }])
        .mockResolvedValueOnce([{ album_id: null }])
        .mockResolvedValueOnce([]);
      db.select.mockReturnValue(select);
      db.update.mockReturnValue(createMockQueryChain([{ id: 1 }]));
      await expect(linkRotationToAlbum(1, 5, db as never)).resolves.toMatchObject({ outcome: 'linked' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).toHaveBeenCalledWith(flowsheet);
    });
  });
});
