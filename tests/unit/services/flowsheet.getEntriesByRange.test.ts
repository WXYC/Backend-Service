/**
 * Regression guard for `getEntriesByRange` in
 * `apps/backend/services/flowsheet.service.ts`.
 *
 * Background (#714):
 *
 * After #693 (`f71b3ef`) made `play_order` per-show, ordering the
 * result of an id-range fetch by `desc(flowsheet.play_order)` became
 * meaningless: the range filter is on `flowsheet.id`, which can span
 * multiple shows, so two rows in different shows are compared by
 * play_orders that are no longer globally comparable. The fix matches
 * the sibling `getEntriesByPage` function and orders by the globally
 * monotonic `flowsheet.id` instead.
 */

import * as fs from 'fs';
import * as path from 'path';

const servicePath = path.resolve(__dirname, '../../../apps/backend/services/flowsheet.service.ts');
const serviceSource = fs.readFileSync(servicePath, 'utf-8');

const extractGetEntriesByRangeBody = (): string => {
  const match = serviceSource.match(/export const getEntriesByRange[\s\S]*?\n\};/);
  if (!match) throw new Error('getEntriesByRange not found in flowsheet.service.ts');
  return match[0];
};

describe('flowsheet.service', () => {
  describe('getEntriesByRange ordering (#714)', () => {
    const body = extractGetEntriesByRangeBody();

    it('orders by flowsheet.id, not by play_order', () => {
      // Post-#693 play_order is per-show, so ordering an id-range fetch
      // (which can span shows) by play_order interleaves shows in a
      // meaningless order. The id column is globally monotonic and
      // matches the ordering used by `getEntriesByPage`.
      expect(body).toMatch(/\.orderBy\(desc\(flowsheet\.id\)\)/);
      expect(body).not.toMatch(/\.orderBy\(desc\(flowsheet\.play_order\)\)/);
    });
  });
});
