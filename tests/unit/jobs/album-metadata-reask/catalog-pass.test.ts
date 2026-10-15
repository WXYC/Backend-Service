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

describe('catalogProbeSql', () => {
  const probe = flat(catalogProbeSql('run-1'));

  it('selects the same rows as the pass, and reads only', () => {
    expect(probe).toContain(flat(catalogPassSql('run-1')).split(' FOR UPDATE OF l')[0]);
    expect(probe).toMatch(/SELECT count\(\*\)::int AS n FROM hit$/);
    expect(probe).not.toMatch(/FOR UPDATE|INSERT|UPDATE "/);
  });
});

describe('runCatalogPass', () => {
  beforeEach(() => execute.mockReset());

  it.each([
    // [label, probe count, rows the write returns, statements sent after SET LOCAL, outcome]
    ['an empty probe sends nothing else', 0, null, ['probe'], { probed: 0, rewritten: 0 }],
    [
      'a probe with rows sends the write, then ANALYZE',
      2,
      2,
      ['probe', 'write', 'analyze'],
      { probed: 2, rewritten: 2 },
    ],
    // The rows moved between the probe and the write: nothing was written, so no ANALYZE.
    ['a write that matched nothing skips ANALYZE', 1, 0, ['probe', 'write'], { probed: 1, rewritten: 0 }],
  ])('%s', async (_label, probed, written, sent, outcome) => {
    execute.mockResolvedValueOnce([]); // SET LOCAL
    execute.mockResolvedValueOnce([{ n: probed }]);
    if (written !== null) {
      execute.mockResolvedValueOnce(Array.from({ length: written }, (_, i) => ({ id: i + 1 })));
    }
    execute.mockResolvedValue([]);

    expect(await runCatalogPass('run-1', 45_000)).toEqual(outcome);

    const statements = execute.mock.calls.map(([statement]) => flat(statement));
    const kinds = { probe: flat(catalogProbeSql('run-1')), write: flat(catalogPassSql('run-1')) };
    expect(statements).toEqual([
      "SET LOCAL statement_timeout = '45000ms'",
      ...sent.map((kind) =>
        kind === 'analyze' ? 'ANALYZE "wxyc_schema"."library"' : kinds[kind as 'probe' | 'write']
      ),
    ]);
  });

  it('runs the probe and the write in one transaction, under the 30 s default', async () => {
    execute.mockResolvedValue([{ n: 0 }]);

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
