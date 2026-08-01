/**
 * Unit tests for metadata-no-match-digest/format.ts -- pure functions only,
 * no DB/network. Fixtures use `@wxyc/shared` example WXYC playcuts (Juana
 * Molina / Jessica Pratt / Chuquimamani-Condori) per the org convention:
 * never mainstream artists in test/example data.
 */
import { wxycExampleFlowsheetEntries } from '@wxyc/shared/test-utils';
import {
  buildDigestEmail,
  buildSubject,
  formatPacificDate,
  formatPacificDateTime,
  FREEFORM_TOP_N,
  groupFreeformByArtist,
  splitByLinkage,
  synthesizeDiscogsSearchUrl,
  type NoMatchRow,
} from '../../../../jobs/metadata-no-match-digest/format';

const { juanaMolinaLaParadoja, jessicaPrattBackBaby, chuquimamaniCondoriCallYourName } = wxycExampleFlowsheetEntries;

let nextId = 1;

/** Build a NoMatchRow from an `@wxyc/shared` example flowsheet entry, with DB-only fields defaulted. */
const makeRow = (
  source: { artist_name: string; track_title: string; album_title: string; record_label: string },
  overrides: Partial<NoMatchRow> = {}
): NoMatchRow => ({
  id: nextId++,
  artist_name: source.artist_name,
  track_title: source.track_title,
  album_title: source.album_title,
  record_label: source.record_label,
  rotation_id: null,
  album_id: null,
  dj_name: 'DJ Test',
  show_id: 1,
  updated_at: new Date('2026-07-31T15:00:00Z'),
  add_time: new Date('2026-07-31T14:55:00Z'),
  show_name: 'Test Show',
  start_time: new Date('2026-07-31T14:00:00Z'),
  ...overrides,
});

describe('splitByLinkage', () => {
  it('routes rows with a non-null rotation_id to rotationLinked', () => {
    const rotationRow = makeRow(juanaMolinaLaParadoja, { rotation_id: 42 });
    const freeformRow = makeRow(jessicaPrattBackBaby, { rotation_id: null });

    const { rotationLinked, freeform } = splitByLinkage([rotationRow, freeformRow]);

    expect(rotationLinked).toEqual([rotationRow]);
    expect(freeform).toEqual([freeformRow]);
  });

  it('returns empty arrays for an empty input', () => {
    expect(splitByLinkage([])).toEqual({ rotationLinked: [], freeform: [] });
  });

  it('does not misclassify rotation_id: 0 -- rotation_id is a serial PK, never 0, but null is the only "unlinked" sentinel', () => {
    const row = makeRow(juanaMolinaLaParadoja, { rotation_id: 1 });
    const { rotationLinked, freeform } = splitByLinkage([row]);
    expect(rotationLinked).toHaveLength(1);
    expect(freeform).toHaveLength(0);
  });
});

describe('groupFreeformByArtist', () => {
  it('groups by artist_name and counts plays', () => {
    const rows = [makeRow(juanaMolinaLaParadoja), makeRow(juanaMolinaLaParadoja), makeRow(jessicaPrattBackBaby)];

    const { top, moreCount } = groupFreeformByArtist(rows);

    expect(top).toEqual([
      { artist: 'Juana Molina', count: 2 },
      { artist: 'Jessica Pratt', count: 1 },
    ]);
    expect(moreCount).toBe(0);
  });

  it('sorts by count desc, then artist name asc as a deterministic tiebreak', () => {
    const rows = [
      makeRow(jessicaPrattBackBaby),
      makeRow(juanaMolinaLaParadoja),
      makeRow(chuquimamaniCondoriCallYourName),
    ];

    const { top } = groupFreeformByArtist(rows);

    expect(top.map((g) => g.artist)).toEqual(['Chuquimamani-Condori', 'Jessica Pratt', 'Juana Molina']);
  });

  it('caps at topN and reports the remaining group count as "and X more"', () => {
    const artists = Array.from({ length: 30 }, (_, i) => `Artist ${String(i).padStart(2, '0')}`);
    const rows = artists.map((artist) => makeRow(juanaMolinaLaParadoja, { artist_name: artist }));

    const { top, moreCount } = groupFreeformByArtist(rows, 25);

    expect(top).toHaveLength(25);
    expect(moreCount).toBe(5);
  });

  it('defaults topN to FREEFORM_TOP_N (25)', () => {
    expect(FREEFORM_TOP_N).toBe(25);
  });

  it('falls back to "Unknown artist" for a null/blank artist_name', () => {
    const rows = [
      makeRow(juanaMolinaLaParadoja, { artist_name: null }),
      makeRow(juanaMolinaLaParadoja, { artist_name: '   ' }),
    ];

    const { top } = groupFreeformByArtist(rows);

    expect(top).toEqual([{ artist: 'Unknown artist', count: 2 }]);
  });

  it('returns no groups for an empty input', () => {
    expect(groupFreeformByArtist([])).toEqual({ top: [], moreCount: 0 });
  });
});

describe('synthesizeDiscogsSearchUrl', () => {
  it('builds a Discogs release search URL from artist + track', () => {
    const url = synthesizeDiscogsSearchUrl('Juana Molina', 'la paradoja');
    expect(url).toBe('https://www.discogs.com/search/?q=Juana%20Molina%20la%20paradoja&type=release');
  });

  it('url-encodes special characters (diacritics, ampersands)', () => {
    const url = synthesizeDiscogsSearchUrl('Duke Ellington & John Coltrane', 'In a Sentimental Mood');
    expect(url).toContain('type=release');
    expect(url).toContain(encodeURIComponent('Duke Ellington & John Coltrane'));
  });

  it('falls back gracefully when track_title is null', () => {
    const url = synthesizeDiscogsSearchUrl('Chuquimamani-Condori', null);
    expect(url).toBe('https://www.discogs.com/search/?q=Chuquimamani-Condori&type=release');
  });

  it('falls back gracefully when both are null', () => {
    const url = synthesizeDiscogsSearchUrl(null, null);
    expect(url).toBe('https://www.discogs.com/search/?q=&type=release');
  });
});

describe('formatPacificDate / formatPacificDateTime (PT rendering)', () => {
  it('formats a UTC instant as a Pacific-Daylight (PDT-era) calendar date', () => {
    // 2026-07-31T15:07:00Z is 08:07 PDT (UTC-7) -- the job's own cron instant.
    expect(formatPacificDate(new Date('2026-07-31T15:07:00Z'))).toBe('2026-07-31');
  });

  it('formats a UTC instant as a Pacific-Standard (PST-era) calendar date, one day earlier than UTC', () => {
    // 2026-01-15T03:00:00Z is 2026-01-14T19:00 PST (UTC-8) -- crosses the date line.
    expect(formatPacificDate(new Date('2026-01-15T03:00:00Z'))).toBe('2026-01-14');
  });

  it('appends an explicit PT label and never PST/PDT', () => {
    const rendered = formatPacificDateTime(new Date('2026-07-31T15:07:00Z'));
    expect(rendered).toContain('PT');
    expect(rendered).not.toContain('PDT');
    expect(rendered).not.toContain('PST');
  });

  it('renders the same fixed 15:07 UTC cron instant one hour earlier in PT during standard time (the DST wall-clock drift the README documents)', () => {
    const summer = formatPacificDateTime(new Date('2026-07-31T15:07:00Z'));
    const winter = formatPacificDateTime(new Date('2026-01-31T15:07:00Z'));
    expect(summer).toContain('8:07');
    expect(winter).toContain('7:07');
  });
});

describe('buildSubject', () => {
  it('pluralizes for more than one playcut and carries the PT date', () => {
    expect(buildSubject(3, new Date('2026-07-31T15:07:00Z'))).toBe(
      'WXYC metadata gaps: 3 playcuts with no match — 2026-07-31'
    );
  });

  it('does not pluralize for exactly one playcut', () => {
    expect(buildSubject(1, new Date('2026-07-31T15:07:00Z'))).toBe(
      'WXYC metadata gaps: 1 playcut with no match — 2026-07-31'
    );
  });
});

describe('buildDigestEmail', () => {
  const since = new Date('2026-07-30T15:07:00Z');
  const runStart = new Date('2026-07-31T15:07:00Z');

  it('returns null for zero rows -- no email is built (and therefore none is sent)', () => {
    expect(buildDigestEmail([], { since, runStart })).toBeNull();
  });

  it('splits rotation-linked (Section A, full detail) from freeform (Section B, grouped)', () => {
    const rotationRow = makeRow(juanaMolinaLaParadoja, { rotation_id: 42, id: 501 });
    const freeformRow = makeRow(jessicaPrattBackBaby, { rotation_id: null, id: 502 });

    const digest = buildDigestEmail([rotationRow, freeformRow], { since, runStart });

    expect(digest).not.toBeNull();
    expect(digest.html).toContain('Catalog/rotation-linked');
    expect(digest.html).toContain('#501');
    expect(digest.html).toContain('Juana Molina');
    expect(digest.html).toContain('Freeform');
    expect(digest.html).toContain('Jessica Pratt');
    expect(digest.text).toContain('#501');
    expect(digest.text).toContain('Jessica Pratt');
  });

  it('includes a header with total / rotation-linked / freeform counts', () => {
    const rows = [
      makeRow(juanaMolinaLaParadoja, { rotation_id: 42 }),
      makeRow(jessicaPrattBackBaby, { rotation_id: null }),
      makeRow(chuquimamaniCondoriCallYourName, { rotation_id: null }),
    ];

    const digest = buildDigestEmail(rows, { since, runStart });

    expect(digest.text).toContain('3 total');
    expect(digest.text).toContain('1 catalog/rotation-linked');
    expect(digest.text).toContain('2 freeform');
  });

  it('carries the subject built by buildSubject', () => {
    const rows = [makeRow(juanaMolinaLaParadoja, { rotation_id: 1 })];
    const digest = buildDigestEmail(rows, { since, runStart });
    expect(digest.subject).toBe(buildSubject(1, runStart));
  });

  it('renders a Discogs search link per rotation-linked row', () => {
    const row = makeRow(juanaMolinaLaParadoja, { rotation_id: 1 });
    const digest = buildDigestEmail([row], { since, runStart });
    expect(digest.html).toContain(synthesizeDiscogsSearchUrl(row.artist_name, row.track_title));
  });

  it('renders a Discogs search link per freeform artist group', () => {
    const row = makeRow(jessicaPrattBackBaby, { rotation_id: null });
    const digest = buildDigestEmail([row], { since, runStart });
    expect(digest.html).toContain(synthesizeDiscogsSearchUrl(row.artist_name, null));
  });

  it('shows "…and X more" once the freeform tail exceeds the top-N cap', () => {
    const rows = Array.from({ length: 27 }, (_, i) =>
      makeRow(juanaMolinaLaParadoja, { artist_name: `Artist ${i}`, rotation_id: null })
    );
    const digest = buildDigestEmail(rows, { since, runStart });
    expect(digest.text).toMatch(/and 2 more/);
  });

  it('omits the "and X more" line when the freeform tail fits within top-N', () => {
    const rows = [makeRow(jessicaPrattBackBaby, { rotation_id: null })];
    const digest = buildDigestEmail(rows, { since, runStart });
    expect(digest.text).not.toMatch(/more/);
  });

  it('renders the window bounds and a reply-to-follow-up footer note', () => {
    const rows = [makeRow(juanaMolinaLaParadoja, { rotation_id: 1 })];
    const digest = buildDigestEmail(rows, { since, runStart });
    expect(digest.text.toLowerCase()).toContain('reply');
    expect(digest.text).toContain(formatPacificDateTime(since));
  });

  it('renders "None." for an empty Section A when every miss is freeform', () => {
    const rows = [makeRow(jessicaPrattBackBaby, { rotation_id: null })];
    const digest = buildDigestEmail(rows, { since, runStart });
    expect(digest.text).toMatch(/Catalog\/rotation-linked[\s\S]*None/);
  });
});
