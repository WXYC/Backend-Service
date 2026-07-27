/**
 * Unit tests for album-critic-reviews-etl's writer.ts (BS#1830). Mirrors
 * `tests/unit/jobs/album-reviews-etl/writer.test.ts`'s structure: `db` is
 * mocked via `tests/mocks/database.mock.ts`, and we inspect the chain's
 * `values`/`onConflictDoUpdate` invocations to pin the writer-discipline
 * invariants:
 *
 *  1. UPSERT conflicts on `(album_id, source_url)` — the real unique index
 *     from migration 0125 (`album_critic_reviews_album_id_source_url_uq`).
 *  2. `set` and `setWhere` are both DERIVED from SET_CONTENT_COLUMNS (single
 *     source of truth) — a column dropped from the list would freeze that
 *     column's propagation on unchanged-row reruns; an extra one would churn
 *     `last_modified`.
 *  3. `xmax = 0` returning distinguishes inserted/updated; an empty
 *     returning (setWhere suppressed the UPDATE) reports unchanged.
 */
import { db } from '@wxyc/database';
import { upsertRow, SET_CONTENT_COLUMNS } from '../../../../jobs/album-critic-reviews-etl/writer';
import type { album_critic_reviews } from '@wxyc/database';

type MockDb = typeof db & {
  _chain: {
    returning: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    values: jest.Mock;
    insert: jest.Mock;
  };
};

const mockDb = db as MockDb;

const makeRow = (): typeof album_critic_reviews.$inferInsert => ({
  album_id: 42,
  source: 'The Quietus',
  source_url: 'https://thequietus.com/reviews/jessica-pratt/',
  snippet: 'A remarkable, hazy record.',
  author: 'Philip Sherburne',
  published_at: '2024-09-30',
  rating: '8/10',
  discogs_release_id: null,
  source_key: 'manifest:The Quietus',
});

const upsertConfig = (): {
  target?: unknown;
  set?: Record<string, unknown>;
  setWhere?: unknown;
} => mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as ReturnType<typeof upsertConfig>;

const fragmentText = (frag: unknown): string => {
  const f = frag as { sql?: string | readonly string[]; queryChunks?: Array<{ value?: unknown }> };
  return f?.sql != null
    ? [f.sql].flat().join(' ')
    : (f?.queryChunks ?? []).flatMap((c) => (Array.isArray(c.value) ? (c.value as string[]) : [])).join(' ');
};

describe('upsertRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns inserted on xmax = 0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: true }]);
    await expect(upsertRow(makeRow())).resolves.toEqual({ inserted: true, updated: false, unchanged: false });
  });

  it('returns updated on xmax != 0 (ON CONFLICT UPDATE fired)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: false }]);
    await expect(upsertRow(makeRow())).resolves.toEqual({ inserted: false, updated: true, unchanged: false });
  });

  it('returns unchanged when setWhere suppressed the no-op UPDATE (empty returning)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    await expect(upsertRow(makeRow())).resolves.toEqual({ inserted: false, updated: false, unchanged: true });
  });

  it('conflicts on (album_id, source_url)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const config = upsertConfig();
    expect(config.target).toEqual(['album_id', 'source_url']);
  });

  it('sets exactly the content columns plus last_modified', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const set = upsertConfig().set ?? {};
    expect(Object.keys(set).sort()).toEqual([...SET_CONTENT_COLUMNS, 'last_modified'].sort());
    expect(fragmentText(set.last_modified)).toMatch(/now\(\)/i);
  });

  it('values() carries the full insert row, including album_id and source_url', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const values = mockDb._chain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toMatchObject(makeRow());
  });

  const collectDistinctArms = (
    node: unknown,
    arms: Array<{ column: string; text: string }> = []
  ): Array<{ column: string; text: string }> => {
    if (!node || typeof node !== 'object') return arms;
    const n = node as { sql?: readonly string[]; values?: unknown[]; queryChunks?: unknown[] };
    const text = Array.isArray(n.sql) ? n.sql.join('|') : '';
    if (text.includes('IS DISTINCT FROM')) {
      const first = n.values?.[0];
      arms.push({ column: typeof first === 'string' ? first : JSON.stringify(first), text });
      return arms;
    }
    for (const child of [...(n.values ?? []), ...(n.queryChunks ?? [])]) collectDistinctArms(child, arms);
    return arms;
  };

  it('derives the setWhere guard from SET_CONTENT_COLUMNS: one IS DISTINCT FROM arm per member, nothing else', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const config = upsertConfig();
    expect(config.setWhere).toBeDefined();
    const arms = collectDistinctArms(config.setWhere);
    expect(arms.map((a) => a.column).sort()).toEqual([...SET_CONTENT_COLUMNS].sort());
    const armColumns = new Set(arms.map((a) => a.column));
    expect(armColumns.has('last_modified')).toBe(false);
    expect(armColumns.has('album_id')).toBe(false);
    expect(armColumns.has('source_url')).toBe(false);
    // discogs_release_id is INSERT-only — never refreshed, so never in setWhere.
    expect(armColumns.has('discogs_release_id')).toBe(false);
  });

  it('casts the published_at (date column) setWhere arm with ::date so the bound string keeps date typing', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const arms = collectDistinctArms(upsertConfig().setWhere);
    const publishedAtArm = arms.find((a) => a.column === 'published_at');
    expect(publishedAtArm).toBeDefined();
    expect(publishedAtArm?.text).toContain('::date');
  });

  it('excludes discogs_release_id from the conflict set (INSERT-only; owned by a future reconciliation pass)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow(makeRow());

    const set = upsertConfig().set ?? {};
    expect(Object.keys(set)).not.toContain('discogs_release_id');
  });

  it('still carries discogs_release_id in the INSERT values (insert-only, not update-suppressed)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertRow({ ...makeRow(), discogs_release_id: 999 });

    const values = mockDb._chain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.discogs_release_id).toBe(999);
  });

  it('pins the content-column list to the insert-row shape minus the conflict key and INSERT-only discogs_release_id', () => {
    const rowKeys = Object.keys(makeRow());
    expect([...SET_CONTENT_COLUMNS].sort()).toEqual(
      rowKeys.filter((k) => k !== 'album_id' && k !== 'source_url' && k !== 'discogs_release_id').sort()
    );
  });
});
