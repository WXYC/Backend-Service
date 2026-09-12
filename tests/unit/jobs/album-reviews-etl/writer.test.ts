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
 *  3. Both the `set` object and the `setWhere` IS DISTINCT FROM arms are
 *     DERIVED from SET_CONTENT_COLUMNS (single source of truth) — the
 *     tests assert every member appears in both generated structures, and
 *     that the list itself equals the SubmissionContent shape minus the
 *     conflict key, so map/writer drift fails here.
 *  4. The `submitted_at` arm carries an explicit `::timestamptz` cast on
 *     its bound param (the BS#802 Date-through-raw-template trap).
 *  5. `xmax = 0` returning distinguishes inserted/updated; an empty
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

/**
 * The table every column in this writer's UPSERT belongs to. `tests/mocks/
 * database.mock.ts` maps each column to a table-qualified sentinel
 * (`'album_review_submissions.source_key'`), so the qualifier is what
 * distinguishes this table's `source` from `concerts.source` — see that
 * file's header for why the bare form could not.
 */
const MOCK_TABLE = 'album_review_submissions';

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

const upsertConfig = (): {
  target?: unknown;
  targetWhere?: unknown;
  set?: Record<string, unknown>;
  setWhere?: unknown;
} => mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as ReturnType<typeof upsertConfig>;

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
    // The mock maps each column to a TABLE-QUALIFIED sentinel, so this pins
    // the conflict target's table as well as its column name.
    expect(config.target).toBe(`${MOCK_TABLE}.source_key`);
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

  /** Collect the setWhere's IS DISTINCT FROM arms from the OR-reduction
   *  tree the writer builds. Handles both fragment shapes: the unit env's
   *  drizzle-orm stub tag ({ sql: strings, values }) and real drizzle
   *  (queryChunks). A leaf arm's first interpolation is the column, which
   *  the mock maps to a TABLE-QUALIFIED sentinel (`'<table>.<column>'`).
   *  `column` is recorded bare so the assertions below read as column
   *  lists; `qualifier` carries the table half, pinned separately by the
   *  arm-table assertion — that is what catches an arm built against the
   *  wrong table's column object, which a bare name cannot see. */
  const collectDistinctArms = (
    node: unknown,
    arms: Array<{ column: string; qualifier: string; text: string; values: unknown[] }> = []
  ) => {
    if (!node || typeof node !== 'object') return arms;
    const n = node as { sql?: readonly string[]; values?: unknown[]; queryChunks?: unknown[] };
    const text = Array.isArray(n.sql) ? n.sql.join('|') : '';
    if (text.includes('IS DISTINCT FROM')) {
      // The mock maps columns to qualified sentinel strings; anything else
      // is a fixture bug worth seeing verbatim in the assertion diff.
      const first = n.values?.[0];
      const sentinel = typeof first === 'string' ? first : JSON.stringify(first);
      const dot = sentinel.indexOf('.');
      arms.push({
        column: dot === -1 ? sentinel : sentinel.slice(dot + 1),
        qualifier: dot === -1 ? '' : sentinel.slice(0, dot),
        text,
        values: n.values ?? [],
      });
      return arms;
    }
    for (const child of [...(n.values ?? []), ...(n.queryChunks ?? [])]) collectDistinctArms(child, arms);
    return arms;
  };

  it('derives the setWhere guard from SET_CONTENT_COLUMNS: one IS DISTINCT FROM arm per member, nothing else', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const config = upsertConfig();
    expect(config.setWhere).toBeDefined();
    const arms = collectDistinctArms(config.setWhere);
    // Set equality with the single source of truth: a column dropped from
    // the derivation would freeze propagation of its sheet edits exactly
    // when ONLY that column changed; an extra one would churn last_modified.
    expect(arms.map((a) => a.column).sort()).toEqual([...SET_CONTENT_COLUMNS].sort());
    // Every arm is built from THIS table's column object, not a same-named
    // column on another table — invisible before the sentinels were qualified.
    expect([...new Set(arms.map((a) => a.qualifier))]).toEqual([MOCK_TABLE]);
    const armColumns = new Set(arms.map((a) => a.column));
    expect(armColumns.has('last_modified')).toBe(false);
    expect(armColumns.has('add_date')).toBe(false);
    expect(armColumns.has('album_id')).toBe(false);
  });

  it('casts the submitted_at arm param to timestamptz (BS#802 Date-binding trap) and ONLY that arm', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertSubmission(makeContent());

    const arms = collectDistinctArms(upsertConfig().setWhere);
    const cast = arms.filter((a) => a.text.includes('::timestamptz'));
    expect(cast.map((a) => a.column)).toEqual(['submitted_at']);
  });

  it('binds the submitted_at arm as an ISO string, never a raw Date (the cast alone is not enough)', async () => {
    // A param interpolated into a raw sql fragment bypasses the column
    // encoder (drizzle maps Date→string only for real column bindings), so
    // a JS Date here reaches postgres-js's unsafe() unserialized and blows
    // up at the driver boundary (ERR_INVALID_ARG_TYPE at Buffer.byteLength)
    // — the exact BS#802 trap, in its raw-fragment form. The integration
    // spec (tests/integration/album-reviews-writer.spec.js) binds through
    // postgres-js parameters, which DO serialize Dates, so it cannot
    // surface this; pinned here so the arm can never regress to binding
    // the Date object again.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    const content = makeContent();
    await upsertSubmission(content);

    const arms = collectDistinctArms(upsertConfig().setWhere);
    const submittedAtArm = arms.find((a) => a.column === 'submitted_at');
    if (!submittedAtArm) throw new Error('setWhere is missing the submitted_at arm');
    if (content.submitted_at == null) throw new Error('fixture row must carry a parsed timestamp');
    expect(submittedAtArm.values).toContain(content.submitted_at.toISOString());
    for (const value of submittedAtArm.values) {
      expect(value).not.toBeInstanceOf(Date);
    }
  });

  it('derives the set object from SET_CONTENT_COLUMNS: every member present with the mapped value', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    const content = makeContent();
    await upsertSubmission(content);

    const set = upsertConfig().set ?? {};
    for (const col of SET_CONTENT_COLUMNS) {
      expect(set).toHaveProperty(col, content[col]);
    }
  });

  it('pins the content-column list to the SubmissionContent shape minus the conflict key', () => {
    const contentKeys = Object.keys(makeContent()).filter((k) => k !== 'source_key');
    expect([...SET_CONTENT_COLUMNS].sort()).toEqual(contentKeys.sort());
  });
});
