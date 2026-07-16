/**
 * Unit tests for the album-reviews-etl writer. `db` is mocked via
 * `tests/mocks/database.mock.ts` (Jest module mapper); we inspect the
 * chain's `values` / `onConflictDoUpdate` invocations to pin the
 * writer-discipline invariants this job carries:
 *
 *  1. The UPSERT conflicts on `source_key` with the partial-index
 *     `targetWhere` (source_key IS NOT NULL) — the migration-0119 unique
 *     index is partial, so the conflict target must name its predicate.
 *  2. `add_date` (INSERT-only import anchor) and `album_id`
 *     (link-pass-owned — a sheet edit must never clobber a link) are
 *     OMITTED from the ON CONFLICT `set`.
 *  3. `setWhere` carries an IS DISTINCT FROM guard over exactly the
 *     content columns, so no-op nightly runs don't churn `last_modified`.
 *  4. `xmax = 0` returning distinguishes inserted/updated; an empty
 *     returning (setWhere suppressed the UPDATE) reports unchanged.
 */
import { db } from '@wxyc/database';
import { upsertSubmission, SET_CONTENT_COLUMNS } from '../../../../jobs/album-reviews-etl/writer';
import { mapRow, resolveHeaderIndexes, type SubmissionContent } from '../../../../jobs/album-reviews-etl/map';

type MockDb = typeof db & {
  _chain: {
    returning: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    values: jest.Mock;
    insert: jest.Mock;
  };
};

const mockDb = db as MockDb;

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
  'Buzzwords',
  'Are you comfortable with us posting excerpts from this review on social media?',
  'Was this album released in the last 6 months?',
  'What is this review for?',
  'rotated? (y/n)',
];

const makeContent = (): SubmissionContent => {
  const mapped = mapRow(
    [
      '7/15/2021 14:05:33',
      'Chuquimamani-Condori',
      'Edits',
      'self-released',
      'Bolivian-American electronic producer.',
      'Radiant, overloaded, devotional.',
      '!2, 3',
      'DJ Ana, 7/15/21',
      '',
      'maximal, joyous',
      'Yes',
      'Yes',
      'New release review',
      'y',
    ],
    resolveHeaderIndexes(HEADERS)
  );
  if (mapped.kind !== 'valid') throw new Error('fixture row must map valid');
  return mapped.content;
};

const upsertConfig = (): { target?: unknown; targetWhere?: unknown; set?: Record<string, unknown>; setWhere?: unknown } =>
  mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as ReturnType<typeof upsertConfig>;

/** Literal SQL text of a drizzle fragment, robust to both SQL-object
 *  shapes (donor idiom): real drizzle exposes queryChunks; the stub tag
 *  used by suites that mock drizzle-orm exposes `.sql`. */
const fragmentText = (frag: unknown): string => {
  const f = frag as { sql?: string | readonly string[]; queryChunks?: Array<{ value?: unknown }> };
  return f?.sql != null
    ? [f.sql].flat().join(' ')
    : (f?.queryChunks ?? []).flatMap((c) => (Array.isArray(c.value) ? (c.value as string[]) : [])).join(' ');
};

describe('upsertSubmission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns inserted on xmax = 0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: true }]);
    await expect(upsertSubmission(makeContent())).resolves.toEqual({
      inserted: true,
      updated: false,
      unchanged: false,
    });
  });

  it('returns updated on xmax != 0 (ON CONFLICT UPDATE fired)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: false }]);
    await expect(upsertSubmission(makeContent())).resolves.toEqual({
      inserted: false,
      updated: true,
      unchanged: false,
    });
  });

  it('returns unchanged when setWhere suppressed the no-op UPDATE (empty returning) — the idempotent-nightly invariant', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    await expect(upsertSubmission(makeContent())).resolves.toEqual({
      inserted: false,
      updated: false,
      unchanged: true,
    });
  });

  it('conflicts on source_key with the partial-index targetWhere (source_key IS NOT NULL)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const config = upsertConfig();
    expect(config.target).toBe('source_key'); // the mock table maps columns to their names
    expect(config.targetWhere).toBeDefined();
    expect(fragmentText(config.targetWhere)).toMatch(/IS NOT NULL/);
  });

  it('sets exactly the content columns plus last_modified — add_date, album_id and source_key are OMITTED from set', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const set = upsertConfig().set ?? {};
    expect(Object.keys(set).sort()).toEqual([...SET_CONTENT_COLUMNS, 'last_modified'].sort());
    expect(set).not.toHaveProperty('add_date');
    expect(set).not.toHaveProperty('album_id');
    expect(set).not.toHaveProperty('source_key');
    // last_modified refreshes via SQL now(), not a JS clock.
    expect(fragmentText(set.last_modified)).toMatch(/now\(\)/i);
  });

  it('omits add_date, album_id and id from the INSERT values too (DB defaults / link-pass-owned)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const values = mockDb._chain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('add_date');
    expect(values).not.toHaveProperty('album_id');
    expect(values).not.toHaveProperty('id');
    expect(values).toHaveProperty('source', 'google_form');
    expect(values).toHaveProperty('source_key', 'form:2021-07-15T18:05:33.000Z');
  });

  it('guards the UPDATE with an IS DISTINCT FROM check over every content column (no-op runs must not churn last_modified)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const config = upsertConfig();
    expect(config.setWhere).toBeDefined();
    const text = fragmentText(config.setWhere);
    // One IS DISTINCT FROM arm per content column — a column dropped from
    // the guard would freeze propagation of its sheet edits exactly when
    // ONLY that column changed.
    const arms = text.match(/IS DISTINCT FROM/g) ?? [];
    expect(arms).toHaveLength(SET_CONTENT_COLUMNS.length);
    expect(text).not.toMatch(/last_modified/);
    expect(text).not.toMatch(/add_date/);
    expect(text).not.toMatch(/album_id/);
  });

  it('pins the content-column list to the SubmissionContent shape minus the conflict key', () => {
    const contentKeys = Object.keys(makeContent()).filter((k) => k !== 'source_key');
    expect([...SET_CONTENT_COLUMNS].sort()).toEqual(contentKeys.sort());
  });
});
