/**
 * Marker `message` text for `jobs/flowsheet-show-split`.
 *
 * Kept here, pure and DB-free, for the same reason `segment.ts` is: these
 * strings are public — `flowsheet.message` is selected on the read path and
 * carried by the v2 projection — and they have to stay byte-identical to what
 * the live sign-on / sign-off path writes, which is a property a unit test can
 * pin and a code review cannot.
 *
 * Promoting a boundary marker is NOT just an `entry_type` flip. The join and
 * leave writers put a DIFFERENT sentence in `message` than the show writers do
 * (all four in `apps/backend/services/flowsheet.service.ts`):
 *
 *   dj_join     `<name> joined the set!`                      createJoinNotification
 *   dj_leave    `<name> left the set!`                        createLeaveNotification
 *   show_start  `Start of Show: <name> joined the set at <t>`  startShow
 *   show_end    `End of Show: <name> left the set at <t>`      endShow
 *
 * A promoted marker that keeps the join wording renders a repaired show as
 * having no start-of-show line at all — just a guest arriving — which is the
 * shape the split exists to remove.
 */

/**
 * Station-local wall clock, matching the live writers' own rendering.
 *
 * `America/New_York` and `en-US` are not incidental: `startShow` and `endShow`
 * both build their text with `toLocaleString('en-US', { timeZone:
 * 'America/New_York' })`, so anything else would make a repaired marker
 * visibly different from a naturally written one.
 */
const easternWallClock = (at: Date): string => at.toLocaleString('en-US', { timeZone: 'America/New_York' });

/**
 * `startShow`'s marker text, including its nameless degradation.
 *
 * The lower-case `Start of show:` in the nameless arm mirrors the live writer
 * exactly (epic #1288's asymmetric fallback); it is not a typo to tidy.
 */
export const showStartMessage = (djName: string | null, at: Date): string =>
  djName
    ? `Start of Show: ${djName} joined the set at ${easternWallClock(at)}`
    : `Start of show: ${easternWallClock(at)}`;

/** `endShow`'s marker text, including its nameless degradation. */
export const showEndMessage = (djName: string | null, at: Date): string =>
  djName ? `End of Show: ${djName} left the set at ${easternWallClock(at)}` : `End of show: ${easternWallClock(at)}`;
