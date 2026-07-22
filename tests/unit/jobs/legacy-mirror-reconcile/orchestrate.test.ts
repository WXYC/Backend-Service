/**
 * Unit tests for the legacy-mirror-reconcile orchestrator (BS#1707).
 *
 * Drives `runReconcile` with fully-faked `ReconcilePorts` so the sequencing
 * invariants hardened over five review rounds are pinned without a live DB or
 * tubafrenzy:
 *   - the two sweeps' all-or-nothing partitioning (create vs entry vs partial),
 *   - ordering: the show is created before any of its entries,
 *   - idempotency: an already-healed selection is a no-op,
 *   - the per-DJ flag gate short-circuits both sweeps,
 *   - rotation-match parity is threaded into the entry mapper,
 *   - signoff fires only for finalized shows (and is deferred on entry failure),
 *   - partial-mirror shows are reported (log + Sentry warning), never appended,
 *   - the cooperative pause runs before each sweep and between shows,
 *   - the detection signal escalates above the alert threshold.
 *
 * The all-or-nothing SELECT SQL itself (the NOT EXISTS predicates + window/
 * settle bounds) is a hand-written SQL twin exercised against a real Postgres
 * in `tests/integration/legacy-mirror-reconcile.spec.js`.
 */

import { jest } from '@jest/globals';

import {
  runReconcile,
  type PartialShow,
  type ReconcileOptions,
  type ReconcilePorts,
} from '../../../../jobs/legacy-mirror-reconcile/orchestrate';
import type { FSEntry, Show, User } from '@wxyc/database';

const OPTIONS: ReconcileOptions = { windowHours: 48, settleMinutes: 15, alertThreshold: 0 };

const makeShow = (over: Partial<Show> = {}): Show => ({
  id: 1,
  primary_dj_id: 'dj-1',
  legacy_show_id: null,
  end_time: null,
  start_time: new Date('2026-07-18T12:00:00Z'),
  show_name: null,
  specialty_id: null,
  legacy_dj_name: null,
  legacy_dj_id: null,
  dj_name_override: null,
  ...over,
});

const makeEntry = (over: Partial<FSEntry> = {}): FSEntry =>
  ({
    id: 1,
    show_id: 1,
    legacy_entry_id: null,
    entry_type: 'track',
    play_order: 1,
    artist_name: 'Stereolab',
    album_title: 'Dots and Loops',
    track_title: 'Miss Modular',
    record_label: 'Duophonic',
    album_id: null,
    rotation_id: null,
    request_flag: false,
    segue: false,
    message: null,
    add_time: new Date('2026-07-18T12:05:00Z'),
    ...over,
  }) as unknown as FSEntry;

const makeDj = (over: Partial<User> = {}): User =>
  ({ id: 'dj-1', name: 'Real Name', realName: 'Real Name', djName: 'DJ Handle', ...over }) as unknown as User;

/** jest.fn returning a resolved promise — a non-async wrapper so the fakes
 * don't trip `@typescript-eslint/require-await` (bare async arrow, no await). */
const mockAsync = <T>(value: T) => jest.fn((..._args: unknown[]): Promise<T> => Promise.resolve(value));

/** Build a fully-faked port set; override individual members per test. */
const makePorts = (over: Partial<ReconcilePorts> = {}) => {
  const ports = {
    selectShowsToCreate: mockAsync([] as Show[]),
    selectEntrySweepShows: mockAsync([] as Show[]),
    selectPartialShows: mockAsync([] as PartialShow[]),
    selectDj: mockAsync(makeDj()),
    selectOrphanEntries: mockAsync([] as FSEntry[]),
    persistLegacyShowId: mockAsync(undefined),
    persistLegacyEntryId: mockAsync(undefined),
    mirrorCreateShow: mockAsync<number | null>(9001),
    mirrorCreateEntry: mockAsync<number | null>(5001),
    mirrorSignoffShow: mockAsync(undefined),
    mapShowToTubafrenzy: jest.fn((show: Show, _dj: User) => ({ show_id: show.id })),
    mapEntryToTubafrenzy: jest.fn((entry: FSEntry, radioShowID: number | null, isRotationMatch: boolean) => ({
      entry_id: entry.id,
      radioShowID,
      isRotationMatch,
    })),
    isActiveRotationMatch: mockAsync(false),
    isMirrorEnabledForDj: mockAsync(true),
    awaitQuiet: mockAsync(undefined),
    log: jest.fn(),
    captureWarning: jest.fn(),
    ...over,
  };
  return ports as unknown as ReconcilePorts & typeof ports;
};

describe('runReconcile — show-create sweep', () => {
  it('creates a tubafrenzy show for an all-or-nothing candidate and persists legacy_show_id', async () => {
    const show = makeShow({ id: 42, primary_dj_id: 'dj-42' });
    const ports = makePorts({ selectShowsToCreate: mockAsync([show]) });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.selectDj).toHaveBeenCalledWith('dj-42');
    expect(ports.mapShowToTubafrenzy).toHaveBeenCalledWith(show, expect.objectContaining({ id: 'dj-1' }));
    expect(ports.mirrorCreateShow).toHaveBeenCalledTimes(1);
    expect(ports.persistLegacyShowId).toHaveBeenCalledWith(42, 9001);
    expect(totals.candidate_shows).toBe(1);
    expect(totals.shows_created).toBe(1);
  });

  it('does NOT create a show when the DJ flag is OFF (retry next run)', async () => {
    const show = makeShow({ id: 7, primary_dj_id: 'dj-off' });
    const ports = makePorts({
      selectShowsToCreate: mockAsync([show]),
      isMirrorEnabledForDj: mockAsync(false),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorCreateShow).not.toHaveBeenCalled();
    expect(ports.persistLegacyShowId).not.toHaveBeenCalled();
    expect(totals.skipped_flag_off).toBe(1);
    expect(totals.shows_created).toBe(0);
  });

  it('leaves legacy_show_id NULL (no persist) when the tubafrenzy POST fails', async () => {
    const show = makeShow({ id: 9 });
    const ports = makePorts({
      selectShowsToCreate: mockAsync([show]),
      mirrorCreateShow: mockAsync(null),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.persistLegacyShowId).not.toHaveBeenCalled();
    expect(totals.show_create_failures).toBe(1);
    expect(totals.shows_created).toBe(0);
  });

  it('skips a candidate whose primary_dj_id has no auth_user row', async () => {
    const show = makeShow({ id: 5, primary_dj_id: 'ghost' });
    const ports = makePorts({
      selectShowsToCreate: mockAsync([show]),
      selectDj: mockAsync(null),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorCreateShow).not.toHaveBeenCalled();
    expect(totals.skipped_no_dj).toBe(1);
  });
});

describe('runReconcile — entry + signoff sweep', () => {
  it('drives every NULL-legacy entry in order and persists each legacy_entry_id', async () => {
    const show = makeShow({ id: 3, legacy_show_id: 8080, end_time: null });
    const entries = [makeEntry({ id: 11, play_order: 1 }), makeEntry({ id: 12, play_order: 2 })];
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync(entries),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorCreateEntry).toHaveBeenCalledTimes(2);
    expect(ports.persistLegacyEntryId).toHaveBeenNthCalledWith(1, 11, 5001);
    expect(ports.persistLegacyEntryId).toHaveBeenNthCalledWith(2, 12, 5001);
    expect(totals.orphan_entries_found).toBe(2);
    expect(totals.entries_created).toBe(2);
    // Not finalized → no signoff.
    expect(ports.mirrorSignoffShow).not.toHaveBeenCalled();
  });

  it('passes the rotation-match verdict into the entry mapper (badge parity)', async () => {
    const show = makeShow({ id: 3, legacy_show_id: 8080 });
    const entry = makeEntry({ id: 21 });
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync([entry]),
      isActiveRotationMatch: mockAsync(true),
    });

    await runReconcile(ports, OPTIONS);

    expect(ports.isActiveRotationMatch).toHaveBeenCalledWith(entry);
    expect(ports.mapEntryToTubafrenzy).toHaveBeenCalledWith(entry, 8080, true);
  });

  it('signs off a finalized all-or-nothing show after its entries', async () => {
    const end = new Date('2026-07-18T14:00:00Z');
    const show = makeShow({ id: 3, legacy_show_id: 8080, end_time: end });
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync([makeEntry({ id: 31 })]),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorSignoffShow).toHaveBeenCalledWith(8080, end.getTime());
    expect(totals.signoffs).toBe(1);
  });

  it('defers signoff when an entry POST failed (show becomes partial next run)', async () => {
    const show = makeShow({ id: 3, legacy_show_id: 8080, end_time: new Date('2026-07-18T14:00:00Z') });
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync([makeEntry({ id: 41 }), makeEntry({ id: 42 })]),
      mirrorCreateEntry: jest
        .fn<(body: Record<string, unknown>) => Promise<number | null>>()
        .mockResolvedValueOnce(5001)
        .mockResolvedValueOnce(null),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorSignoffShow).not.toHaveBeenCalled();
    expect(totals.entries_created).toBe(1);
    expect(totals.entries_failed).toBe(1);
    expect(totals.signoffs).toBe(0);
  });

  it('STOPS at the first entry failure and does not POST later entries (contiguous NULL suffix)', async () => {
    // 3 entries in play_order; the SECOND POST fails. The third must NOT be
    // attempted — driving it would append out of order past the gap and turn
    // the show PARTIAL (un-healable). The remaining NULLs stay a contiguous,
    // in-order tail that Sweep 2 re-drives next run.
    const show = makeShow({ id: 3, legacy_show_id: 8080, end_time: new Date('2026-07-18T14:00:00Z') });
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync([
        makeEntry({ id: 51, play_order: 1 }),
        makeEntry({ id: 52, play_order: 2 }),
        makeEntry({ id: 53, play_order: 3 }),
      ]),
      mirrorCreateEntry: jest
        .fn<(body: Record<string, unknown>) => Promise<number | null>>()
        .mockResolvedValueOnce(5001)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(5003),
    });

    const totals = await runReconcile(ports, OPTIONS);

    // Only two POSTs: the success and the failure. The third is never tried.
    expect(ports.mirrorCreateEntry).toHaveBeenCalledTimes(2);
    expect(ports.persistLegacyEntryId).toHaveBeenCalledTimes(1);
    expect(ports.persistLegacyEntryId).toHaveBeenCalledWith(51, 5001);
    expect(totals.entries_created).toBe(1);
    expect(totals.entries_failed).toBe(1);
    // Failure present → signoff deferred (show becomes partial/heals next run).
    expect(ports.mirrorSignoffShow).not.toHaveBeenCalled();
    expect(totals.signoffs).toBe(0);
  });

  it('does NOT drive entries when the DJ flag is OFF', async () => {
    const show = makeShow({ id: 3, legacy_show_id: 8080, end_time: new Date() });
    const ports = makePorts({
      selectEntrySweepShows: mockAsync([show]),
      selectOrphanEntries: mockAsync([makeEntry()]),
      isMirrorEnabledForDj: mockAsync(false),
    });

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.selectOrphanEntries).not.toHaveBeenCalled();
    expect(ports.mirrorCreateEntry).not.toHaveBeenCalled();
    expect(ports.mirrorSignoffShow).not.toHaveBeenCalled();
    expect(totals.skipped_flag_off).toBe(1);
  });
});

describe('runReconcile — ordering (show before its entries)', () => {
  it('creates the show before any entry is mirrored', async () => {
    const show = makeShow({ id: 1, primary_dj_id: 'dj-1', legacy_show_id: null });
    // After sweep 1 persists the show, sweep 2 re-queries and sees it with a
    // legacy_show_id — modelled here by the entry-sweep fake returning the
    // now-created show.
    const createdShow = makeShow({ id: 1, legacy_show_id: 9001 });
    const ports = makePorts({
      selectShowsToCreate: mockAsync([show]),
      selectEntrySweepShows: mockAsync([createdShow]),
      selectOrphanEntries: mockAsync([makeEntry({ id: 100, show_id: 1 })]),
    });

    await runReconcile(ports, OPTIONS);

    const createOrder = ports.mirrorCreateShow.mock.invocationCallOrder[0];
    const entryOrder = ports.mirrorCreateEntry.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(entryOrder);
  });
});

describe('runReconcile — partial-mirror detection', () => {
  it('reports partial-mirror shows and never appends to them', async () => {
    const partials: PartialShow[] = [
      { show_id: 1949437, orphan_entry_count: 4 },
      { show_id: 5, orphan_entry_count: 1 },
    ];
    const ports = makePorts({ selectPartialShows: mockAsync(partials) });

    const totals = await runReconcile(ports, OPTIONS);

    expect(totals.partial_shows).toBe(2);
    expect(ports.mirrorCreateEntry).not.toHaveBeenCalled();
    expect(ports.captureWarning).toHaveBeenCalledWith(
      expect.stringContaining('partially-mirrored'),
      'partial_mirror',
      expect.objectContaining({ show_id: 1949437, orphan_entry_count: 4 })
    );
    expect(ports.captureWarning).toHaveBeenCalledWith(
      expect.stringContaining('partially-mirrored'),
      'partial_mirror',
      expect.objectContaining({ show_id: 5 })
    );
  });
});

describe('runReconcile — idempotency', () => {
  it('is a no-op when all selections are empty (nothing left to heal)', async () => {
    const ports = makePorts();

    const totals = await runReconcile(ports, OPTIONS);

    expect(ports.mirrorCreateShow).not.toHaveBeenCalled();
    expect(ports.mirrorCreateEntry).not.toHaveBeenCalled();
    expect(ports.mirrorSignoffShow).not.toHaveBeenCalled();
    expect(ports.persistLegacyShowId).not.toHaveBeenCalled();
    expect(ports.persistLegacyEntryId).not.toHaveBeenCalled();
    expect(totals.candidate_shows).toBe(0);
    expect(totals.entry_sweep_shows).toBe(0);
    expect(totals.partial_shows).toBe(0);
    // Idle run below threshold does not escalate.
    expect(ports.captureWarning).not.toHaveBeenCalled();
  });
});

describe('runReconcile — cooperative pause', () => {
  it('pauses before each sweep and between shows', async () => {
    const createShow = makeShow({ id: 1 });
    const entryShow = makeShow({ id: 2, legacy_show_id: 8080 });
    const ports = makePorts({
      selectShowsToCreate: mockAsync([createShow]),
      selectEntrySweepShows: mockAsync([entryShow]),
      selectOrphanEntries: mockAsync([makeEntry({ id: 9, show_id: 2 })]),
    });

    await runReconcile(ports, OPTIONS);

    // sweep-1 pre-sweep + one per create-candidate + sweep-2 pre-sweep + one
    // per entry-sweep show = 4.
    expect(ports.awaitQuiet).toHaveBeenCalledTimes(4);
  });
});

describe('runReconcile — detection signal', () => {
  it('always logs the detection counts', async () => {
    const ports = makePorts();
    await runReconcile(ports, OPTIONS);
    expect(ports.log).toHaveBeenCalledWith('info', 'detection', expect.any(String), expect.any(Object));
  });

  it('escalates to a Sentry warning above the alert threshold', async () => {
    const ports = makePorts({ selectShowsToCreate: mockAsync([makeShow({ id: 1 })]) });
    await runReconcile(ports, { ...OPTIONS, alertThreshold: 0 });
    expect(ports.captureWarning).toHaveBeenCalledWith(
      expect.stringContaining('orphaned tubafrenzy mirror rows detected'),
      'detection',
      expect.objectContaining({ orphan_shows: 1 })
    );
  });

  it('does NOT escalate when the orphan total is at or below the threshold', async () => {
    const ports = makePorts({ selectShowsToCreate: mockAsync([makeShow({ id: 1 })]) });
    await runReconcile(ports, { ...OPTIONS, alertThreshold: 5 });
    // No detection-level warning (partial_mirror warnings would have a
    // different step, but there are no partials here either).
    expect(ports.captureWarning).not.toHaveBeenCalled();
  });
});
