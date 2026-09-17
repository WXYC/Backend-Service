import {
  generateMissingBreakpoints,
  breakpointMessageForHour,
  nearestStationHour,
  MAX_AUTO_BREAKPOINTS,
} from '../../../apps/backend/utils/breakpoint-generator';

const MS_PER_HOUR = 3_600_000;
const d = (iso: string) => new Date(iso);

describe('breakpointMessageForHour', () => {
  it.each([
    ['2026-09-16T23:00:00.000Z', '7:00 PM Breakpoint'], // 7:00 PM EDT
    ['2026-09-17T00:00:00.000Z', '8:00 PM Breakpoint'], // 8:00 PM EDT
    ['2026-09-17T04:00:00.000Z', '12:00 AM Breakpoint'], // midnight EDT — no leading zero, "12" not "0"
    ['2026-09-17T16:00:00.000Z', '12:00 PM Breakpoint'], // noon EDT
  ])('renders %s as %s', (iso, expected) => {
    expect(breakpointMessageForHour(d(iso))).toBe(expected);
  });
});

describe('nearestStationHour (BS#2516)', () => {
  // Must agree exactly with dj-site's `closestStationHour`, which is what
  // labelled the row whose add_time this recovers an hour from: strictly past
  // :30 rounds up, exactly :30 rounds down. A disagreement at the boundary is
  // a duplicate breakpoint, not a cosmetic difference.
  it.each([
    ['exactly on the hour', '2026-09-16T23:00:00.000Z', '2026-09-16T23:00:00.000Z'],
    ['two minutes early', '2026-09-16T22:58:00.000Z', '2026-09-16T23:00:00.000Z'],
    ['one minute late', '2026-09-16T23:01:00.000Z', '2026-09-16T23:00:00.000Z'],
    ['exactly :30 rounds DOWN', '2026-09-16T22:30:00.000Z', '2026-09-16T22:00:00.000Z'],
    ['one second past :30 rounds UP', '2026-09-16T22:30:01.000Z', '2026-09-16T23:00:00.000Z'],
  ])('%s', (_label, input, expected) => {
    expect(nearestStationHour(d(input))).toEqual(d(expected));
  });

  it('rounds across a DST fall-back boundary without collapsing the repeated hour', () => {
    // 05:30Z is 1:30 AM EDT, 06:30Z is 1:30 AM EST — same label, distinct
    // instants, and each must round to its OWN boundary.
    expect(nearestStationHour(d('2026-11-01T05:29:00.000Z'))).toEqual(d('2026-11-01T05:00:00.000Z'));
    expect(nearestStationHour(d('2026-11-01T06:29:00.000Z'))).toEqual(d('2026-11-01T06:00:00.000Z'));
  });
});

describe('generateMissingBreakpoints — bounding (BS#2516)', () => {
  // 2026-09-17T04:30:00Z is 2026-09-17T00:30:00 EDT — floor(now) is
  // 2026-09-17T04:00:00Z (12:00 AM EDT).
  const now = d('2026-09-17T04:30:00.000Z');
  const nowFloorMs = d('2026-09-17T04:00:00.000Z').getTime();

  it('emits nothing when the watermark is already at the current hour', () => {
    expect(generateMissingBreakpoints(new Date(nowFloorMs), now)).toEqual([]);
  });

  it('emits exactly one marker for a watermark one hour back', () => {
    const watermark = new Date(nowFloorMs - MS_PER_HOUR);
    const result = generateMissingBreakpoints(watermark, now);
    expect(result).toEqual([{ radio_hour: new Date(nowFloorMs), message: expect.stringContaining('Breakpoint') }]);
  });

  it.each<[string, Date | null]>([
    ['a null watermark', null],
    ['a watermark 1000 hours stale', new Date(nowFloorMs - 1000 * MS_PER_HOUR)],
    ['a watermark 26 hours stale (one past the cap)', new Date(nowFloorMs - 26 * MS_PER_HOUR)],
    ['a watermark exactly at the cap boundary', new Date(nowFloorMs - MAX_AUTO_BREAKPOINTS * MS_PER_HOUR)],
  ])('caps at %s to at most MAX_AUTO_BREAKPOINTS markers, ending at the current hour', (_label, watermark) => {
    const result = generateMissingBreakpoints(watermark, now);
    expect(result).toHaveLength(MAX_AUTO_BREAKPOINTS);
    expect(result[result.length - 1].radio_hour).toEqual(new Date(nowFloorMs));
    expect(result[0].radio_hour).toEqual(new Date(nowFloorMs - (MAX_AUTO_BREAKPOINTS - 1) * MS_PER_HOUR));
  });

  it('every generated radio_hour is exactly one hour after the previous one', () => {
    const result = generateMissingBreakpoints(null, now);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].radio_hour.getTime() - result[i - 1].radio_hour.getTime()).toBe(MS_PER_HOUR);
    }
  });
});

describe('generateMissingBreakpoints — DST (BS#2516)', () => {
  // 2026-11-01 America/New_York fall-back: clocks read 1:00 AM twice, an
  // epoch-hour apart — 05:00Z (1:00 AM EDT) then 06:00Z (1:00 AM EST).
  it('a fall-back night carries two distinct 1:00 AM markers, one absolute hour apart', () => {
    const watermark = d('2026-11-01T04:00:00.000Z'); // 12:00 AM EDT boundary
    const now = d('2026-11-01T06:30:00.000Z'); // 1:30 AM EST
    const result = generateMissingBreakpoints(watermark, now);

    expect(result.map((b) => b.message)).toEqual(['1:00 AM Breakpoint', '1:00 AM Breakpoint']);
    expect(result[0].radio_hour).toEqual(d('2026-11-01T05:00:00.000Z'));
    expect(result[1].radio_hour).toEqual(d('2026-11-01T06:00:00.000Z'));
    // Same label, but genuinely distinct instants — this is the case a
    // message-string-keyed dedupe guard would wrongly collapse to one.
    expect(result[0].radio_hour.getTime()).not.toBe(result[1].radio_hour.getTime());
  });

  // 2026-03-08 America/New_York spring-forward: the wall clock jumps from
  // 1:59:59 AM EST straight to 3:00:00 AM EDT. The 2:00 AM hour never
  // occurs, so no boundary should ever format to it.
  it('a spring-forward night generates no marker for the missing 2:00 AM hour', () => {
    const watermark = d('2026-03-08T05:00:00.000Z'); // 12:00 AM EST boundary
    const now = d('2026-03-08T07:30:00.000Z'); // 3:30 AM EDT
    const result = generateMissingBreakpoints(watermark, now);

    expect(result.map((b) => b.message)).toEqual(['1:00 AM Breakpoint', '3:00 AM Breakpoint']);
    expect(result.some((b) => b.message === '2:00 AM Breakpoint')).toBe(false);
  });
});
