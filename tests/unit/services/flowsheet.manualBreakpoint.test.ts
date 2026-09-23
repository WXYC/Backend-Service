/**
 * Unit tests for `addHourlyBreakpoint` — the DJ-pressed hourly breakpoint.
 *
 * BS#2569 added a partial unique index on `(show_id, radio_hour)` for
 * breakpoint rows. The manual press was the one writer that did not tolerate
 * it: `addEntry` stamps `nearestStationHour(now)` and used to hand the row to
 * `addTrack`, a plain insert with no conflict clause.
 *
 * The two clocks disagree BY CONSTRUCTION, which is what makes the collision
 * ordinary rather than exotic: `generateMissingBreakpoints` FLOORS, and
 * `nearestStationHour` ROUNDS. So a track logged at 2:05 PM makes the fill
 * write the 2:00 PM marker, and a DJ pressing Breakpoint any time before
 * 2:30 PM rounds onto that same hour. Before this change that raised 23505,
 * and because a postgres error carries no `status`, `errorHandler` answered a
 * bare 500 — in front of an on-air DJ, for an hour that was already marked.
 *
 * The correct outcome is idempotence, not an error: the DJ asked for the hour
 * to be marked and it is. So the insert tolerates the conflict and the
 * existing marker is returned, with `created: false` so the caller can respect
 * the BS#2621 rule of broadcasting only for rows that actually committed.
 */
import { db, createMockQueryChain } from '../../mocks/database.mock';

import { addHourlyBreakpoint } from '../../../apps/backend/services/flowsheet.service';

const SHOW_ID = 7;
const HOUR = new Date('2026-09-23T14:00:00.000Z');

/**
 * `nextPlayOrder` awaits the builder straight off `.where()` with no terminal
 * `.limit()`, so that is the method its chain has to resolve.
 */
const playOrderChain = (max = 0) => {
  const chain = createMockQueryChain();
  chain.where.mockResolvedValue([{ max }]);
  return chain;
};

/** The existing-marker lookup resolves on its terminal `.limit()`. */
const existingChain = (rows: unknown[]) => {
  const chain = createMockQueryChain();
  chain.limit.mockResolvedValue(rows);
  return chain;
};

const entry = () =>
  ({
    artist_name: '',
    album_title: '',
    track_title: '',
    entry_type: 'breakpoint' as const,
    message: '2:00 PM Breakpoint',
    radio_hour: HOUR,
    show_id: SHOW_ID,
    dj_name: 'DJ Stardust',
  }) as any;

describe('addHourlyBreakpoint (BS#2569 follow-up)', () => {
  it('reports the row it committed when the hour was not yet marked', async () => {
    db.select.mockReturnValueOnce(playOrderChain(4));
    const insertChain = createMockQueryChain([{ id: 99, entry_type: 'breakpoint', radio_hour: HOUR }]);
    db.insert.mockReturnValueOnce(insertChain);

    await expect(addHourlyBreakpoint(entry())).resolves.toEqual({
      entry: { id: 99, entry_type: 'breakpoint', radio_hour: HOUR },
      created: true,
    });
    // play_order continues the show's sequence rather than restarting.
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ play_order: 5 }));
  });

  it('tolerates the collision instead of raising, and returns the marker that already stands', async () => {
    // The regression this exists to prevent: before the conflict clause this
    // threw 23505, which reached the DJ as a bare 500.
    db.select.mockReturnValueOnce(playOrderChain(4));
    db.insert.mockReturnValueOnce(createMockQueryChain([])); // suppressed by ON CONFLICT
    const existing = { id: 42, entry_type: 'breakpoint', radio_hour: HOUR };
    db.select.mockReturnValueOnce(existingChain([existing]));

    await expect(addHourlyBreakpoint(entry())).resolves.toEqual({ entry: existing, created: false });
  });

  it('asks the database to tolerate the conflict rather than pre-checking for one', async () => {
    // A SELECT-then-INSERT would still lose the race it is meant to close;
    // only the conflict clause is atomic.
    db.select.mockReturnValueOnce(playOrderChain(0));
    const insertChain = createMockQueryChain([{ id: 1 }]);
    db.insert.mockReturnValueOnce(insertChain);

    await addHourlyBreakpoint(entry());

    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    // One read (nextPlayOrder) on the happy path — no existence pre-check.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('raises rather than returning an undefined entry when the winning row is gone', async () => {
    // Only reachable if the marker that won the conflict is deleted between
    // the INSERT and the lookup. Returning `undefined` typed as an entry
    // would surface further downstream and much less legibly.
    db.select.mockReturnValueOnce(playOrderChain(0));
    db.insert.mockReturnValueOnce(createMockQueryChain([]));
    db.select.mockReturnValueOnce(existingChain([]));

    await expect(addHourlyBreakpoint(entry())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses an entry with no show_id', async () => {
    await expect(addHourlyBreakpoint({ ...entry(), show_id: null })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
