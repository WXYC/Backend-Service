/**
 * Guards for `deleteArtistFromDB` in `apps/backend/services/library.service.ts`
 * (BS#2562) — the second endpoint in this repo that destroys catalog rows,
 * mirroring `deleteAlbumFromDB` (BS#2112) over a much smaller dependent set.
 * Findings pinned here:
 *
 *  1. **One lock covers every dependent, because every FK targeting
 *     `artists.id` takes `FOR KEY SHARE` on that row for its own insert
 *     check.** Unlike `deleteAlbumFromDB`, which locks `rotation` a second
 *     time to fence a depth-2 grandchild capture, this transaction never
 *     locks anything but the `artists` row itself — both snapshot children
 *     here are depth-1.
 *  2. **The four refusals check in the servlet's own order, and stop at the
 *     first non-zero count.** Reusing `getArtistDependentCounts` (BS#2597)
 *     rather than a second implementation of the same predicates.
 *  3. **`compilation_credit_count` never refuses.** It is read by
 *     `getArtistDependentCounts` but never consulted by the refusal chain.
 *  4. **`genre_artist_crossreference` is deleted in full, before the artist
 *     row** — its FK carries no `onDelete`, and `artist_genre_key` is unique
 *     on `(artist_id, genre_id)`, not `artist_id` alone, so a multi-genre
 *     artist holds more than one row.
 *  5. **The snapshot is captured before any delete statement runs**, scoped
 *     to exactly the two dependents this transaction resolves.
 *  6. **Lock waits are bounded, and the delete is the side that yields** —
 *     same `lock_timeout`-below-`deadlock_timeout` mechanism as the album
 *     delete.
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, addBreadcrumb: jest.fn() };
});

import * as fs from 'fs';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import {
  artists,
  captureCatalogDeleteSnapshot,
  compilation_track_artist,
  db,
  genre_artist_crossreference,
} from '@wxyc/database';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/library.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const deleteArtistBody = (): string => {
  const match = serviceSource.match(/const runDeleteArtistTransaction[\s\S]*?\n\};/);
  if (!match) throw new Error('runDeleteArtistTransaction not found in library.service.ts');
  return match[0];
};

type RecordedOp = { op: string; table: unknown; methods: string[]; arg?: unknown };

type ArtistDependentCountsFixture = {
  release_count: number;
  cross_reference_source_count: number;
  cross_reference_target_count: number;
  library_cross_reference_count: number;
  compilation_credit_count: number;
};

const ZERO_COUNTS: ArtistDependentCountsFixture = {
  release_count: 0,
  cross_reference_source_count: 0,
  cross_reference_target_count: 0,
  library_cross_reference_count: 0,
  compilation_credit_count: 0,
};

/**
 * Minimal drizzle-shaped transaction double, structurally the same idiom as
 * `library.deleteAlbum.test.ts`'s `makeTx` — but with a SECOND queue for
 * `.execute()` calls, because this transaction's refusal predicates run
 * through `getArtistDependentCounts`'s raw `tx.execute(sql\`...\`)`, not
 * through the `.select()` builder chain the existence check uses. The album
 * double's `execute` always resolves `[]`, which is fine there (it only ever
 * runs `SET LOCAL`) but would silently break every refusal-order test here.
 */
const makeTx = (
  options: { existing?: unknown[]; counts?: Partial<ArtistDependentCountsFixture> } = {},
  throwOn?: { op: string; error: unknown }
) => {
  const ops: RecordedOp[] = [];
  const existing = options.existing ?? [{ id: 42 }];
  const counts = { ...ZERO_COUNTS, ...options.counts };
  const executeResults: unknown[][] = [[], [counts]]; // [0] SET LOCAL (unused), [1] counts query
  const selectResults: unknown[][] = [existing];
  let selectIndex = 0;
  let executeIndex = 0;

  const start = (op: string, table: unknown) => {
    const record: RecordedOp = { op, table, methods: [] };
    ops.push(record);
    if (throwOn && throwOn.op === op) {
      throw throwOn.error;
    }

    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit']) {
      chain[method] = (arg: unknown) => {
        record.methods.push(method);
        if (method === 'from') record.table = arg;
        return chain;
      };
    }
    chain.for = (mode: string) => {
      record.methods.push(`for(${mode})`);
      return chain;
    };
    chain.then = (resolve: (value: unknown) => void) => {
      resolve(op === 'select' ? (selectResults[selectIndex++] ?? []) : []);
    };
    return chain;
  };

  return {
    ops,
    tx: {
      select: () => start('select', undefined),
      delete: (table: unknown) => start('delete', table),
      execute: (arg: unknown) => {
        const record: RecordedOp = { op: 'execute', table: undefined, methods: [], arg };
        ops.push(record);
        if (throwOn && throwOn.op === 'execute') {
          throw throwOn.error;
        }
        return Promise.resolve(executeResults[executeIndex++] ?? []);
      },
    },
  };
};

const loadService = async () => import('../../../apps/backend/services/library.service');

type Actor = { userId?: string | null; email?: string | null; role?: string | null };

const runDelete = async (
  artistId: number,
  options: {
    existing?: unknown[];
    counts?: Partial<ArtistDependentCountsFixture>;
    actor?: Actor;
    throwOn?: { op: string; error: unknown };
  } = {}
) => {
  const { ops, tx } = makeTx({ existing: options.existing, counts: options.counts }, options.throwOn);
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const { deleteArtistFromDB } = await loadService();
  const outcome = await deleteArtistFromDB(artistId, options.actor);
  return { outcome, ops };
};

/** Args handed to the (mocked) `captureCatalogDeleteSnapshot` — see `library.deleteAlbum.test.ts`'s `captureArgs`. */
const captureArgs = () => {
  const capture = captureCatalogDeleteSnapshot as unknown as {
    mock: {
      calls: Array<[unknown, { entityIdColumn: unknown; entityId: unknown; children: unknown[]; actor?: unknown }]>;
    };
  };
  return capture.mock.calls[0]?.[1];
};

const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const drizzleWrapped = (cause: Error): Error => Object.assign(new Error('Failed query: <sql>\nparams: '), { cause });

describe('deleteArtistFromDB (BS#2562)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('row lock (finding 1)', () => {
    it('takes FOR UPDATE on the artists row as the only SELECT', async () => {
      const { ops } = await runDelete(42);

      const selects = ops.filter((o) => o.op === 'select');
      expect(selects).toHaveLength(1);
      expect(selects[0].table).toBe(artists);
      expect(selects[0].methods).toContain('for(update)');
    });

    it('pins FOR UPDATE rather than FOR NO KEY UPDATE in the source', () => {
      const body = deleteArtistBody();
      expect(body).toContain("for('update')");
      expect(body).not.toContain("for('no key update')");
    });

    it('takes no second lock -- one FOR UPDATE covers every dependent (see the docstring)', () => {
      const body = deleteArtistBody();
      expect(body.match(/for\('update'\)/g)).toHaveLength(1);
    });
  });

  describe('the four refusals, in order (finding 2)', () => {
    it('refuses on release_count first', async () => {
      const { outcome, ops } = await runDelete(42, { counts: { release_count: 3 } });

      expect(outcome).toEqual({ outcome: 'has_releases', count: 3 });
      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0);
      expect(captureCatalogDeleteSnapshot).not.toHaveBeenCalled();
    });

    it('refuses on cross_reference_source_count when releases are clean', async () => {
      const { outcome } = await runDelete(42, { counts: { cross_reference_source_count: 2 } });

      expect(outcome).toEqual({ outcome: 'has_crossreference_as_source', count: 2 });
    });

    it('refuses on cross_reference_target_count when source is clean', async () => {
      const { outcome } = await runDelete(42, { counts: { cross_reference_target_count: 1 } });

      expect(outcome).toEqual({ outcome: 'has_crossreference_as_target', count: 1 });
    });

    it('refuses on library_cross_reference_count last', async () => {
      const { outcome } = await runDelete(42, { counts: { library_cross_reference_count: 5 } });

      expect(outcome).toEqual({ outcome: 'has_library_crossreference', count: 5 });
    });

    it('reports only the FIRST refusal in the servlet order when several counts are non-zero', async () => {
      const { outcome } = await runDelete(42, {
        counts: { release_count: 1, cross_reference_source_count: 1, library_cross_reference_count: 1 },
      });

      expect(outcome).toEqual({ outcome: 'has_releases', count: 1 });
    });

    it('never refuses on compilation_credit_count (finding 3)', async () => {
      const { outcome } = await runDelete(42, { counts: { compilation_credit_count: 7 } });

      expect(outcome).toEqual({ outcome: 'deleted' });
    });

    it('deletes through when every count is zero', async () => {
      const { outcome, ops } = await runDelete(42);

      expect(outcome).toEqual({ outcome: 'deleted' });
      expect(ops.some((o) => o.op === 'delete' && o.table === artists)).toBe(true);
    });
  });

  describe('genre_artist_crossreference deleted in full (finding 4)', () => {
    it('deletes genre_artist_crossreference before the artist row', async () => {
      const { ops } = await runDelete(42);

      const genreDeleteIdx = ops.findIndex((o) => o.op === 'delete' && o.table === genre_artist_crossreference);
      const artistDeleteIdx = ops.findIndex((o) => o.op === 'delete' && o.table === artists);
      expect(genreDeleteIdx).toBeGreaterThanOrEqual(0);
      expect(artistDeleteIdx).toBeGreaterThan(genreDeleteIdx);
    });

    it('issues exactly two DELETE statements on a clean artist', async () => {
      const { ops } = await runDelete(42);

      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(2);
    });
  });

  describe('snapshot capture (finding 5)', () => {
    it('captures before either DELETE runs, scoped to the artist row plus its two resolved dependents', async () => {
      await runDelete(42, { actor: { userId: 'u1', email: 'md@wxyc.org', role: 'musicDirector' } });

      const args = captureArgs();
      expect(args.entityKind).toBe('artist');
      expect(args.entityId).toBe(42);
      expect(args.entityIdColumn).toBe(artists.id);
      expect(args.children).toEqual([genre_artist_crossreference.artist_id, compilation_track_artist.track_artist_id]);
      expect(args.actor).toEqual({ userId: 'u1', email: 'md@wxyc.org', role: 'musicDirector' });
    });

    it('never captures when a refusal fires first', async () => {
      await runDelete(42, { counts: { release_count: 1 } });

      expect(captureCatalogDeleteSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('bounded lock waits (finding 6)', () => {
    it('sets lock_timeout before taking any lock', async () => {
      const { ops } = await runDelete(42);

      expect(ops[0].op).toBe('execute');
      expect(JSON.stringify(ops[0].arg)).toContain('lock_timeout');
      expect(deleteArtistBody()).toContain("SET LOCAL lock_timeout = '${DELETE_ARTIST_LOCK_TIMEOUT_MS}ms'");
    });

    it('keeps the timeout below the default 1s deadlock_timeout', async () => {
      const { DELETE_ARTIST_LOCK_TIMEOUT_MS } = await loadService();
      expect(DELETE_ARTIST_LOCK_TIMEOUT_MS).toBeLessThan(1000);
      expect(DELETE_ARTIST_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it.each([
      ['55P03', 'lock_not_available -- our own lock_timeout fired'],
      ['40P01', 'deadlock_detected -- we were chosen as the victim'],
    ])('maps a drizzle-wrapped SQLSTATE %s to lock_unavailable rather than a 500', async (code) => {
      const error = drizzleWrapped(pgError(code, 'canceling statement due to lock timeout'));
      const { outcome } = await runDelete(42, { throwOn: { op: 'select', error } });

      expect(outcome).toEqual({ outcome: 'lock_unavailable' });
    });

    it.each([['55P03'], ['40P01']])(
      'stands down on a bare driver error too -- the wrapper is preferred, not required',
      async (code) => {
        const error = pgError(code, 'canceling statement due to lock timeout');
        const { outcome } = await runDelete(42, { throwOn: { op: 'select', error } });

        expect(outcome).toEqual({ outcome: 'lock_unavailable' });
      }
    );

    it('breadcrumbs the real SQLSTATE, not the wrapper’s undefined .code', async () => {
      const addBreadcrumb = Sentry.addBreadcrumb as jest.MockedFunction<typeof Sentry.addBreadcrumb>;
      const error = drizzleWrapped(pgError('55P03', 'canceling statement due to lock timeout'));

      await runDelete(42, { throwOn: { op: 'select', error } });

      expect(addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'library.delete',
          data: expect.objectContaining({ artist_id: 42, code: '55P03' }),
        })
      );
    });

    it('does not mistake an unrelated wrapped error for lock contention', async () => {
      const error = drizzleWrapped(pgError('23503', 'insert or update violates foreign key'));
      await expect(runDelete(42, { throwOn: { op: 'select', error } })).rejects.toThrow('Failed query');
    });

    it('rethrows any other database error', async () => {
      const error = Object.assign(new Error('boom'), { code: '23503' });
      await expect(runDelete(42, { throwOn: { op: 'select', error } })).rejects.toThrow('boom');
    });
  });

  it('returns not_found without taking any further action', async () => {
    const { outcome, ops } = await runDelete(999, { existing: [] });

    expect(outcome).toEqual({ outcome: 'not_found' });
    // The lock_timeout statement plus the existence check, and nothing else.
    expect(ops).toHaveLength(2);
    expect(captureCatalogDeleteSnapshot).not.toHaveBeenCalled();
  });

  it('still deletes when no actor is available', async () => {
    const { outcome } = await runDelete(42);

    expect(outcome).toEqual({ outcome: 'deleted' });
    // `deleteArtistFromDB`'s `actor` parameter defaults to `{}`, never
    // `undefined` -- a thin/missing token must never throw, only omit fields.
    expect(captureArgs().actor).toEqual({});
  });
});
