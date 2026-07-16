/**
 * Unit tests for the album-reviews read service (album-reviews-sheet-sync
 * plan / ADR 0011).
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
import { and, eq } from 'drizzle-orm';
import { album_review_submissions, db, normalizeArtistName } from '@wxyc/database';
import {
  AlbumReviewDTO,
  AlbumReviewRow,
  getAlbumReviewsCount,
  getAlbumReviewsPage,
  toAlbumReviewDTO,
} from '../../../apps/backend/services/album-reviews.service';

/**
 * Compile-time pin: `AlbumReviewDTO` must match the SSOT `AlbumReview`
 * schema in `wxyc-shared/api.yaml` (the album-review contract PR,
 * wxyc-shared#230). The published `@wxyc/shared` at this worktree's pin
 * does not yet export an `AlbumReview` DTO, so we assert against a
 * hand-mirrored shape derived from the api.yaml schema. When
 * `@wxyc/shared` publishes `AlbumReview`, replace `ApiYamlAlbumReview`
 * below with `import type { AlbumReview } from '@wxyc/shared/dtos'` — the
 * two-way `Equal` assertion then fails loudly if the local alias drifts
 * from the SSOT (`submitted_at` a nullable date-time string, the three
 * normalized flags nullable booleans, everything free-text nullable).
 */
type ApiYamlAlbumReview = {
  id: number;
  album_id: number | null;
  artist_name: string | null;
  album_title: string | null;
  record_label: string | null;
  artist_blurb: string | null;
  review: string | null;
  recommended_tracks: string | null;
  buzzwords: string | null;
  fcc_violations: string | null;
  review_purpose: string | null;
  rotated: boolean | null;
  released_within_six_months: boolean | null;
  social_consent: boolean | null;
  submitted_at: string | null;
};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Fails to compile if AlbumReviewDTO and the api.yaml-derived shape diverge
// in either direction (extra key, missing key, or type mismatch).
type _AlbumReviewDtoMatchesSsot = Expect<Equal<AlbumReviewDTO, ApiYamlAlbumReview>>;
// Reference the alias so `noUnusedLocals`/lint keep the assertion live.
const _albumReviewDtoTypeGuard: _AlbumReviewDtoMatchesSsot = true;

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };

/** Columns that must NEVER appear in the projection or on the wire.
 *  reviewer_raw/social_consent_raw are the PII pair the form's "your name
 *  will not be shared" promise protects; the rest are internal ETL
 *  bookkeeping. */
const PII_COLUMNS = ['reviewer_raw', 'social_consent_raw'];
const INTERNAL_COLUMNS = [...PII_COLUMNS, 'source', 'source_key', 'norm_artist', 'norm_album', 'add_date', 'last_modified'];

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

describe('AlbumReviewDTO structural pin', () => {
  it('matches the api.yaml-derived AlbumReview shape (compile-time assertion)', () => {
    // The real check is the `_AlbumReviewDtoMatchesSsot` type above, which
    // fails to compile on drift; this keeps a runtime reference to the guard.
    expect(_albumReviewDtoTypeGuard).toBe(true);
  });
});

describe('toAlbumReviewDTO', () => {
  it('serializes the submitted_at instant to an ISO-8601 string (SSOT date-time shape)', () => {
    const dto = toAlbumReviewDTO(timestampedRow);
    expect(dto.submitted_at).toBe('2026-03-15T17:45:12.000Z');
    expect(typeof dto.submitted_at).toBe('string');
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
    expect(whereArg).toEqual(and(eq(album_review_submissions.norm_artist, 'stereolab')));
  });

  it('applies the album_id filter as an exact match', async () => {
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));

    await getAlbumReviewsPage({ album_id: 7042 }, 50, 0);

    const whereArg = mockDb._chain.where.mock.calls[0][0] as unknown;
    expect(whereArg).toEqual(and(eq(album_review_submissions.album_id, 7042)));
  });

  it('passes no WHERE clause when there are no filters', async () => {
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([]));

    await getAlbumReviewsPage({}, 50, 0);

    expect(mockDb._chain.where.mock.calls[0][0]).toBeUndefined();
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
      and(eq(album_review_submissions.album_id, 7042), eq(album_review_submissions.norm_artist, 'cat power'))
    );
  });
});
