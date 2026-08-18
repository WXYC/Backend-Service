/**
 * Unit tests for the BS#2109 uncatalogued-rotation surfaces:
 *
 *   - `getUncataloguedRotationFromDB` — read-side query for
 *     `GET /library/rotation/uncatalogued`. Asserts the `album_id IS NULL`
 *     predicate, the explicit column projection, the optional limit/offset
 *     window, and the absence of any `DISTINCT ON` (the query builder used
 *     here has no `selectDistinctOn` call at all, unlike
 *     `getRotationFromDB`'s raw-SQL `DISTINCT ON`).
 *   - `linkRotationToAlbum` — the `PATCH /rotation/:id/link` transaction:
 *     album-exists check, rotation-exists check, already-linked rejection,
 *     and (review round 3 finding 1) that it deliberately does NOT clear
 *     the snapshot columns — see the function's doc for why. Also (finding
 *     4) that the linked response is projected through the same
 *     `UNCATALOGUED_ROTATION_PROJECTION` the queue read uses, not a bare
 *     `.returning()`.
 *
 * Follows the established `db._chain` / `createMockQueryChain` override
 * conventions from `library.service.addToRotation.test.ts` and
 * `library.service.discogsRecheck.test.ts` — the mock chain only resolves
 * on `.returning()`/`.execute()` by default, so a plain `select().limit()`
 * read gets its terminal method's resolved value overridden per test.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain, rotation, library } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
  envInt: (_name: string, fallback: number) => fallback,
}));

import { getUncataloguedRotationFromDB, linkRotationToAlbum } from '../../../apps/backend/services/library.service';

describe('getUncataloguedRotationFromDB (BS#2109)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries rotation with an album_id IS NULL predicate, no COALESCE-0 and no DISTINCT ON', async () => {
    // The `0` sentinel the first draft also matched does not exist on
    // `rotation.album_id`: the column FKs `library.id`, a `serial` starting
    // at 1. `IS NULL` is also sargable against `album_id_idx`, which
    // `COALESCE(album_id, 0) = 0` was not.
    const rows = [
      { id: 10, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' },
      { id: 11, album_id: null, artist_name: 'Jockstrap', album_title: 'I Love You Jennifer B' },
    ];
    const selectChain = createMockQueryChain(rows);
    selectChain.orderBy = jest.fn().mockResolvedValue(rows);
    db.select.mockReturnValue(selectChain);

    const result = await getUncataloguedRotationFromDB();

    expect(result).toBe(rows);
    expect(selectChain.from).toHaveBeenCalledWith(rotation);
    // Exact-match, so a COALESCE-0 predicate (or any added clause) fails here
    // rather than needing a separate substring assertion against rendered SQL.
    expect(selectChain.where).toHaveBeenCalledWith({ isNull: rotation.album_id });
    // The query builder never calls selectDistinctOn — no dedup collapse.
    expect(db.selectDistinctOn).not.toHaveBeenCalled();
  });

  it('projects an explicit column list — no server-derived or external-ID columns', async () => {
    // A bare `select()` would publish legacy_rotation_id,
    // legacy_library_release_id, discogs_release_id,
    // discogs_release_id_source, lml_identity_id, the two attempt-at markers,
    // and every column a future migration adds — none of which
    // `getRotationFromDB` publishes, and WXYC/wxyc-shared#354 would
    // transcribe the leak into a published contract.
    const selectChain = createMockQueryChain([]);
    selectChain.orderBy = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    await getUncataloguedRotationFromDB();

    const projection = db.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(projection).toBeDefined();
    expect(Object.keys(projection ?? {}).sort()).toEqual([
      'add_date',
      'album_id',
      'album_title',
      'artist_name',
      'id',
      'kill_date',
      'record_label',
      'rotation_bin',
    ]);
  });

  it('applies limit/offset only when supplied, leaving the queue unbounded by default', async () => {
    const unboundedChain = createMockQueryChain([]);
    unboundedChain.orderBy = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(unboundedChain);

    await getUncataloguedRotationFromDB();
    expect(unboundedChain.limit).not.toHaveBeenCalled();
    expect(unboundedChain.offset).not.toHaveBeenCalled();

    const pagedChain = createMockQueryChain([]);
    pagedChain.orderBy = jest.fn().mockReturnValue(pagedChain);
    pagedChain.limit = jest.fn().mockReturnValue(pagedChain);
    pagedChain.offset = jest.fn().mockResolvedValue([]);
    db.select.mockReturnValue(pagedChain);

    await getUncataloguedRotationFromDB({ limit: 50, offset: 100 });
    expect(pagedChain.limit).toHaveBeenCalledWith(50);
    expect(pagedChain.offset).toHaveBeenCalledWith(100);
  });

  it('surfaces two same-artist/same-title unlinked rows both (no collapse)', async () => {
    // Pins the acceptance criterion directly: two distinct physical promos
    // sharing (artist, title) must both appear, unlike getRotationFromDB's
    // DISTINCT ON dropdown collapse (#862).
    const rows = [
      { id: 20, album_id: null, artist_name: 'Duplicate Artist', album_title: 'Duplicate Title' },
      { id: 21, album_id: null, artist_name: 'Duplicate Artist', album_title: 'Duplicate Title' },
    ];
    const selectChain = createMockQueryChain(rows);
    selectChain.orderBy = jest.fn().mockResolvedValue(rows);
    db.select.mockReturnValue(selectChain);

    const result = await getUncataloguedRotationFromDB();

    expect(result).toHaveLength(2);
    expect(result.map((r) => (r as { id: number }).id).sort()).toEqual([20, 21]);
  });
});

describe('linkRotationToAlbum (BS#2109)', () => {
  const ROTATION_ID = 42;
  const ALBUM_ID = 5;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('links: sets album_id only — does NOT clear artist_name/album_title/record_label (review round 3 finding 1)', async () => {
    const albumChain = createMockQueryChain();
    albumChain.limit = jest.fn().mockResolvedValue([{ id: ALBUM_ID }]);

    const rotationSelectChain = createMockQueryChain();
    rotationSelectChain.limit = jest.fn().mockResolvedValue([{ album_id: null }]);

    // The snapshot survives the link untouched — clearing it stranded the
    // tracklist picker's tier-3 self-heal (see linkRotationToAlbum's doc).
    const updatedRow = {
      id: ROTATION_ID,
      album_id: ALBUM_ID,
      rotation_bin: 'L',
      add_date: '2026-01-01',
      kill_date: null,
      artist_name: 'Preserved Artist',
      album_title: 'Preserved Album',
      record_label: 'Preserved Label',
    };
    const updateChain = createMockQueryChain([updatedRow]);

    db.select.mockReturnValueOnce(albumChain).mockReturnValueOnce(rotationSelectChain);
    db.update.mockReturnValue(updateChain);

    const result = await linkRotationToAlbum(ROTATION_ID, ALBUM_ID);

    expect(result).toEqual({ outcome: 'linked', rotation: updatedRow });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(albumChain.from).toHaveBeenCalledWith(library);
    // Only album_id moves — no artist_name/album_title/record_label keys.
    expect(updateChain.set).toHaveBeenCalledWith({ album_id: ALBUM_ID });
    // Review round 3 finding 4: the response is projected through the same
    // explicit column list `getUncataloguedRotationFromDB` uses, not a bare
    // `.returning()` — asserted against the call's own args so a future
    // migration-added column can't silently widen this response too.
    expect(updateChain.returning).toHaveBeenCalledWith({
      id: rotation.id,
      album_id: rotation.album_id,
      rotation_bin: rotation.rotation_bin,
      add_date: rotation.add_date,
      kill_date: rotation.kill_date,
      artist_name: rotation.artist_name,
      album_title: rotation.album_title,
      record_label: rotation.record_label,
    });
    // The UPDATE's own WHERE re-guards album_id IS NULL, not just the earlier
    // SELECT. drizzle-orm is automocked project-wide (`tests/__mocks__/
    // drizzle-orm.ts`), so the predicate is a plain object, not SQL text —
    // assert it whole, which also pins the `eq(rotation.id, …)` half that a
    // substring match would silently ignore.
    expect(updateChain.where).toHaveBeenCalledWith({
      and: [{ eq: [rotation.id, ROTATION_ID] }, { isNull: rotation.album_id }],
    });
  });

  it('rejects double-linking when the rotation row already has an album_id', async () => {
    const albumChain = createMockQueryChain();
    albumChain.limit = jest.fn().mockResolvedValue([{ id: ALBUM_ID }]);

    const rotationSelectChain = createMockQueryChain();
    rotationSelectChain.limit = jest.fn().mockResolvedValue([{ album_id: 999 }]);

    db.select.mockReturnValueOnce(albumChain).mockReturnValueOnce(rotationSelectChain);

    const result = await linkRotationToAlbum(ROTATION_ID, ALBUM_ID);

    expect(result).toEqual({ outcome: 'already_linked' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns rotation_not_found when the rotation row does not exist', async () => {
    const albumChain = createMockQueryChain();
    albumChain.limit = jest.fn().mockResolvedValue([{ id: ALBUM_ID }]);

    const rotationSelectChain = createMockQueryChain();
    rotationSelectChain.limit = jest.fn().mockResolvedValue([]);

    db.select.mockReturnValueOnce(albumChain).mockReturnValueOnce(rotationSelectChain);

    const result = await linkRotationToAlbum(ROTATION_ID, ALBUM_ID);

    expect(result).toEqual({ outcome: 'rotation_not_found' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns album_not_found when the album does not exist, without touching rotation', async () => {
    const albumChain = createMockQueryChain();
    albumChain.limit = jest.fn().mockResolvedValue([]);

    db.select.mockReturnValueOnce(albumChain);

    const result = await linkRotationToAlbum(ROTATION_ID, 999999);

    expect(result).toEqual({ outcome: 'album_not_found' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns already_linked when the guarded UPDATE affects no row (race between check and write)', async () => {
    const albumChain = createMockQueryChain();
    albumChain.limit = jest.fn().mockResolvedValue([{ id: ALBUM_ID }]);

    const rotationSelectChain = createMockQueryChain();
    rotationSelectChain.limit = jest.fn().mockResolvedValue([{ album_id: null }]);

    const updateChain = createMockQueryChain([]);

    db.select.mockReturnValueOnce(albumChain).mockReturnValueOnce(rotationSelectChain);
    db.update.mockReturnValue(updateChain);

    const result = await linkRotationToAlbum(ROTATION_ID, ALBUM_ID);

    expect(result).toEqual({ outcome: 'already_linked' });
  });
});
