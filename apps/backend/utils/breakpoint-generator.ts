/**
 * Pure top-of-hour breakpoint generation for `POST /flowsheet` (BS#2516).
 * Tubafrenzy inserted one hourly marker per elapsed station hour on the first
 * track-add of a new hour (`FlowsheetEntryService.createEntryWithAutoBreakpoints`);
 * this is the Backend-Service equivalent, minus the two defects that path
 * accumulated:
 *
 *   - An unbounded catch-up loop, which on 2026-05-19 walked a week-stale
 *     working hour and inserted 168 spurious breakpoints on show 171989 in a
 *     one-second burst. Capped at `MAX_AUTO_BREAKPOINTS` here; capped there by
 *     WXYC/tubafrenzy#552.
 *   - A client-supplied working hour (a hidden JSP form field a stale tab
 *     replayed), which is what made the watermark week-stale in the first
 *     place. Resolved server-side here; WXYC/tubafrenzy#554 did the same for
 *     the three JSP add servlets.
 *
 * Deliberately DB-free: the cap, the DST behaviour, and the message shape
 * are all pure functions of a clock and a watermark, so they're testable
 * without a database. Callers resolve the watermark (the show's last known
 * marker instant) and pass in `now` — this module never reads a clock or a
 * client-supplied hour on its own.
 */
import { NY_TIME_ZONE } from '@wxyc/database';

const MS_PER_HOUR = 3_600_000;

/**
 * Upper bound on how many hourly breakpoints one `generateMissingBreakpoints`
 * call may return. A stale OR absent watermark is clamped forward to this
 * many hours before `now` rather than walked from — see the 2026-05-19
 * incident in the module docstring above. Same value tubafrenzy#552 chose,
 * deliberately: 25 covers any real show plus an hour of slack, and nothing
 * longer is a show.
 */
export const MAX_AUTO_BREAKPOINTS = 25;

/**
 * The word every reader of a breakpoint row discriminates on. Exported so the
 * producer here and `inferMessageEntryType` (flowsheet.controller.ts) share one
 * copy rather than two literals that can drift. `@wxyc/shared`'s
 * `isFlowsheetBreakpointEntry` holds a third copy across the repo boundary;
 * consolidating that one is its own change.
 */
export const BREAKPOINT_SUFFIX = 'Breakpoint';

const stationHourLabelFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/**
 * The exact string persisted as a generated breakpoint's `message`, e.g.
 * "7:00 PM Breakpoint" — the station wall-clock label for an exact
 * top-of-hour instant, plus the discriminator word. Must match dj-site's
 * `breakpointMessageForHourLabel` byte-for-byte.
 *
 * Formats only: callers own flooring `instant` to an hour boundary first, and
 * `generateMissingBreakpoints` always does.
 */
export const breakpointMessageForHour = (instant: Date): string =>
  `${stationHourLabelFormat.format(instant)} ${BREAKPOINT_SUFFIX}`;

/**
 * Floor an instant to the top of its hour, in epoch time. America/New_York's
 * UTC offset is always a whole number of hours, so an epoch-hour boundary is
 * always also an Eastern wall-clock hour boundary — no zone-aware arithmetic
 * needed here (same reasoning dj-site's `closestStationHour` records).
 */
const floorToHourMs = (ms: number): number => ms - (ms % MS_PER_HOUR);

/**
 * The top-of-hour a *marker* instant stands for: nearest boundary, with
 * strictly-past-:30 rounding up and exactly-:30 rounding down.
 *
 * This is for instants that NAME an hour, never for ordinary ones. A
 * breakpoint is logged either side of the hour it marks, and when its
 * `radio_hour` is absent its `add_time` is all the caller has to recover that
 * hour from — `schema.ts` calls flooring it "across the boundary" the very
 * defect `radio_hour` was added to fix (BS#1449). Rounding is also what
 * produced the row's own label: dj-site's `closestStationHour` picks the
 * nearest hour, so a press at 6:58 PM writes "7:00 PM Breakpoint", and a
 * watermark that floored to 6:00 PM would generate a second 7:00 PM marker on
 * the next add. The two must round identically or they disagree about which
 * hour a row already covers.
 *
 * Whole-hour epoch arithmetic is sound here for the same reason flooring is:
 * America/New_York's offset is always a whole number of hours.
 */
export const nearestStationHour = (instant: Date): Date => {
  const ms = instant.getTime();
  const flooredMs = floorToHourMs(ms);
  return new Date(ms - flooredMs > MS_PER_HOUR / 2 ? flooredMs + MS_PER_HOUR : flooredMs);
};

export type GeneratedBreakpoint = {
  radio_hour: Date;
  message: string;
};

/**
 * The top-of-hour breakpoints missing between `watermark` (the show's last
 * known marker instant, exclusive) and `now` (inclusive of the most
 * recently completed hour). `watermark` need not already sit on an hour
 * boundary — a show's start time rarely does — it is floored the same way
 * `now` is.
 *
 * `watermark: null` (no prior marker resolvable at all) is treated as
 * maximally stale, not as "the beginning of time": it clamps to the same
 * cap as any other stale watermark, so an absent watermark can never emit
 * more than `MAX_AUTO_BREAKPOINTS` markers. Today's only caller cannot reach
 * that arm — `getBreakpointWatermark` is total, because `shows.start_time` is
 * NOT NULL — so it exists to make the cap hold over the absent case #2516's
 * acceptance criteria name, independently of which caller resolves it.
 *
 * DST falls out of walking epoch-hour boundaries rather than wall-clock
 * fields, with no special-casing: on a fall-back night two boundaries an
 * epoch-hour apart both format to the same "1:00 AM" label — real, distinct
 * instants, which is why the caller's uniqueness key must be `radio_hour`
 * (the instant), never the message string. On a spring-forward night the
 * transition instant itself IS the boundary where "2:00 AM" would have
 * fallen, and it formats as "3:00 AM" instead, so no boundary ever produces
 * the skipped hour.
 */
export const generateMissingBreakpoints = (watermark: Date | null, now: Date = new Date()): GeneratedBreakpoint[] => {
  const nowFloorMs = floorToHourMs(now.getTime());
  const earliestMs = nowFloorMs - MAX_AUTO_BREAKPOINTS * MS_PER_HOUR;
  const watermarkFloorMs = watermark ? floorToHourMs(watermark.getTime()) : earliestMs;
  const startMs = Math.max(watermarkFloorMs, earliestMs);

  const breakpoints: GeneratedBreakpoint[] = [];
  for (let boundaryMs = startMs + MS_PER_HOUR; boundaryMs <= nowFloorMs; boundaryMs += MS_PER_HOUR) {
    const radio_hour = new Date(boundaryMs);
    breakpoints.push({ radio_hour, message: breakpointMessageForHour(radio_hour) });
  }
  return breakpoints;
};
