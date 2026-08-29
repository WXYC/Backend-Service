/**
 * Unit tests for the flowsheet-show-split boundary rules.
 *
 * The primary fixture is production show 1951224 as it stood on 2026-08-28 —
 * the incident this job was written for. `dj sue` signed on at 11:02 PDT and
 * never signed off, so the next four DJs' go-lives were recorded as `dj_join`
 * against her show instead of starting their own (WXYC/dj-site#1035). Using
 * the real marker sequence keeps the rules honest about the shapes that
 * actually occur: a clean leave-then-join handoff, a handoff where the
 * outgoing DJ never left, and a four-second toggle blip.
 */

import { planSegments, findMatchingLeave, type SplitEntry } from '../../../../jobs/flowsheet-show-split/segment';

/** 2026-08-28 PDT wall-clock to UTC Date. */
const pdt = (hhmmss: string): Date => new Date(`2026-08-28T${hhmmss}-07:00`);

const marker = (
  id: number,
  play_order: number,
  time: string,
  entry_type: string,
  dj_name: string | null
): SplitEntry => ({
  id,
  play_order,
  add_time: pdt(time),
  entry_type,
  dj_name,
});

const track = (id: number, play_order: number, time: string): SplitEntry => marker(id, play_order, time, 'track', null);

/** Show 1951224's real marker sequence, with a few tracks for span checks. */
const showEntries = (): SplitEntry[] => [
  marker(5312913, 1, '11:02:34', 'show_start', 'dj sue'),
  track(5312914, 2, '11:04:00'),
  track(5312956, 43, '13:43:00'),
  marker(5312957, 44, '14:02:58', 'dj_join', 'DJ String Theory'),
  track(5312958, 45, '14:10:00'),
  marker(5312986, 73, '15:56:09', 'dj_leave', 'DJ String Theory'),
  marker(5312987, 74, '16:02:50', 'dj_join', 'Panzón'),
  track(5312988, 75, '16:10:00'),
  marker(5313019, 105, '18:02:01', 'dj_leave', 'Panzón'),
  marker(5313020, 106, '18:03:47', 'dj_join', 'dj eureka!'),
  track(5313021, 107, '18:10:00'),
  marker(5313024, 110, '18:20:02', 'dj_join', 'DJ Whiskers'),
  marker(5313025, 111, '18:20:06', 'dj_leave', 'DJ Whiskers'),
  track(5313037, 122, '19:00:05'),
  marker(5313038, 123, '21:00:28', 'dj_join', 'Dj xD'),
  track(5313039, 124, '21:10:00'),
];

const plan = (entries = showEntries(), end: Date | null = null, min = 120) =>
  planSegments(entries, pdt('11:02:34'), end, min);

describe('planSegments — production show 1951224', () => {
  it('carves one segment per DJ, in play order', () => {
    const { segments } = plan();
    expect(segments.map((s) => s.djName)).toEqual(['dj sue', 'DJ String Theory', 'Panzón', 'dj eureka!', 'Dj xD']);
  });

  it('ends the abandoned lead show where the next DJ went live, not at its last track', () => {
    const [sue] = plan().segments;
    // 14:02:58 is String Theory's go-live. Sue's last track was 13:43; the
    // 20 minutes between are hers by the only evidence available, and the
    // show must not stay open past the point somebody else took over.
    expect(sue.endTime).toEqual(pdt('14:02:58'));
    expect(sue.startMarkerId).toBeNull();
  });

  it('ends a segment at its own dj_leave rather than the next go-live', () => {
    const [, stringTheory] = plan().segments;
    // Signed off 15:56:09; Panzón arrived 16:02:50. Those six minutes belong
    // to nobody, and crediting them to String Theory would invent airtime.
    expect(stringTheory.endTime).toEqual(pdt('15:56:09'));
    expect(stringTheory.endMarkerId).toBe(5312986);
  });

  it('ends a segment whose DJ never left at the next go-live, with no marker to promote', () => {
    const eureka = plan().segments[3];
    expect(eureka.endTime).toEqual(pdt('21:00:28'));
    // No dj_leave exists, so the caller has to mint a show_end.
    expect(eureka.endMarkerId).toBeNull();
  });

  it('leaves the final segment open when the original show is still open', () => {
    const last = plan().segments.at(-1);
    expect(last.djName).toBe('Dj xD');
    expect(last.endTime).toBeNull();
  });

  it('closes the final segment at the original end_time when the show has ended', () => {
    const last = plan(showEntries(), pdt('23:01:00')).segments.at(-1);
    expect(last.endTime).toEqual(pdt('23:01:00'));
  });

  it('treats a four-second join/leave pair as toggle noise, not a show', () => {
    const { segments, ignoredBlips } = plan();
    expect(segments.map((s) => s.djName)).not.toContain('DJ Whiskers');
    expect(ignoredBlips).toEqual([{ id: 5313024, djName: 'DJ Whiskers', seconds: 4 }]);
  });

  it("keeps a blip DJ's markers inside the segment that contains them", () => {
    const eureka = plan().segments[3];
    // Whiskers' join and leave stay as co-host markers in eureka!'s show.
    expect(eureka.entryIds).toEqual(expect.arrayContaining([5313024, 5313025]));
  });

  it('assigns every entry to exactly one segment, losing none', () => {
    const entries = showEntries();
    const assigned = plan(entries).segments.flatMap((s) => s.entryIds);
    expect(assigned.sort()).toEqual(entries.map((e) => e.id).sort());
    expect(new Set(assigned).size).toBe(entries.length);
  });

  it('gives each segment a contiguous play-order run', () => {
    const { segments } = plan();
    expect(segments.map((s) => s.entryIds.length)).toEqual([3, 3, 3, 5, 2]);
  });
});

describe('planSegments — boundary rules in isolation', () => {
  it('promotes a join whose leave falls exactly on the threshold', () => {
    const entries = [
      marker(1, 1, '11:00:00', 'show_start', 'A'),
      marker(2, 2, '12:00:00', 'dj_join', 'B'),
      marker(3, 3, '12:02:00', 'dj_leave', 'B'),
    ];
    // 120s is not < 120s, so it is a boundary.
    expect(plan(entries, null, 120).segments.map((s) => s.djName)).toEqual(['A', 'B']);
    expect(plan(entries, null, 121).segments.map((s) => s.djName)).toEqual(['A']);
  });

  it('matches a leave to its join by dj_name, not by position', () => {
    // B joins, C joins, B leaves, C leaves — overlapping co-hosts, so the
    // next dj_leave after B's join belongs to C, not B.
    const entries = [
      marker(1, 1, '11:00:00', 'show_start', 'A'),
      marker(2, 2, '12:00:00', 'dj_join', 'B'),
      marker(3, 3, '12:30:00', 'dj_join', 'C'),
      marker(4, 4, '13:00:00', 'dj_leave', 'C'),
      marker(5, 5, '13:30:00', 'dj_leave', 'B'),
    ];
    const joinB = entries[1];
    expect(findMatchingLeave(entries, joinB).id).toBe(5);
    const [, b] = plan(entries).segments;
    expect(b.endTime).toEqual(pdt('13:30:00'));
  });

  it('returns a single segment for a show that never changed hands', () => {
    const entries = [marker(1, 1, '11:00:00', 'show_start', 'A'), track(2, 2, '11:05:00')];
    const { segments } = plan(entries, pdt('13:00:00'));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ djName: 'A', startMarkerId: null, endTime: pdt('13:00:00') });
  });

  it('sorts by play_order regardless of input order', () => {
    const shuffled = [...showEntries()].reverse();
    expect(plan(shuffled).segments.map((s) => s.djName)).toEqual(plan().segments.map((s) => s.djName));
  });
});
