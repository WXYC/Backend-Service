/**
 * Unit tests for the album-reviews read service (ADR 0011 / the
 * dj-reviews-internal-surface plan).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts, so these pin
 * the pieces that don't need PostgreSQL:
 *   - `toAlbumReviewDTO` — ISO serialization of `submitted_at`, null
 *     passthrough, and (the PII leak barrier) the exact wire key set: no
 *     `reviewer_raw`, no `social_consent_raw`, no internal ETL columns.
 *   - The select projection never references the PII/internal columns, so
 *     they can't reach the response regardless of the mapper.
 *   - `buildWhere` parity: the page and count queries receive structurally
 *     identical WHERE trees for the same filters, and the artist filter is
 *     applied as `norm_artist = normalizeArtistName(param)`.
 *
 * Real SQL behavior (ordering NULLS LAST, filters, pagination) is covered
 * by tests/integration/album-reviews.spec.js.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { album_review_submissions, db, normalizeArtistName } from '@wxyc/database';
import {
  AlbumReviewDTO,
  AlbumReviewRow,
  getAlbumReviewsCount,
  getAlbumReviewsPage,
  toAlbumReviewDTO,
} from '../../../apps/backend/services/album-reviews.service';

/*
 * No compile-time SSOT pin lives here, on purpose.
 *
 * `AlbumReviewDTO` IS the generated `AlbumReview` (the service aliases the
 * `@wxyc/shared/dtos` export rather than mirroring it), so there is no
 * equality left to assert — identity is not drift-prone. The predecessor of
 * this file did assert it, against a hand-transcribed `ApiYamlAlbumReview`
 * literal, and that assertion was doubly inert: a transcription cannot detect
 * drift in the thing it transcribes, AND a type-level assertion in a test file
 * is checked by nothing here — `npm run typecheck` covers `apps/**` and
 * `shared/**` but not `tests/`, and ts-jest is transpile-only. Verified by
 * mutation: breaking the alias left this suite green.
 *
 * The envelope shape is pinned where it can fail, in
 * `controllers/album-reviews.controller.ts`, by typing the response body as
 * `AlbumReviewsResponse`.
 */

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };

/** Columns that must NEVER appear in the projection or on the wire.
 *  reviewer_raw/social_consent_raw are the PII pair the form's "your name
 *  will not be shared" promise protects; the rest are internal ETL
 *  bookkeeping. */
const PII_COLUMNS = ['reviewer_raw', 'social_consent_raw'];
const INTERNAL_COLUMNS = [
  ...PII_COLUMNS,
  'source',
  'source_key',
  'norm_artist',
  'norm_album',
  'add_date',
  'last_modified',
];

const WIRE_KEYS = [
  'id',
  'album_id',
  'artist_name',
  'album_title',
  'record_label',
  'artist_blurb',
  'review',
  'recommended_tracks',
  'buzzwords',
  'fcc_violations',
  'review_purpose',
  'rotated',
  'released_within_six_months',
  'social_consent',
  'submitted_at',
];

const timestampedRow: AlbumReviewRow = {
  id: 301,
  album_id: 7042,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  record_label: 'Sonamos',
  artist_blurb: 'Argentine electronic-folk auteur; ex-sitcom star turned loop-pedal visionary.',
  review: 'Hypnotic layered loops; a late-night staple. Play la paradoja first.',
  recommended_tracks: '1, 3 (!!!!), 5',
  buzzwords: 'hypnotic, electronic, folk',
  fcc_violations: 'None',
  review_purpose: 'Rotation',
  rotated: true,
  released_within_six_months: true,
  social_consent: true,
  submitted_at: new Date('2026-03-15T17:45:12.000Z'),
};

const nulledRow: AlbumReviewRow = {
  id: 302,
  album_id: null,
  artist_name: 'Jessica Pratt',
  album_title: 'On Your Own Love Again',
  record_label: null,
  artist_blurb: null,
  review: 'Whispered folk miniatures. Timeless.',
  recommended_tracks: null,
  buzzwords: null,
  fcc_violations: null,
  review_purpose: null,
  rotated: null,
  released_within_six_months: null,
  social_consent: null,
  submitted_at: null,
};

describe('toAlbumReviewDTO', () => {
  it('serializes the submitted_at instant to an ISO-8601 string (SSOT date-time shape)', () => {
    const dto = toAlbumReviewDTO(timestampedRow);
    expect(dto.submitted_at).toBe('2026-03-15T17:45:12.000Z');
  });

  it('passes nulls through for a sparse row (null submitted_at and flags)', () => {
    const dto = toAlbumReviewDTO(nulledRow);
    expect(dto.album_id).toBeNull();
    expect(dto.record_label).toBeNull();
    expect(dto.rotated).toBeNull();
    expect(dto.released_within_six_months).toBeNull();
    expect(dto.social_consent).toBeNull();
    expect(dto.submitted_at).toBeNull();
  });

  it('emits exactly the AlbumReview wire keys — no PII, no internal columns', () => {
    const dto = toAlbumReviewDTO(timestampedRow);
    expect(Object.keys(dto).sort()).toEqual([...WIRE_KEYS].sort());
    for (const internal of INTERNAL_COLUMNS) {
      expect(dto).not.toHaveProperty(internal);
    }
  });

  it('drops PII even when a wider row leaks extra properties into the mapper', () => {
    // The projection is the real barrier; this pins the second layer — the
    // mapper is an explicit field list, not a spread, so a row that somehow
    // carried reviewer_raw still cannot reach the wire.
    const leakyRow = {
      ...timestampedRow,
      reviewer_raw: 'A Real Name, 3/15/26',
      social_consent_raw: 'Yes, but remove my name',
    } as AlbumReviewRow;
    const dto = toAlbumReviewDTO(leakyRow);
    expect(dto).not.toHaveProperty('reviewer_raw');
    expect(dto).not.toHaveProperty('social_consent_raw');
  });
});

describe('getAlbumReviewsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('selects a projection that never references the PII or internal columns', async () => {
    // Terminal .offset() resolves the row set for this call.
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([timestampedRow]));

    const result = await getAlbumReviewsPage({}, 50, 0);

    expect(result).toEqual([toAlbumReviewDTO(timestampedRow)]);
    // The mocked table objects map each column to its name, so the
    // projection's values are column-name strings we can inspect.
    const projection = mockDb._chain.select.mock.calls[0][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
    // And it selects exactly the wire fields, keyed by their wire names.
    expect(Object.keys(projection).sort()).toEqual([...WIRE_KEYS].sort());
  });

  it('applies the artist filter as norm_artist = normalizeArtistName(param)', async () => {
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));

    await getAlbumReviewsPage({ artist: 'The Stereolab' }, 50, 0);

    const whereArg = mockDb._chain.where.mock.calls[0][0] as unknown;
    // normalizeArtistName lowercases and strips the leading "The ".
    expect(normalizeArtistName('The Stereolab')).toBe('stereolab');
    expect(whereArg).toEqual(
      and(isNotNull(album_review_submissions.review), eq(album_review_submissions.norm_artist, 'stereolab'))
    );
  });

  it('applies the album_id filter as an exact match', async () => {
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));

    await getAlbumReviewsPage({ album_id: 7042 }, 50, 0);

    const whereArg = mockDb._chain.where.mock.calls[0][0] as unknown;
    expect(whereArg).toEqual(
      and(isNotNull(album_review_submissions.review), eq(album_review_submissions.album_id, 7042))
    );
  });

  it('filters out bodyless rows even with no query filters (review IS NOT NULL floor)', async () => {
    // A submission with no review text is not a review — prod holds 2 such
    // rows of 1,689. The public attach carries the same predicate
    // (`album-metadata-lookup.service.ts`); without it here the endpoint
    // would contradict its own "1,687 rows with a body" framing.
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));

    await getAlbumReviewsPage({}, 50, 0);

    const whereArg = mockDb._chain.where.mock.calls[0][0] as unknown;
    expect(whereArg).toEqual(and(isNotNull(album_review_submissions.review)));
  });
});

describe('getAlbumReviewsCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the count from the first row', async () => {
    // Terminal .where() resolves the aggregate row for this call.
    mockDb._chain.where.mockReturnValueOnce(Promise.resolve([{ count: 42 }]));
    await expect(getAlbumReviewsCount({})).resolves.toBe(42);
  });

  it('returns 0 when the aggregate row is missing', async () => {
    mockDb._chain.where.mockReturnValueOnce(Promise.resolve([]));
    await expect(getAlbumReviewsCount({ album_id: 7042 })).resolves.toBe(0);
  });
});

describe('buildWhere parity (page vs count)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('page and count receive structurally identical WHERE trees for the same filters', async () => {
    const filters = { album_id: 7042, artist: 'Cat Power' };

    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));
    await getAlbumReviewsPage(filters, 50, 0);
    const pageWhere = mockDb._chain.where.mock.calls[0][0] as unknown;

    mockDb._chain.where.mockReturnValueOnce(Promise.resolve([{ count: 0 }]));
    await getAlbumReviewsCount(filters);
    const countWhere = mockDb._chain.where.mock.calls[1][0] as unknown;

    expect(pageWhere).toEqual(countWhere);
    expect(pageWhere).toEqual(
      and(
        isNotNull(album_review_submissions.review),
        eq(album_review_submissions.album_id, 7042),
        eq(album_review_submissions.norm_artist, 'cat power')
      )
    );
  });
});
