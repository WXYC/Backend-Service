/**
 * Unit tests for the album-reviews-etl mapping layer: header-based column
 * resolution (including the two-buzzwords trap), the M/D/YYYY H:MM:SS
 * America/New_York timestamp parse (DST-correct on both offsets), row
 * validity, the form:/nots: source_key scheme with its collision-proofed
 * reviewer-hash fallback, and the closed-vocabulary normalizations
 * (rotated / social_consent / released_within_six_months). Pure module —
 * no DB, no network.
 */
import { createHash } from 'node:crypto';
import { normalizeArtistName, normalizeAlbumTitle } from '@wxyc/database';
import {
  resolveHeaderIndexes,
  parseFormTimestamp,
  mapRow,
  type MappedRow,
} from '../../../../jobs/album-reviews-etl/map';

/** The live sheet's header layout (2026-07-16 CSV export shape): several
 *  dead columns (empty header, stray `122`), and the abandoned long-form
 *  buzzwords column with 0 responses sitting BEFORE the live short
 *  `Buzzwords` column. */
const HEADERS = [
  'Timestamp',
  'Artist Name',
  'Album Name',
  'Record Label',
  'Please write a short 1-2 sentences blurb about the artist',
  'Please write your review here',
  'Please identify at least 2 recommended tracks, and mark them with an !',
  'Name of reviewer, and date',
  'List any FCC violations by track number',
  'Buzzwords about the album (examples include: jangly, ethereal, lo-fi)', // dead long-form (0 responses)
  'Buzzwords', // live
  'Are you comfortable with us posting excerpts from this review on social media?',
  'Was this album released in the last 6 months?',
  'What is this review for?',
  'rotated? (y/n)',
  '', // dead empty header
  '122', // stray header
];

type FieldName =
  | 'timestamp'
  | 'artist'
  | 'album'
  | 'label'
  | 'blurb'
  | 'review'
  | 'tracks'
  | 'reviewer'
  | 'fcc'
  | 'deadBuzzwords'
  | 'buzzwords'
  | 'consent'
  | 'sixMonths'
  | 'purpose'
  | 'rotated';

const FIELD_COLUMN: Record<FieldName, number> = {
  timestamp: 0,
  artist: 1,
  album: 2,
  label: 3,
  blurb: 4,
  review: 5,
  tracks: 6,
  reviewer: 7,
  fcc: 8,
  deadBuzzwords: 9,
  buzzwords: 10,
  consent: 11,
  sixMonths: 12,
  purpose: 13,
  rotated: 14,
};

const makeRow = (overrides: Partial<Record<FieldName, string>> = {}): string[] => {
  const row = new Array<string>(HEADERS.length).fill('');
  const defaults: Partial<Record<FieldName, string>> = {
    timestamp: '7/15/2021 14:05:33',
    artist: 'Juana Molina',
    album: 'DOGA',
    label: 'Sonamos',
    blurb: 'Argentine electro-folk auteur.',
    review: 'A late-night marvel; loops that breathe.',
    tracks: '!1, 4, !7',
    reviewer: 'DJ Ana, 7/15/21',
    buzzwords: 'hypnotic, warm',
    consent: 'Yes',
    sixMonths: 'Yes',
    purpose: 'New release review',
    rotated: 'y',
  };
  for (const [field, value] of Object.entries({ ...defaults, ...overrides })) {
    row[FIELD_COLUMN[field as FieldName]] = value;
  }
  return row;
};

const headers = resolveHeaderIndexes(HEADERS);

const expectValid = (mapped: MappedRow): Extract<MappedRow, { kind: 'valid' }> => {
  expect(mapped.kind).toBe('valid');
  return mapped as Extract<MappedRow, { kind: 'valid' }>;
};

describe('resolveHeaderIndexes', () => {
  it('resolves every live column by case-insensitive distinctive prefix', () => {
    expect(headers.timestamp).toBe(0);
    expect(headers.artist).toBe(1);
    expect(headers.album).toBe(2);
    expect(headers.record_label).toBe(3);
    expect(headers.artist_blurb).toBe(4);
    expect(headers.review).toBe(5);
    expect(headers.recommended_tracks).toBe(6);
    expect(headers.reviewer).toBe(7);
    expect(headers.fcc_violations).toBe(8);
    expect(headers.social_consent).toBe(11);
    expect(headers.released_within_six_months).toBe(12);
    expect(headers.review_purpose).toBe(13);
    expect(headers.rotated).toBe(14);
  });

  it('resolves Buzzwords by EXACT match, skipping the dead long-form buzzwords column (the two-buzzwords trap)', () => {
    expect(headers.buzzwords).toBe(FIELD_COLUMN.buzzwords);
    expect(headers.buzzwords).not.toBe(FIELD_COLUMN.deadBuzzwords);
  });

  it('still skips the dead long-form column when it sorts AFTER the live Buzzwords column', () => {
    const swapped = [...HEADERS];
    [swapped[FIELD_COLUMN.deadBuzzwords], swapped[FIELD_COLUMN.buzzwords]] = [
      swapped[FIELD_COLUMN.buzzwords],
      swapped[FIELD_COLUMN.deadBuzzwords],
    ];
    const resolved = resolveHeaderIndexes(swapped);
    expect(resolved.buzzwords).toBe(FIELD_COLUMN.deadBuzzwords); // where the live header moved to
  });

  it('is tolerant of column reorder and future additions', () => {
    const reordered = ['A brand new future column', ...[...HEADERS].reverse()];
    const resolved = resolveHeaderIndexes(reordered);
    expect(reordered[resolved.timestamp]).toBe('Timestamp');
    expect(reordered[resolved.artist]).toBe('Artist Name');
    expect(reordered[resolved.rotated]).toBe('rotated? (y/n)');
  });

  it('matches headers case-insensitively', () => {
    const lowered = HEADERS.map((h) => h.toLowerCase());
    const resolved = resolveHeaderIndexes(lowered);
    expect(resolved.timestamp).toBe(0);
    expect(resolved.artist).toBe(1);
    expect(resolved.buzzwords).toBe(FIELD_COLUMN.buzzwords);
  });

  it.each([
    ['Timestamp', FIELD_COLUMN.timestamp],
    ['Artist Name', FIELD_COLUMN.artist],
    ['Album Name', FIELD_COLUMN.album],
    ['review body', FIELD_COLUMN.review],
  ])('throws when the required %s header is missing', (_label, column) => {
    const mutilated = [...HEADERS];
    mutilated[column] = 'Some Unrelated Header';
    expect(() => resolveHeaderIndexes(mutilated)).toThrow(/header/i);
  });

  it('leaves optional columns null when absent (future sheet slimming must not crash the run)', () => {
    const minimal = ['Timestamp', 'Artist Name', 'Album Name', 'Please write your review here'];
    const resolved = resolveHeaderIndexes(minimal);
    expect(resolved.record_label).toBeNull();
    expect(resolved.buzzwords).toBeNull();
    expect(resolved.rotated).toBeNull();
  });
});

describe('parseFormTimestamp (wall-clock America/New_York, DST-correct)', () => {
  it('parses an EDT sample at UTC-4', () => {
    expect(parseFormTimestamp('7/15/2021 14:05:33')).toEqual(new Date('2021-07-15T18:05:33Z'));
  });

  it('parses an EST sample at UTC-5', () => {
    expect(parseFormTimestamp('1/15/2022 14:05:33')).toEqual(new Date('2022-01-15T19:05:33Z'));
  });

  it('parses unpadded month/day/hour (the sheet locale emits M/D/YYYY H:MM:SS)', () => {
    expect(parseFormTimestamp('3/2/2021 9:07:01')).toEqual(new Date('2021-03-02T14:07:01Z'));
  });

  it.each([[''], ['B1163='], ['not a date'], ['13/45/2021 99:99:99'], ['2021-07-15 14:05:33'], ['2/30/2021 10:00:00']])(
    'returns null on unparseable input %p',
    (raw) => {
      expect(parseFormTimestamp(raw)).toBeNull();
    }
  );
});

describe('mapRow — validity', () => {
  it('rejects a row with no artist (the B1163= junk-row case)', () => {
    const mapped = mapRow(makeRow({ timestamp: 'B1163=', artist: '', album: '' }), headers);
    expect(mapped.kind).toBe('invalid');
  });

  it.each([
    ['artist', { artist: '   ' }],
    ['album', { album: '' }],
  ])('rejects a row with a blank %s', (_field, overrides: Partial<Record<FieldName, string>>) => {
    expect(mapRow(makeRow(overrides), headers).kind).toBe('invalid');
  });

  it('accepts a row that is short of the header width (ragged rows are right-padded upstream, but map stays defensive)', () => {
    const short = makeRow().slice(0, FIELD_COLUMN.review + 1);
    const mapped = expectValid(mapRow(short, headers));
    expect(mapped.content.artist_name).toBe('Juana Molina');
    expect(mapped.content.buzzwords).toBeNull();
  });
});

describe('mapRow — field mapping', () => {
  it('maps the raw form fields verbatim (trimmed; blank stores null, not empty string)', () => {
    const mapped = expectValid(mapRow(makeRow({ fcc: '', label: '  Sonamos  ' }), headers));
    expect(mapped.content).toMatchObject({
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      record_label: 'Sonamos',
      artist_blurb: 'Argentine electro-folk auteur.',
      review: 'A late-night marvel; loops that breathe.',
      recommended_tracks: '!1, 4, !7',
      buzzwords: 'hypnotic, warm',
      reviewer_raw: 'DJ Ana, 7/15/21',
      review_purpose: 'New release review',
    });
    // Blank ≠ "None": an unanswered FCC field must be null, never collapsed.
    expect(mapped.content.fcc_violations).toBeNull();
  });

  it('writes source: google_form explicitly (never relies on the column default)', () => {
    const mapped = expectValid(mapRow(makeRow(), headers));
    expect(mapped.content.source).toBe('google_form');
  });

  it('persists norm_artist/norm_album via the shared normalizers', () => {
    const mapped = expectValid(
      mapRow(makeRow({ artist: 'The Jessica Pratt', album: 'On Your Own Love Again (Deluxe Edition)' }), headers)
    );
    expect(mapped.content.norm_artist).toBe(normalizeArtistName('The Jessica Pratt'));
    expect(mapped.content.norm_album).toBe(normalizeAlbumTitle('On Your Own Love Again (Deluxe Edition)'));
  });

  it('parses submitted_at as the NY wall-clock instant', () => {
    const mapped = expectValid(mapRow(makeRow({ timestamp: '1/15/2022 14:05:33' }), headers));
    expect(mapped.content.submitted_at).toEqual(new Date('2022-01-15T19:05:33Z'));
  });
});

describe('mapRow — source_key', () => {
  it('keys on form:<ISO UTC> when the timestamp parses', () => {
    const mapped = expectValid(mapRow(makeRow({ timestamp: '7/15/2021 14:05:33' }), headers));
    expect(mapped.content.source_key).toBe('form:2021-07-15T18:05:33.000Z');
    expect(mapped.fallback_key).toBe(false);
  });

  it('falls back to nots:<norm_artist>:<norm_album>:<sha256[0:8](reviewer_raw)> on a missing timestamp, flagged for the warn log', () => {
    const mapped = expectValid(
      mapRow(makeRow({ timestamp: '', artist: 'Bianca Scout', album: 'The Heart of the Anchoress' }), headers)
    );
    const hash = createHash('sha256').update('DJ Ana, 7/15/21').digest('hex').slice(0, 8);
    expect(mapped.content.source_key).toBe(
      `nots:${normalizeArtistName('Bianca Scout')}:${normalizeAlbumTitle('The Heart of the Anchoress')}:${hash}`
    );
    expect(mapped.content.submitted_at).toBeNull();
    expect(mapped.fallback_key).toBe(true);
  });

  it('collision-proofs two distinct timestamp-less reviews of the same album via the reviewer hash', () => {
    const a = expectValid(mapRow(makeRow({ timestamp: '', reviewer: 'DJ Ana, 7/15/21' }), headers));
    const b = expectValid(mapRow(makeRow({ timestamp: '', reviewer: 'DJ Ras, 8/2/21' }), headers));
    expect(a.content.source_key).not.toBe(b.content.source_key);
  });

  it('excludes the review body from the fallback hash so curation edits still propagate as updates', () => {
    const before = expectValid(mapRow(makeRow({ timestamp: '', review: 'First draft.' }), headers));
    const after = expectValid(mapRow(makeRow({ timestamp: '', review: 'Edited draft with fixed typos.' }), headers));
    expect(before.content.source_key).toBe(after.content.source_key);
  });
});

describe('mapRow — closed-vocabulary normalization', () => {
  it.each<[string, boolean | null, boolean]>([
    ['y', true, false],
    ['Y', true, false],
    ['n', false, false],
    ['no', false, false],
    ['N/A - not in rotation', false, false], // n-prefixed family
    ['', null, false], // unanswered: null, NOT an anomaly
    ['maybe?', null, true], // drift: null + warn
  ])('rotated %p -> %p (warn: %p)', (raw, expected, warns) => {
    const mapped = expectValid(mapRow(makeRow({ rotated: raw }), headers));
    expect(mapped.content.rotated).toBe(expected);
    expect(mapped.warnings.some((w) => /rotated/i.test(w))).toBe(warns);
  });

  it.each<[string, boolean | null, boolean]>([
    ['Yes', true, false],
    ['yes!', true, false],
    ['Ok', true, false],
    ['ok, but please remove my name', true, false], // consent stays true — names are never shared regardless
    ['no', false, false],
    ['No', false, false],
    ['', null, false],
    ['ask me first', null, true],
  ])('social_consent %p -> %p (warn: %p)', (raw, expected, warns) => {
    const mapped = expectValid(mapRow(makeRow({ consent: raw }), headers));
    expect(mapped.content.social_consent).toBe(expected);
    expect(mapped.warnings.some((w) => /consent/i.test(w))).toBe(warns);
  });

  it('keeps the raw consent string verbatim alongside the normalized boolean', () => {
    const mapped = expectValid(mapRow(makeRow({ consent: 'ok, but please remove my name' }), headers));
    expect(mapped.content.social_consent_raw).toBe('ok, but please remove my name');
    expect(mapped.content.social_consent).toBe(true);
  });

  it.each<[string, boolean | null]>([
    ['Yes', true],
    ['no', false],
    ['', null],
    ['released last year I think', null],
  ])('released_within_six_months %p -> %p', (raw, expected) => {
    const mapped = expectValid(mapRow(makeRow({ sixMonths: raw }), headers));
    expect(mapped.content.released_within_six_months).toBe(expected);
  });
});
