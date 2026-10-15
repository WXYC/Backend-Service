/**
 * The re-ask's catalog cover pass, as statements (BS#3146, tracker BS#3137 decision 4).
 *
 * The unit tier mocks `drizzle-orm`, so these pin the statements' text, their bound values and the order the pass
 * sends them in. That the pass rewrites only mirroring covers, skips a touched album, moves the catalog watermark
 * once and is a no-op the second time are claims about real rows: `tests/integration/album-metadata-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#3146
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { db } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import {
  CATALOG_STATEMENT_TIMEOUT_DEFAULT,
  catalogPassSql,
  catalogProbeSql,
  runCatalogPass,
} from '../../../../jobs/album-metadata-reask/catalog-pass';

const execute = db.execute as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const flat = (chunk: unknown): string => renderSql(chunk).replace(/\s+/g, ' ').trim();

describe('catalogPassSql', () => {
  const statement = flat(catalogPassSql('run-1'));

  it("reads only this run's album writes whose album is untouched since, and not yet passed", () => {
    expect(statement).toContain(
      `WHERE b.run_id = run-1::text AND b.target_table = 'album_metadata' AND am."updated_at" = b.written_at`
    );
    expect(statement).toContain(
      `NOT EXISTS (SELECT 1 FROM "wxyc_schema"."album_metadata_reask_backup" lb WHERE lb.run_id = b.run_id AND lb.target_table = 'library' AND lb.row_id = b.album_id)`
    );
  });

  it('locks the album_metadata row, so a write that commits meanwhile is re-checked on its latest version', () => {
    expect(statement).toContain(`lb.target_table = 'library' AND lb.row_id = b.album_id) FOR UPDATE OF am )`);
  });

  it('rewrites only a non-null catalog cover that equals the old cover and differs from the new one', () => {
    expect(statement).toContain(
      `WHERE l."artwork_url" IS NOT NULL AND l."artwork_url" = c.old_cover AND c.new_cover IS DISTINCT FROM l."artwork_url" FOR UPDATE OF l`
    );
  });

  it('writes the library backup rows in the same statement, and updates only the rows they back up', () => {
    expect(statement).toMatch(/backup AS \( INSERT INTO "wxyc_schema"\."album_metadata_reask_backup"/);
    expect(statement).toContain(
      `SELECT run-1::text, 'library', h.id, h.id, jsonb_build_object('artwork_url', h.prior_cover), jsonb_build_object('artwork_url', h.new_cover), h.provenance, NOW()`
    );
    expect(statement).toContain(
      `UPDATE "wxyc_schema"."library" l SET "artwork_url" = h.new_cover FROM hit h JOIN backup bk ON bk.row_id = h.id WHERE l."id" = h.id RETURNING l."id"`
    );
  });
});

const SET_LOCAL = "SET LOCAL statement_timeout = '45000ms'";
const ANALYZE = 'ANALYZE "wxyc_schema"."library"';

describe('catalogProbeSql', () => {
  const probe = flat(catalogProbeSql('run-1'));

  it('selects the same rows as the pass without locking them, and reads only', () => {
    const unlocked = flat(catalogPassSql('run-1')).replace(' FOR UPDATE OF am', '').split(' FOR UPDATE OF l')[0];
    expect(probe).toContain(unlocked);
    expect(probe).not.toMatch(/FOR UPDATE|INSERT|UPDATE "/);
  });

  it("counts the run's album writes beside the covers, so a run_id with none is visible", () => {
    expect(probe).toMatch(
      /SELECT \(SELECT count\(\*\)::int FROM "wxyc_schema"\."album_metadata_reask_backup" w WHERE w\.run_id = run-1::text AND w\.target_table = 'album_metadata'\) AS album_writes, count\(\*\)::int AS n FROM hit$/
    );
  });
});

describe('runCatalogPass', () => {
  beforeEach(() => {
    execute.mockReset();
    (db.transaction as unknown as jest.Mock).mockClear();
  });

  const probe = (albumWrites: number, n: number) => [{ album_writes: albumWrites, n }];
  const ids = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
  const result = (album_writes: number, probed: number, rewritten: number, analyze_error: string | null = null) => ({
    album_writes,
    probed,
    rewritten,
    analyze_error,
  });

  it.each([
    // [label, responses after SET LOCAL, statements sent, outcome]
    ['a run with no album writes sends nothing else', [probe(0, 0)], [SET_LOCAL, 'probe'], result(0, 0, 0)],
    ['an empty probe sends nothing else', [probe(3, 0)], [SET_LOCAL, 'probe'], result(3, 0, 0)],
    [
      'a probe with rows sends the write, then ANALYZE in its own transaction',
      [probe(3, 2), ids(2), [], []],
      [SET_LOCAL, 'probe', 'write', SET_LOCAL, ANALYZE],
      result(3, 2, 2),
    ],
    // The rows moved between the probe and the write: nothing was written, so no ANALYZE.
    [
      'a write that matched nothing skips ANALYZE',
      [probe(3, 1), ids(0)],
      [SET_LOCAL, 'probe', 'write'],
      result(3, 1, 0),
    ],
  ])('%s', async (_label, responses, sent, outcome) => {
    execute.mockResolvedValueOnce([]); // SET LOCAL
    for (const response of responses) {
      execute.mockResolvedValueOnce(response);
    }

    expect(await runCatalogPass('run-1', 45_000)).toEqual(outcome);

    const kinds: Record<string, string> = {
      probe: flat(catalogProbeSql('run-1')),
      write: flat(catalogPassSql('run-1')),
    };
    expect(execute.mock.calls.map(([statement]) => flat(statement))).toEqual(sent.map((s) => kinds[s] ?? s));
  });

  it('reports a failed ANALYZE instead of throwing: the rewrite and its backups have already committed', async () => {
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(probe(3, 2))
      .mockResolvedValueOnce(ids(2))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

    expect(await runCatalogPass('run-1', 45_000)).toEqual(
      result(3, 2, 2, 'canceling statement due to statement timeout')
    );
  });

  it('runs the probe and the write in one transaction, under the 30 s default', async () => {
    execute.mockResolvedValue(probe(0, 0));

    await runCatalogPass('run-1');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(CATALOG_STATEMENT_TIMEOUT_DEFAULT).toBe(30_000);
    expect(flat(execute.mock.calls[0][0])).toBe("SET LOCAL statement_timeout = '30000ms'");
  });

  it.each([0, -1, 1.5])('refuses a statement timeout of %p before sending anything', async (timeout) => {
    await expect(runCatalogPass('run-1', timeout)).rejects.toThrow('statement timeout');
    expect(execute).not.toHaveBeenCalled();
  });
});
