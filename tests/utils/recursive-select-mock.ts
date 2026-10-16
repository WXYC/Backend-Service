/**
 * Join-depth-agnostic drizzle select-chain mock for the flowsheet SQL specs.
 *
 * Every builder method returns the chain, so adding a join to a read path does
 * not require renumbering fixed-depth `leftJoinMockN` scaffolding. The chain is
 * thenable and resolves to `[]`. The specs run real drizzle against the
 * `@wxyc/database` unit mock and inspect what the service handed to the builder.
 * (`render-sql.ts` is a different mechanism: it renders the manual mock's chunk
 * shapes.)
 */

import { jest } from '@jest/globals';
import { db } from '@wxyc/database';

export type LeftJoinCall = { table: unknown; on: unknown };

export interface RecursiveSelectMockCapture {
  /** The fields object passed to the most recent `db.select(...)`. */
  fieldsArg: unknown;
  /** Every `.leftJoin(table, on)` call, across all selects, in call order. */
  leftJoinCalls: LeftJoinCall[];
  /** The argument list of every `.orderBy(...)` call, in call order. */
  orderByCalls: unknown[][];
  /** How many times `db.select` was invoked. */
  selectCallCount: number;
}

export function installRecursiveSelectMock(): RecursiveSelectMockCapture {
  const capture: RecursiveSelectMockCapture = {
    fieldsArg: undefined,
    leftJoinCalls: [],
    orderByCalls: [],
    selectCallCount: 0,
  };

  const makeChain = () => {
    const c: Record<string, jest.Mock> = {};
    c.leftJoin = jest.fn().mockImplementation((table: unknown, on: unknown) => {
      capture.leftJoinCalls.push({ table, on });
      return c;
    });
    // BS#1960: getEntriesByPage's deferred-join rewrite adds an innerJoin
    // (bounded id-page -> flowsheet) ahead of the pre-existing leftJoins. Not
    // tracked in capture.leftJoinCalls, which is about the LEFT JOINs only.
    c.innerJoin = jest.fn().mockReturnValue(c);
    c.where = jest.fn().mockReturnValue(c);
    c.orderBy = jest.fn().mockImplementation((...args: unknown[]) => {
      capture.orderByCalls.push(args);
      return c;
    });
    c.offset = jest.fn().mockReturnValue(c);
    // Chain-returning, not terminal: getEntriesByPage's inner id-subquery
    // chains .limit(m).as('page') — .as needs a chain to call onto.
    c.limit = jest.fn().mockReturnValue(c);
    // Terminal for the id-subquery: returns a stand-in Subquery whose `.id`
    // is what the outer query's innerJoin predicate references.
    c.as = jest.fn().mockReturnValue({ id: 'mock-page-id' });
    // Drizzle terminal methods that may be awaited directly.
    c.then = jest.fn().mockImplementation((onFulfilled: (v: unknown) => unknown) => {
      return Promise.resolve([]).then(onFulfilled);
    });
    return c;
  };

  (db as unknown as { select: jest.Mock }).select = jest.fn().mockImplementation((fields: unknown) => {
    capture.fieldsArg = fields;
    capture.selectCallCount += 1;
    return { from: jest.fn().mockReturnValue(makeChain()) };
  });

  return capture;
}
