/**
 * Regression guards for `changeOrder` in `apps/backend/services/flowsheet.service.ts`.
 *
 * Background (#712):
 *
 * After #693 (`f71b3ef`) scoped `nextPlayOrder()` to per-show semantics,
 * inserts began writing low play_orders (1, 2, 3, ...) into multiple
 * concurrent shows. `changeOrder` was not converted in the same PR: its
 * two bump UPDATEs filtered only on the play_order range, with no
 * `eq(flowsheet.show_id, ...)` predicate, so reordering inside one show
 * would bump rows in *other* shows that happened to occupy the same
 * play_order values. The shape fixture (#701, `tests/fixtures/shape.sql`)
 * caught this when seemingly-unrelated tests poked show 7003's
 * play_orders 1..4 via cross-show reorders.
 *
 * Same function, latent sibling bug at the response-SELECT: it filtered
 * by `play_order = position_new`, which (post-#693) is no longer unique
 * across shows — postgres could surface a row from a different show.
 *
 * The mock-based 404 test below is the original guard. The source-grep
 * tests below it pin the cross-show isolation + response-correctness
 * fixes to the function body so a future refactor that drops the
 * `show_id` predicate or reverts the response SELECT trips immediately.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '@wxyc/database';
import { createMockQueryChain } from '../../mocks/database.mock';
import WxycError from '../../../apps/backend/utils/error';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/flowsheet.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const extractChangeOrderBody = (): string => {
  const match = serviceSource.match(/export const changeOrder[\s\S]*?\n\};/);
  if (!match) throw new Error('changeOrder not found in flowsheet.service.ts');
  return match[0];
};

describe('flowsheet.service', () => {
  describe('changeOrder', () => {
    it('throws WxycError with 404 when entry does not exist', async () => {
      const emptyChain = createMockQueryChain([]);
      // Make the chain thenable so `await trx.select().from().where().limit()` resolves
      (emptyChain as any).then = (resolve: (v: unknown) => void) => resolve([]);

      const mockTrx = {
        select: jest.fn().mockReturnValue(emptyChain),
        update: jest.fn().mockReturnValue(emptyChain),
      };

      (db as any).transaction = jest.fn().mockImplementation(async (cb: (trx: typeof mockTrx) => Promise<void>) => {
        return cb(mockTrx);
      });

      const { changeOrder } = await import('../../../apps/backend/services/flowsheet.service');

      await expect(changeOrder(999999, 1)).rejects.toThrow(WxycError);
      await expect(changeOrder(999999, 1)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('changeOrder cross-show isolation (#712)', () => {
    const body = extractChangeOrderBody();

    it('selects show_id alongside play_order so the bump UPDATEs can scope by show', () => {
      // Pre-#712 the SELECT only pulled play_order; show_id was never read,
      // so the bump UPDATEs had no value to scope by. The fix adds show_id
      // to the SELECT projection.
      expect(body).toMatch(/play_order:\s*flowsheet\.play_order/);
      expect(body).toMatch(/show_id:\s*flowsheet\.show_id/);
    });

    it("scopes the bump UPDATEs by the entry's show_id", () => {
      // The two range-bump UPDATEs (one for position_new < position_old,
      // one for position_new > position_old) must each include
      // `eq(flowsheet.show_id, show_id)` in their WHERE. Pre-#712 they
      // mutated rows in any show whose play_orders fell in the range.
      const bumpUpdates = body.match(/\.update\(flowsheet\)\s*\.set\(\{\s*play_order:\s*sql`play_order [+-] 1`/g);
      expect(bumpUpdates).not.toBeNull();
      expect(bumpUpdates && bumpUpdates.length).toBe(2);

      // Both range-bump UPDATEs must reference show_id in their WHERE.
      // Conservative shape match: `eq(flowsheet.show_id, show_id)` appears
      // at least twice in the function body.
      const showScopedPredicates = body.match(/eq\(flowsheet\.show_id,\s*show_id\)/g) || [];
      expect(showScopedPredicates.length).toBeGreaterThanOrEqual(2);
    });

    it('guards against a NULL show_id with a loud throw, not a silent skip', () => {
      // Every flowsheet row has show_id post-#693 (NOT NULL constraint),
      // but the schema type still allows null in TS land. Be loud, not
      // silent, if the invariant ever breaks.
      expect(body).toMatch(/show_id\s*==\s*null|show_id\s*===\s*null/);
      expect(body).toMatch(/throw new WxycError\([^)]*show_id/);
    });

    it('filters the response SELECT by entry id, not by play_order', () => {
      // Pre-#712 the response read `WHERE play_order = position_new
      // LIMIT 1`, which (post-#693) can return a row from a different
      // show whose per-show play_order happens to match. The fix uses
      // the entry's id, which is globally unique by construction.
      const responseSelect = body.match(/const response\s*=\s*await\s+db\.select\(\)[\s\S]*?\.limit\(1\);/);
      expect(responseSelect).not.toBeNull();
      const responseText = responseSelect ? responseSelect[0] : '';
      expect(responseText).toContain('eq(flowsheet.id, entry_id)');
      // The matched expression itself must not call eq() against play_order;
      // strip out the `db.select()` (which contains the column-list builder)
      // to assert the WHERE predicate explicitly.
      expect(responseText).not.toMatch(/eq\(flowsheet\.play_order/);
    });
  });
});
