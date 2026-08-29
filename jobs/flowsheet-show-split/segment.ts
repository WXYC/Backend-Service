/**
 * Pure segmentation for `jobs/flowsheet-show-split`.
 *
 * Kept free of database access so the boundary rules — the part that decides
 * whose set is whose — are unit-testable against fixtures rather than only
 * observable by running a migration against production.
 */

/** The marker types that carry a DJ identity. */
export type MarkerType = 'show_start' | 'show_end' | 'dj_join' | 'dj_leave';

/** The subset of a flowsheet row this module needs. */
export type SplitEntry = {
  id: number;
  play_order: number;
  add_time: Date;
  entry_type: string | null;
  dj_name: string | null;
};

/** One DJ's set, carved out of an over-long show. */
export type Segment = {
  /**
   * `null` for the leading segment — it keeps the original `shows` row rather
   * than getting a new one, so it has no join marker to promote.
   */
  startMarkerId: number | null;
  /**
   * The `dj_leave` to promote to `show_end`, when the DJ actually signed off.
   * `null` means no leave marker exists and a `show_end` has to be minted at
   * `endTime` — the eureka!-shaped case where the next DJ's go-live is the
   * only evidence the set ended.
   */
  endMarkerId: number | null;
  djName: string | null;
  startTime: Date;
  /** `null` only for a segment that is genuinely still on the air. */
  endTime: Date | null;
  /** Entry ids belonging to this segment, in play order. */
  entryIds: number[];
};

export type SegmentPlan = {
  segments: Segment[];
  /**
   * Joins rejected as boundaries because they closed faster than
   * `minSegmentSeconds`. Reported so an operator can see what was treated as
   * toggle noise rather than having it silently folded in.
   */
  ignoredBlips: { id: number; djName: string | null; seconds: number }[];
};

const isMarker = (e: SplitEntry, t: MarkerType) => e.entry_type === t;

/**
 * Find the `dj_leave` that closes a given `dj_join`.
 *
 * Matched on `dj_name` rather than position: co-hosts overlap, so the next
 * `dj_leave` in the list is frequently somebody else's. Marker `dj_name` is
 * the resolved public handle written at insert time, which is the only DJ
 * identity these rows carry.
 */
export const findMatchingLeave = (entries: SplitEntry[], join: SplitEntry): SplitEntry | null => {
  for (const e of entries) {
    if (e.play_order <= join.play_order) continue;
    if (isMarker(e, 'dj_leave') && e.dj_name === join.dj_name) return e;
  }
  return null;
};

/**
 * Split one show's entries into per-DJ segments at its `dj_join` boundaries.
 *
 * A `dj_join` is a boundary — a set handoff the go-live defect recorded as a
 * guest join — unless it closes within `minSegmentSeconds`, which is the
 * signature of the blind-toggle retry described in WXYC/dj-site#1035. A
 * four-second join/leave pair is a mis-click, not a show, and promoting it
 * would mint a four-second show and evict the real DJ's entries around it.
 * Sub-threshold joins stay exactly where they are, as co-host markers inside
 * whichever segment contains them.
 *
 * A segment ends at its own `dj_leave` when one exists — a DJ who signed off
 * at 15:56 did not stay on until the next DJ arrived at 16:02, and recording
 * the gap as theirs would invent six minutes of airtime. Absent a leave, it
 * ends where the next boundary begins, and the final segment inherits the
 * original show's `end_time` (`null` when it is genuinely still live).
 *
 * @param entries every row of the show, any order; sorted internally
 * @param showStartTime the original show's `start_time`
 * @param showEndTime the original show's `end_time`, `null` when still open
 * @param minSegmentSeconds boundary threshold; joins closing faster are blips
 */
export const planSegments = (
  entries: SplitEntry[],
  showStartTime: Date,
  showEndTime: Date | null,
  minSegmentSeconds: number
): SegmentPlan => {
  const sorted = [...entries].sort((a, b) => a.play_order - b.play_order || a.id - b.id);

  const ignoredBlips: SegmentPlan['ignoredBlips'] = [];
  const boundaries: { join: SplitEntry; leave: SplitEntry | null }[] = [];

  for (const e of sorted) {
    if (!isMarker(e, 'dj_join')) continue;
    const leave = findMatchingLeave(sorted, e);
    // No leave means the set never closed — it ran until the next DJ went
    // live, so it is a boundary by definition and cannot be a blip.
    const seconds = leave ? (leave.add_time.getTime() - e.add_time.getTime()) / 1000 : Infinity;
    if (seconds < minSegmentSeconds) {
      ignoredBlips.push({ id: e.id, djName: e.dj_name, seconds });
      continue;
    }
    boundaries.push({ join: e, leave });
  }

  const leadDjName = sorted.find((e) => isMarker(e, 'show_start'))?.dj_name ?? null;

  const segments: Segment[] = [];
  const firstBoundaryOrder = boundaries[0]?.join.play_order ?? Infinity;

  segments.push({
    startMarkerId: null,
    // The original DJ's own sign-off, if it somehow landed. In the case this
    // job exists for it never does — the show stayed open precisely because
    // nobody ended it — so this is normally null and a marker gets minted.
    endMarkerId: sorted.find((e) => isMarker(e, 'show_end'))?.id ?? null,
    djName: leadDjName,
    startTime: showStartTime,
    endTime: boundaries.length > 0 ? boundaries[0].join.add_time : showEndTime,
    entryIds: sorted.filter((e) => e.play_order < firstBoundaryOrder).map((e) => e.id),
  });

  boundaries.forEach(({ join, leave }, i) => {
    const next = boundaries[i + 1];
    const upperOrder = next ? next.join.play_order : Infinity;
    segments.push({
      startMarkerId: join.id,
      endMarkerId: leave?.id ?? null,
      djName: join.dj_name,
      startTime: join.add_time,
      endTime: leave ? leave.add_time : next ? next.join.add_time : showEndTime,
      entryIds: sorted.filter((e) => e.play_order >= join.play_order && e.play_order < upperOrder).map((e) => e.id),
    });
  });

  return { segments, ignoredBlips };
};
