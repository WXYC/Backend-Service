/**
 * Unit tests for `updateRotation` + its `killRotationInDB` delegate
 * (BS#2113).
 *
 * `updateRotation` is the sole writer of the five in-scope `rotation`
 * columns (`artist_name`, `album_title`, `record_label`, `add_date`,
 * `kill_date`) — both `PATCH /library/rotation/:id` (the new field-level
 * editor) and `PATCH /library/rotation` (`killRotation`, via
 * `killRotationInDB`) delegate to it rather than issuing their own UPDATE.
 * `killRotationInDB`'s wire behavior (default-to-`CURRENT_DATE` when no
 * date is supplied) must stay unchanged.
 *
 * Review findings 1 and 4 changed the function's contract: it now resolves
 * an `UpdateRotationOutcome` (`updated` / `not_found` / `linked_conflict`)
 * rather than a bare row, and a write that touches the snapshot trio
 * (`artist_name`/`album_title`/`record_label`) is a compare-and-set —
 * `album_id IS NULL` rides in the UPDATE's own WHERE, and the SET bundles a
 * `tracklist_lookup_attempted_at: null` reset in the same statement. See
 * `library.service.test.ts`'s "rotation LML cache invalidation" block for
 * the companion proof that a snapshot write actually evicts the tier-3
 * picker's in-memory LRUs, which needs the LML-lookup mocking already wired
 * up there.
 *
 * Drizzle is mocked via the established `database.mock` so the assertions
 * below inspect the exact `.set()` payload each call produces.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
  envInt: (_name: string, fallback: number) => fallback,
}));

import { updateRotation, killRotationInDB } from '../../../apps/backend/services/library.service';

/**
 * The disambiguating read `updateRotation` issues after a guarded zero-row
 * UPDATE terminates on `.limit(1)`, not `.returning()`/`.execute()` —
 * `createMockQueryChain`'s default `.limit()` just returns the chain itself
 * for further chaining, so it isn't awaitable on its own. Every other SELECT
 * fixture in this codebase that terminates on `.limit()` (e.g.
 * `library.service.test.ts`'s `mockRow` helper) overrides it the same way.
 */
function mockSelectViaLimit(rows: unknown[]): void {
  const chain = createMockQueryChain(rows);
  chain.limit = jest.fn().mockResolvedValue(rows);
  db.select.mockReturnValueOnce(chain);
}

describe('updateRotation (BS#2113)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('non-snapshot fields (add_date / kill_date) — no compare-and-set, no cache touch', () => {
    test('only SETs the keys present in the update payload', async () => {
      const chain = createMockQueryChain([{ id: 42, kill_date: '2024-06-01' }]);
      db.update.mockReturnValueOnce(chain);

      const outcome = await updateRotation(42, { kill_date: '2024-06-01' });

      expect(db.update).toHaveBeenCalledWith(rotation);
      expect(chain.set).toHaveBeenCalledWith({ kill_date: '2024-06-01' });
      expect(chain.where).toHaveBeenCalled();
      expect(outcome).toEqual({ outcome: 'updated', rotation: { id: 42, kill_date: '2024-06-01' } });
    });

    test('writes add_date and kill_date together with no tracklist_lookup_attempted_at in SET', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, { add_date: '2024-01-15', kill_date: '2024-06-01' });

      expect(chain.set).toHaveBeenCalledWith({ add_date: '2024-01-15', kill_date: '2024-06-01' });
    });

    test('an explicit null kill_date clears the column', async () => {
      const chain = createMockQueryChain([{ id: 42, kill_date: null }]);
      db.update.mockReturnValueOnce(chain);

      const outcome = await updateRotation(42, { kill_date: null });

      expect(chain.set).toHaveBeenCalledWith({ kill_date: null });
      expect(outcome).toEqual({ outcome: 'updated', rotation: { id: 42, kill_date: null } });
    });

    // BS#2113 review finding 4: without the snapshot trio in play there is no
    // linked/unlinked precondition to disambiguate — a zero-row UPDATE can
    // only mean "no such row", so this resolves not_found off the UPDATE
    // alone, with no follow-up SELECT.
    test('a zero-row UPDATE resolves not_found without a follow-up SELECT', async () => {
      const chain = createMockQueryChain([]);
      db.update.mockReturnValueOnce(chain);

      const outcome = await updateRotation(999, { kill_date: '2024-06-01' });

      expect(outcome).toEqual({ outcome: 'not_found' });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('snapshot-trio fields (artist_name / album_title / record_label) — BS#2113 review findings 1 and 4', () => {
    test('bundles tracklist_lookup_attempted_at: null into the same SET (finding 1)', async () => {
      const chain = createMockQueryChain([{ id: 42, artist_name: 'Juana Molina' }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, { artist_name: 'Juana Molina' });

      expect(chain.set).toHaveBeenCalledWith({
        artist_name: 'Juana Molina',
        tracklist_lookup_attempted_at: null,
      });
    });

    test('writes all five in-scope columns when all are supplied, still nulling the picker marker', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, {
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        record_label: 'self-released',
        add_date: '2024-01-15',
        kill_date: '2024-06-01',
      });

      expect(chain.set).toHaveBeenCalledWith({
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        record_label: 'self-released',
        add_date: '2024-01-15',
        kill_date: '2024-06-01',
        tracklist_lookup_attempted_at: null,
      });
    });

    test('carries a WHERE guard beyond plain id equality (the album_id IS NULL precondition)', async () => {
      const plainChain = createMockQueryChain([{ id: 42, kill_date: '2024-06-01' }]);
      db.update.mockReturnValueOnce(plainChain);
      await updateRotation(42, { kill_date: '2024-06-01' });
      const plainWhere = plainChain.where.mock.calls[0][0];

      db.update.mockClear();
      const guardedChain = createMockQueryChain([{ id: 42, artist_name: 'Juana Molina' }]);
      db.update.mockReturnValueOnce(guardedChain);
      await updateRotation(42, { artist_name: 'Juana Molina' });
      const guardedWhere = guardedChain.where.mock.calls[0][0];

      // Not asserting the exact drizzle expression tree (that would couple the
      // test to ORM internals), but comparing the two WHEREs against each
      // other: an earlier revision asserted only `toBeDefined()`, which the
      // unguarded `eq(rotation.id, 42)` satisfies just as well — deleting
      // `isNull(rotation.album_id)` left it green. A structural difference
      // between the snapshot and non-snapshot WHERE is the ORM-agnostic
      // property that actually fails when the guard is removed.
      expect(guardedChain.where).toHaveBeenCalledTimes(1);
      expect(guardedWhere).toBeDefined();
      expect(JSON.stringify(guardedWhere)).not.toEqual(JSON.stringify(plainWhere));
    });

    test('opens a transaction ONLY for the snapshot path — a kill-only write stays a single statement', async () => {
      // `killRotationInDB` (PATCH /library/rotation) routes through this
      // writer. Wrapping its one UPDATE in a transaction turned one round
      // trip into three (BEGIN / UPDATE / COMMIT) and held a pooled
      // connection across all three, on a box that also serves the live
      // flowsheet. Only the compare-and-set path needs a transaction, because
      // only it follows a zero-row UPDATE with a disambiguating read.
      db.transaction.mockClear();
      db.update.mockReturnValueOnce(createMockQueryChain([{ id: 42, kill_date: '2024-06-01' }]));
      await updateRotation(42, { kill_date: '2024-06-01' });
      expect(db.transaction).not.toHaveBeenCalled();

      db.transaction.mockClear();
      db.update.mockReturnValueOnce(createMockQueryChain([{ id: 42, artist_name: 'Juana Molina' }]));
      await updateRotation(42, { artist_name: 'Juana Molina' });
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    test('a guarded zero-row UPDATE followed by a still-linked row resolves linked_conflict with the current album_id', async () => {
      const updateChain = createMockQueryChain([]); // guarded UPDATE matches nothing: row is linked
      db.update.mockReturnValueOnce(updateChain);
      mockSelectViaLimit([{ album_id: 7 }]); // disambiguating read: row exists, linked

      const outcome = await updateRotation(42, { artist_name: 'Juana Molina' });

      expect(outcome).toEqual({ outcome: 'linked_conflict', albumId: 7 });
    });

    test('a guarded zero-row UPDATE followed by no row at all resolves not_found', async () => {
      const updateChain = createMockQueryChain([]);
      db.update.mockReturnValueOnce(updateChain);
      mockSelectViaLimit([]); // row genuinely doesn't exist

      const outcome = await updateRotation(999, { artist_name: 'Juana Molina' });

      expect(outcome).toEqual({ outcome: 'not_found' });
    });

    // Pathological but handled: the disambiguating read finds the row again
    // NULL (a second concurrent write raced the first). Reporting a 409 with
    // a fabricated album id would be worse than a 404 the caller can retry.
    test('a disambiguating read that finds the row unlinked after all resolves not_found, not a fabricated conflict', async () => {
      const updateChain = createMockQueryChain([]);
      db.update.mockReturnValueOnce(updateChain);
      mockSelectViaLimit([{ album_id: null }]);

      const outcome = await updateRotation(42, { artist_name: 'Juana Molina' });

      expect(outcome).toEqual({ outcome: 'not_found' });
    });

    test('a successful snapshot write still returns the outcome shape success callers expect', async () => {
      const chain = createMockQueryChain([{ id: 42, artist_name: 'Juana Molina', album_id: null }]);
      db.update.mockReturnValueOnce(chain);

      const outcome = await updateRotation(42, { artist_name: 'Juana Molina' });

      expect(outcome).toEqual({
        outcome: 'updated',
        rotation: { id: 42, artist_name: 'Juana Molina', album_id: null },
      });
    });
  });

  // Real drizzle never issues this UPDATE: `mapUpdateSet` throws
  // `Error: No values to set` before it generates any SQL, so an earlier
  // version of this test — which asserted `chain.set` was called with `{}` —
  // documented a contract the ORM does not honor. `updateRotation` now
  // refuses the empty payload itself, with a message that names the function
  // instead of the ORM internal. Unreachable through either HTTP surface
  // (the controller 400s on an empty body; `killRotationInDB` always supplies
  // a `kill_date`), but a future direct caller gets a usable error.
  test('an empty payload is refused before any UPDATE is issued', async () => {
    await expect(updateRotation(42, {})).rejects.toThrow('at least one column to set');

    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('killRotationInDB delegates to updateRotation (BS#2113)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('an explicit kill_date produces the identical SET payload updateRotation would for the same field', async () => {
    const killDate = '2027-01-01';

    const viaKillRotation = createMockQueryChain([{ id: 42, kill_date: killDate }]);
    db.update.mockReturnValueOnce(viaKillRotation);
    await killRotationInDB(42, killDate);

    const viaUpdateRotation = createMockQueryChain([{ id: 42, kill_date: killDate }]);
    db.update.mockReturnValueOnce(viaUpdateRotation);
    await updateRotation(42, { kill_date: killDate });

    expect(viaKillRotation.set).toHaveBeenCalledWith({ kill_date: killDate });
    expect(viaUpdateRotation.set).toHaveBeenCalledWith({ kill_date: killDate });
    expect(viaKillRotation.set.mock.calls[0]).toEqual(viaUpdateRotation.set.mock.calls[0]);
  });

  test('omitting kill_date falls back to a CURRENT_DATE SQL fragment, not a JS-computed date', async () => {
    const chain = createMockQueryChain([{ id: 42 }]);
    db.update.mockReturnValueOnce(chain);

    await killRotationInDB(42);

    const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
    // A drizzle `sql` template tag returns an SQL object, not a string.
    expect(typeof setArg.kill_date).not.toBe('string');
    expect(JSON.stringify(setArg.kill_date)).toMatch(/CURRENT_DATE/);
  });

  test('the id and row-shape contract are unchanged: still targets rotation.id and unwraps to row[0]', async () => {
    const chain = createMockQueryChain([{ id: 7, kill_date: '2025-01-01' }]);
    db.update.mockReturnValueOnce(chain);

    const result = await killRotationInDB(7, '2025-01-01');

    expect(db.update).toHaveBeenCalledWith(rotation);
    expect(result).toEqual({ id: 7, kill_date: '2025-01-01' });
  });

  // killRotationInDB never touches the snapshot trio, so it can never hit
  // the compare-and-set guard — but if the row simply doesn't exist, the
  // unwrap must still degrade to `undefined` (the pre-BS#2113 contract),
  // not leak the new outcome object.
  test('unwraps a not_found outcome to undefined, matching the pre-existing contract', async () => {
    const chain = createMockQueryChain([]);
    db.update.mockReturnValueOnce(chain);

    const result = await killRotationInDB(999, '2025-01-01');

    expect(result).toBeUndefined();
  });
});
