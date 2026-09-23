/**
 * Unit tests for the server-side auto-create-hour-breakpoints wiring (BS#2516):
 * `getBreakpointWatermark` (where the fill loop starts from) and
 * `fillMissingHourlyBreakpoints` (the loop itself, called once per
 * `POST /flowsheet`). The cap, the DST handling, and the message shape are
 * covered purely at `apps/backend/utils/breakpoint-generator.ts`; these
 * tests cover only the DB-facing wiring around that pure logic.
 */
import { db, createMockQueryChain } from '../../mocks/database.mock';

const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

import { getBreakpointWatermark, fillMissingHourlyBreakpoints } from '../../../apps/backend/services/flowsheet.service';
import { MAX_AUTO_BREAKPOINTS } from '../../../apps/backend/utils/breakpoint-generator';

/**
 * Register the next `db.select()` as the `getBreakpointWatermark` query and
 * hand its chain back, so each test states only the row shape it cares about.
 * Left un-resolved, the chain yields no rows — the "show has no breakpoint
 * yet" case.
 */
const stubWatermarkSelect = () => {
  const chain = createMockQueryChain();
  db.select.mockReturnValueOnce(chain);
  return chain;
};

/** The row array handed to the fill's single `db.insert(...).values([...])`. */
const insertedRows = (chain: ReturnType<typeof createMockQueryChain>) =>
  chain.values.mock.calls[0]?.[0] as Record<string, unknown>[];

/**
 * An insert chain reporting `n` rows actually committed. The fill counts what
 * `RETURNING` hands back rather than what it attempted, so a row dropped by
 * `ON CONFLICT DO NOTHING` is never broadcast as a marker that landed.
 */
const insertChainLanding = (n: number) => createMockQueryChain(Array.from({ length: n }, (_, i) => ({ id: i + 1 })));

/**
 * "The fill decided there was nothing to write" — as distinct from "the fill
 * threw and swallowed it", which also leaves `db.insert` untouched. Every
 * no-write case has to assert both halves, or removing a guard makes the test
 * pass for the wrong reason: the missing row simply crashes `nextPlayOrder`
 * against an unstubbed chain and the `catch` hides it.
 */
const expectQuietNoOp = () => {
  expect(db.insert).not.toHaveBeenCalled();
  expect(mockCaptureException).not.toHaveBeenCalled();
};

describe('getBreakpointWatermark', () => {
  it('resolves to the last breakpoint radio_hour when one is set', async () => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T23:00:00.000Z'), add_time: new Date() },
    ]);

    const watermark = await getBreakpointWatermark({ id: 1, start_time: new Date('2026-09-16T22:00:00.000Z') } as any);

    expect(watermark).toEqual(new Date('2026-09-16T23:00:00.000Z'));
  });

  // A breakpoint with no `radio_hour` — the manual dj-site control (which
  // sends only `message` + `entry_type`) and every row predating the BS#1449
  // backfill — is still the show's last marker, so the watermark must not skip
  // past it. It must also not be FLOORED: schema.ts calls flooring a
  // breakpoint's `add_time` across the boundary the defect `radio_hour` exists
  // to fix, because the row is logged either side of the hour it names. The
  // label on such a row comes from dj-site's `closestStationHour`, which
  // ROUNDS, so the watermark has to round the same way or the hour the row
  // already marks gets generated a second time.
  it.each([
    ['logged before the hour it marks', '2026-09-16T22:58:00.000Z'],
    ['logged after the hour it marks', '2026-09-16T23:01:00.000Z'],
    ['logged well before the hour it marks (rounds up past :30)', '2026-09-16T22:35:00.000Z'],
  ])('rounds the last breakpoint add_time to the hour it marks when radio_hour is unset (%s)', async (_label, iso) => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([{ radio_hour: null, add_time: new Date(iso) }]);

    const watermark = await getBreakpointWatermark({ id: 1, start_time: new Date('2026-09-16T21:00:00.000Z') } as any);

    expect(watermark).toEqual(new Date('2026-09-16T23:00:00.000Z'));
  });

  it('falls back to the show start_time, unrounded, when it has no breakpoint yet', async () => {
    stubWatermarkSelect();

    // 23:03Z would round UP to 2026-09-17T00:00Z if it were treated as a
    // marker instant. It isn't one — it names no hour — so it must survive
    // verbatim, or a show that began at 6:55 PM would never get its 7:00 PM
    // marker.
    const start_time = new Date('2026-09-16T23:03:00.000Z');
    const watermark = await getBreakpointWatermark({ id: 1, start_time } as any);

    expect(watermark).toEqual(start_time);
  });
});

describe('fillMissingHourlyBreakpoints', () => {
  const show = { id: 7, start_time: new Date('2026-09-16T20:00:00.000Z') } as any;

  // `addTrack`'s internal `nextPlayOrder(showId)` awaits the builder straight
  // off `.where()` with no terminal `.limit()`, so that's the method its chain
  // has to resolve.
  const playOrderChain = (max = 0) => {
    const chain = createMockQueryChain();
    chain.where.mockResolvedValue([{ max }]);
    return chain;
  };

  // `clearMocks` wipes recorded calls but not implementations, so the
  // multi-insert cases below (which need a standing `mockReturnValue`, not a
  // queue of `…Once`s) would otherwise leak their stubs into later tests.
  beforeEach(() => {
    db.select.mockReturnValue(db._chain);
    db.insert.mockReturnValue(db._chain);
  });

  it('inserts nothing when the show is already caught up to the current hour', async () => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T23:00:00.000Z'), add_time: null },
    ]);

    db.select.mockReturnValue(playOrderChain());
    db.insert.mockReturnValue(createMockQueryChain());

    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(0);

    expectQuietNoOp();
  });

  it('does not re-create an hour a manually added breakpoint already marks', async () => {
    // The dj-site control sends `{ message, entry_type }` only, so the row it
    // writes has a NULL radio_hour and an add_time a few minutes either side of
    // the hour its own label names. Pressing it at 6:58 PM writes
    // "7:00 PM Breakpoint"; the 7:05 PM track-add below must see that hour as
    // already marked rather than generate a second 7:00 PM row.
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: null, add_time: new Date('2026-09-16T22:58:00.000Z') },
    ]);

    db.select.mockReturnValue(playOrderChain());
    db.insert.mockReturnValue(createMockQueryChain());

    await fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') });

    expectQuietNoOp();
  });

  it('inserts exactly one breakpoint for a show missing one hour', async () => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T22:00:00.000Z'), add_time: null },
    ]);
    db.select.mockReturnValueOnce(playOrderChain(4));
    const insertChain = insertChainLanding(1);
    db.insert.mockReturnValueOnce(insertChain);

    // 23:05Z floors to 23:00Z. The resolved count is the number of rows the
    // single INSERT landed — it feeds addEntry's live-fs refetch (BS#2621).
    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(1);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertedRows(insertChain)).toEqual([
      expect.objectContaining({
        entry_type: 'breakpoint',
        message: '7:00 PM Breakpoint', // 2026-09-16T23:00:00Z is 7:00 PM EDT
        radio_hour: new Date('2026-09-16T23:00:00.000Z'),
        show_id: show.id,
        dj_name: 'DJ Stardust',
        play_order: 5,
      }),
    ]);
  });

  // `callerMarksCurrentHour` — the request is itself adding a breakpoint, so
  // the fill must stop below the hour that entry claims or the DJ's one click
  // produces two identical markers.
  describe('when the caller is itself marking the hour', () => {
    it('does not generate the hour the caller is about to write', async () => {
      stubWatermarkSelect().limit.mockResolvedValueOnce([
        { radio_hour: new Date('2026-09-16T22:00:00.000Z'), add_time: null },
      ]);

      db.select.mockReturnValue(playOrderChain());
      db.insert.mockReturnValue(createMockQueryChain());

      // 7:05 PM EDT: the caller's own row will be labelled "7:00 PM", so 7:00
      // is theirs to write and the fill has nothing left to do. Without the
      // ceiling this generates a second 7:00 PM marker and inserts it.
      await fillMissingHourlyBreakpoints(show, 'DJ Stardust', {
        now: new Date('2026-09-16T23:05:00.000Z'),
        callerMarksCurrentHour: true,
      });

      expectQuietNoOp();
    });

    it('still fills the earlier hours the caller is not claiming', async () => {
      stubWatermarkSelect().limit.mockResolvedValueOnce([
        { radio_hour: new Date('2026-09-16T23:00:00.000Z'), add_time: null },
      ]);
      db.select.mockReturnValue(playOrderChain());
      const insertChain = createMockQueryChain();
      db.insert.mockReturnValue(insertChain);

      // 8:40 PM EDT rounds UP to 9:00 PM, so the caller's row claims 9:00 and
      // the 8:00 PM hour it skipped past is still the fill's to write.
      await fillMissingHourlyBreakpoints(show, 'DJ Stardust', {
        now: new Date('2026-09-17T00:40:00.000Z'),
        callerMarksCurrentHour: true,
      });

      expect(insertedRows(insertChain)).toEqual([
        expect.objectContaining({
          message: '8:00 PM Breakpoint',
          radio_hour: new Date('2026-09-17T00:00:00.000Z'),
        }),
      ]);
    });
  });

  it('reports to Sentry, inserts nothing and reports zero rows when the watermark read fails', async () => {
    // An hour marker annotates the show; it is not a precondition for
    // recording a play. A DB blip here must degrade to a missing marker, never
    // to a DJ who cannot log their track. The swallow path resolves 0, never
    // throws — the count is a fact about rows that landed (BS#2621).
    stubWatermarkSelect().limit.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(fillMissingHourlyBreakpoints(show, 'DJ Stardust')).resolves.toBe(0);

    expect(db.insert).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { subsystem: 'auto-hour-breakpoints' } })
    );
  });

  it('reports zero rows, not the would-be count, when the INSERT itself fails', async () => {
    // The count feeds addEntry's live-fs refetch (BS#2621): a swallowed insert
    // failure wrote nothing for clients to fetch, so it must read as 0 markers
    // rather than the number the fill attempted.
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T22:00:00.000Z'), add_time: null },
    ]);
    db.select.mockReturnValue(playOrderChain());
    const insertChain = createMockQueryChain();
    // Rejected at the terminal call: the statement is
    // `.values(...).onConflictDoNothing().returning(...)`, so `values` is a
    // builder step and only the last link settles.
    insertChain.returning.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
    db.insert.mockReturnValueOnce(insertChain);

    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(0);

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { subsystem: 'auto-hour-breakpoints' } })
    );
  });

  it('warns and clamps to the cap on a watermark stale by days', async () => {
    // The 2026-05-19 signature (WXYC/tubafrenzy#552). The cap keeps it
    // bounded; the warning is what makes it visible before a DJ has to report
    // a wall of hour markers.
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-01T00:00:00.000Z'), add_time: null },
    ]);
    db.select.mockReturnValue(playOrderChain());
    const insertChain = insertChainLanding(MAX_AUTO_BREAKPOINTS);
    db.insert.mockReturnValue(insertChain);

    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(MAX_AUTO_BREAKPOINTS);

    // One statement, not one per marker — see the docstring on the
    // flowsheet_watermark trigger.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertedRows(insertChain)).toHaveLength(MAX_AUTO_BREAKPOINTS);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Hourly breakpoint fill ran an unusually long catch-up',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ show_id: show.id, generated: MAX_AUTO_BREAKPOINTS, clamped: true }),
      })
    );
  });

  it.each([
    ['one', '2026-09-16T22:00:00.000Z', 1],
    ['two', '2026-09-16T21:00:00.000Z', 2],
  ])('does not warn on an ordinary %s-hour catch-up', async (_label, watermarkIso, expectedRows) => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([{ radio_hour: new Date(watermarkIso), add_time: null }]);
    db.select.mockReturnValue(playOrderChain());
    const insertChain = insertChainLanding(expectedRows);
    db.insert.mockReturnValue(insertChain);

    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(expectedRows);

    expect(insertedRows(insertChain)).toHaveLength(expectedRows);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // BS#2569. The fill re-derives its watermark per request, which makes a
  // *stale* watermark impossible but not a *concurrent* one: two requests on
  // one show can both read the same last breakpoint and generate the same
  // hour. Once the partial unique index lands, the loser's INSERT raises. An
  // unhandled raise is caught by this function's own swallow, but that
  // reports 0 and loses every marker in the batch, including the ones that
  // did not collide -- so the conflict is tolerated per row instead.
  it('tolerates a concurrent fill via ON CONFLICT DO NOTHING rather than raising', async () => {
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T22:00:00.000Z'), add_time: null },
    ]);
    db.select.mockReturnValueOnce(playOrderChain(4));
    const insertChain = insertChainLanding(1);
    db.insert.mockReturnValueOnce(insertChain);

    await fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') });

    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
  });

  it('reports only the markers that landed when a concurrent fill won the race', async () => {
    // Two hours generated; a request that committed first already holds one of
    // them, so the conflict drops that row. The count gates the live-flowsheet
    // refetch (BS#2621) and is documented as the markers the fill *committed*,
    // so it must read 1 -- not the 2 the statement attempted.
    stubWatermarkSelect().limit.mockResolvedValueOnce([
      { radio_hour: new Date('2026-09-16T21:00:00.000Z'), add_time: null },
    ]);
    db.select.mockReturnValue(playOrderChain());
    const insertChain = insertChainLanding(1);
    db.insert.mockReturnValue(insertChain);

    await expect(
      fillMissingHourlyBreakpoints(show, 'DJ Stardust', { now: new Date('2026-09-16T23:05:00.000Z') })
    ).resolves.toBe(1);

    expect(insertedRows(insertChain)).toHaveLength(2);
  });
});
