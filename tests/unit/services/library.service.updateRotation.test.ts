/**
 * Unit tests for `updateRotation` + its `killRotationInDB` delegate
 * (BS#2113).
 *
 * `updateRotation` is the sole writer of the seven in-scope `rotation`
 * columns (`artist_name`, `album_title`, `record_label`, `add_date`,
 * `kill_date`, and — since BS#2410 — `format_id`, `label_id`) — both
 * `PATCH /library/rotation/:id` (the field-level editor) and
 * `PATCH /library/rotation` (`killRotation`, via
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

import {
  updateRotation,
  killRotationInDB,
  RotationCardBinMismatchError,
} from '../../../apps/backend/services/library.service';

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

  /**
   * BS#2410's two-list split, and the reason it is a split rather than a
   * repointing.
   *
   * `format_id` and `label_id` are pre-catalog fields like the text trio:
   * refused on a linked row, written through the same `album_id IS NULL`-
   * guarded transactional path. But they are NOT snapshot text. The tier-3
   * tracklist picker keys its cache on `(artist_name, album_title)`, so a
   * format-or-label-only edit has nothing stale to invalidate — and nulling
   * `tracklist_lookup_attempted_at` for it would re-arm the documented 22-second
   * LML cascade on every such edit, silently, visible only as latency.
   *
   * So `updateRotation` carries TWO booleans: `touchesPrecatalog` (trio + both
   * FKs) drives the transaction and the linked-row guard; `touchesSnapshot`
   * (the trio alone) drives the timestamp reset and the LRU eviction, and
   * nothing else. Pointing the single pre-#2410 flag at the wider list would
   * produce exactly the regression these tests exist to catch.
   */
  describe('pre-catalog FKs (format_id / label_id) — BS#2410 two-list split', () => {
    test.each([
      ['format_id', { format_id: 3 }],
      ['label_id', { label_id: 91 }],
      ['both FKs', { format_id: 3, label_id: 91 }],
    ])('a %s-only edit does NOT null tracklist_lookup_attempted_at', async (_label, updates) => {
      const chain = createMockQueryChain([{ id: 42, ...updates }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, updates);

      expect(chain.set).toHaveBeenCalledWith(updates);
      const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('tracklist_lookup_attempted_at');
    });

    test.each([
      ['format_id', { format_id: 3 }],
      ['label_id', { label_id: 91 }],
    ])('a %s-only edit still takes the transactional, album_id-guarded path', async (_label, updates) => {
      // The guard is the half that DOES follow the wider list: these columns
      // may only be set while the row is unlinked, and `rotation` is a live
      // ingest target, so the precondition rides in the UPDATE's own WHERE.
      const plainChain = createMockQueryChain([{ id: 42, kill_date: '2024-06-01' }]);
      db.update.mockReturnValueOnce(plainChain);
      await updateRotation(42, { kill_date: '2024-06-01' });
      const plainWhere = plainChain.where.mock.calls[0][0];

      db.transaction.mockClear();
      db.update.mockClear();
      const guardedChain = createMockQueryChain([{ id: 42, ...updates }]);
      db.update.mockReturnValueOnce(guardedChain);
      await updateRotation(42, updates);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(guardedChain.where.mock.calls[0][0])).not.toEqual(JSON.stringify(plainWhere));
    });

    test('a format_id edit on a linked row resolves linked_conflict, same as a snapshot edit', async () => {
      const updateChain = createMockQueryChain([]); // guarded UPDATE matches nothing
      db.update.mockReturnValueOnce(updateChain);
      mockSelectViaLimit([{ album_id: 7 }]);

      const outcome = await updateRotation(42, { format_id: 3 });

      expect(outcome).toEqual({ outcome: 'linked_conflict', albumId: 7 });
    });

    test('an FK edit bundled WITH snapshot text does null the marker — the trio is what arms it', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, { format_id: 3, artist_name: 'Juana Molina' });

      expect(chain.set).toHaveBeenCalledWith({
        format_id: 3,
        artist_name: 'Juana Molina',
        tracklist_lookup_attempted_at: null,
      });
    });

    test('an FK edit bundled with a date keeps the date and stays off the marker', async () => {
      const chain = createMockQueryChain([{ id: 42 }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, { label_id: 91, add_date: '2024-01-15' });

      expect(chain.set).toHaveBeenCalledWith({ label_id: 91, add_date: '2024-01-15' });
    });

    test('an explicit null clears either FK', async () => {
      const chain = createMockQueryChain([{ id: 42, format_id: null, label_id: null }]);
      db.update.mockReturnValueOnce(chain);

      await updateRotation(42, { format_id: null, label_id: null });

      expect(chain.set).toHaveBeenCalledWith({ format_id: null, label_id: null });
    });
  });

  describe('card_id (BS#2473) — the within-bin move', () => {
    test('an explicit null uncards the row without a card lookup', async () => {
      const chain = createMockQueryChain([{ id: 42, card_id: null }]);
      db.update.mockReturnValueOnce(chain);

      const outcome = await updateRotation(42, { card_id: null });

      expect(chain.set).toHaveBeenCalledWith({ card_id: null });
      expect(db.select).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(outcome).toEqual({ outcome: 'updated', rotation: { id: 42, card_id: null } });
    });

    test('a positive card_id validates against the ROW OWN bin (not a client-supplied one) via resolveRotationCardId', async () => {
      const binReadChain = createMockQueryChain();
      binReadChain.limit = jest.fn().mockResolvedValue([{ rotation_bin: 'M' }]); // the row's own bin
      db.select.mockReturnValueOnce(binReadChain);
      db.execute.mockResolvedValueOnce([{ bin: 'M' }]); // the named card lives in the same bin
      const updateChain = createMockQueryChain([{ id: 42, card_id: 5 }]);
      db.update.mockReturnValueOnce(updateChain);

      const outcome = await updateRotation(42, { card_id: 5 });

      // FOR UPDATE on the bin read: the tubafrenzy rotation webhook can
      // re-bin this exact row mid-request, and an unlocked read would let
      // the UPDATE file the row cross-bin behind a 200.
      expect(binReadChain.for).toHaveBeenCalledWith('update');
      expect(updateChain.set).toHaveBeenCalledWith({ card_id: 5 });
      expect(outcome).toEqual({ outcome: 'updated', rotation: { id: 42, card_id: 5 } });
    });

    test('a card filed in a different bin than the row rejects with RotationCardBinMismatchError', async () => {
      mockSelectViaLimit([{ rotation_bin: 'M' }]);
      db.execute.mockResolvedValueOnce([{ bin: 'H' }]); // wrong bin

      await expect(updateRotation(42, { card_id: 5 })).rejects.toBeInstanceOf(RotationCardBinMismatchError);
      expect(db.update).not.toHaveBeenCalled();
    });

    test('a dangling card_id 404s', async () => {
      mockSelectViaLimit([{ rotation_bin: 'M' }]);
      db.execute.mockResolvedValueOnce([]); // no such card

      await expect(updateRotation(42, { card_id: 999 })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('urls (BS#2473) — wholesale replacement', () => {
    test('a urls-only edit issues no rotation column UPDATE — locks and reads the row, then deletes and reinserts', async () => {
      const rowReadChain = createMockQueryChain();
      rowReadChain.limit = jest.fn().mockResolvedValue([{ id: 42, rotation_bin: 'M' }]);
      db.select.mockReturnValueOnce(rowReadChain);
      const deleteChain = createMockQueryChain();
      db.delete.mockReturnValueOnce(deleteChain);
      const insertChain = createMockQueryChain();
      db.insert.mockReturnValueOnce(insertChain);

      const outcome = await updateRotation(42, { urls: ['https://example.com/a'] });

      expect(db.update).not.toHaveBeenCalled();
      // FOR UPDATE — the row lock is what serializes two concurrent
      // wholesale replacements (without it the loser's reinsert 23505s on
      // the (rotation_id, position) unique index).
      expect(rowReadChain.for).toHaveBeenCalledWith('update');
      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith([{ rotation_id: 42, url: 'https://example.com/a', position: 0 }]);
      expect(outcome).toEqual({ outcome: 'updated', rotation: { id: 42, rotation_bin: 'M' } });
    });

    test('replacing with fewer urls than before still deletes the whole set first (no diffing)', async () => {
      const updateChain = createMockQueryChain([{ id: 42, kill_date: '2024-06-01' }]);
      db.update.mockReturnValueOnce(updateChain);
      const deleteChain = createMockQueryChain();
      db.delete.mockReturnValueOnce(deleteChain);
      const insertChain = createMockQueryChain();
      db.insert.mockReturnValueOnce(insertChain);

      await updateRotation(42, { kill_date: '2024-06-01', urls: ['https://example.com/only-one-left'] });

      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        { rotation_id: 42, url: 'https://example.com/only-one-left', position: 0 },
      ]);
    });

    test('urls: [] clears the set — delete runs, insert does not', async () => {
      mockSelectViaLimit([{ id: 42 }]);
      const deleteChain = createMockQueryChain();
      db.delete.mockReturnValueOnce(deleteChain);

      await updateRotation(42, { urls: [] });

      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
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
