// WXYC/Backend-Service#2712 (rework, PR 1): the 'prefix' tier's predicate for
// the query's typing term, and which condition `findTypingTermIndex` selects
// as that typing term.
//
// `buildWhereClause(conditions, tier)` builds BYTE-IDENTICAL SQL to pre-#2712
// `main` for the 'word' tier (pinned by `search.service.seam-guard.test.ts`
// and `search.service.qualification.test.ts`, both reverted to their
// pre-rework expectations). This file is the 'prefix' tier's own coverage:
// its predicate is a SEPARATE, outer boolean CASE —
// `CASE WHEN strpos((E)::text, '<') = 0 THEN search_doc @@ P ELSE (search_doc
// @@ E AND gapped @@ E) END` — compiled only for the ONE condition
// `findTypingTermIndex` names, never for any other condition, and never at
// all in the 'word' tier.
//
// `searchFlowsheet`'s cascade tries 'word' first and only reaches 'prefix'
// when the 'word' tier's data page comes back empty (see
// search.service.cascade.test.ts for the cascade mechanics themselves) — so
// every test here mocks the 'word' tier empty (two calls) to force the
// cascade, then inspects the THIRD/FOURTH `db.execute` call, the 'prefix'
// tier's own data/count queries.
//
// Uses the real drizzle-orm `sql` tag (PgDialect) so bound parameter VALUES
// are inspectable. Mirrors search.service.seam-guard.test.ts.
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Compile the SQL text + bound params for the Nth db.execute call. */
const compiledExecuteCall = (n: number) => {
  const stmt = (db.execute as jest.Mock).mock.calls[n][0];
  return dialect.sqlToQuery(stmt);
};

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet } from '../../../apps/backend/services/search.service';

/** Mocks an empty, zero-count 'word' tier (forcing the cascade) followed by an empty 'prefix' tier. */
const mockEmptyWordThenPrefix = () => {
  (db.execute as jest.Mock)
    .mockResolvedValueOnce([]) // word data
    .mockResolvedValueOnce([{ total: 0 }]) // word count
    .mockResolvedValueOnce([]) // prefix data
    .mockResolvedValueOnce([{ total: 0 }]); // prefix count
};

describe("prefix tier: the typing term's predicate is one outer boolean CASE", () => {
  it('a single bare term compiles the outer CASE, with both the prefixed and exact lexeme params present', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(2);
    const lower = text.toLowerCase();

    expect(lower).toContain('case when strpos');
    expect(lower).toContain('then');
    expect(lower).toContain('else');
    expect(params).toContain("'autec':*");
    expect(params).toContain("'autec'");
  });

  it('the CASE form is NOT present in the word tier (calls 0/1) for the same query', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'autec', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text } = compiledExecuteCall(0);
    expect(text.toLowerCase()).not.toContain('case when strpos');
  });
});

describe('typing-term selection (findTypingTermIndex, consulted only in the prefix tier)', () => {
  it('prefixes only the LAST of two bare terms — the earlier one stays an exact lexeme, no CASE for it', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'art ens', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'ens':*");
    expect(params).toContain("'art'");
    expect(params).not.toContain("'art':*");
  });

  it('still selects the last bare term as typing term when a trailing field condition follows it (art ens label:warp)', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'art ens label:warp', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'ens':*");
    expect(params).not.toContain("'art':*");
  });

  it('still prefixes the bare term when a dateRange field condition follows it (dj-site row ordering)', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({
      q: 'autec dateRange:2024-01-01..2024-12-31',
      page: 0,
      limit: 50,
      sort: 'date',
      order: 'desc',
    });

    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'autec':*");
  });

  it('when the final bare term is negated, the preceding positive bare term is the typing term instead', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'autec NOT girl', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'autec':*");
    expect(params).not.toContain("'girl':*");
  });

  it('when the final bare term is quoted (exact), the preceding positive bare term is the typing term instead', async () => {
    mockEmptyWordThenPrefix();

    await searchFlowsheet({ q: 'autec "girl"', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'autec':*");
  });

  it('a 1-2 char typing term disqualifies -- no prefix tier is attempted at all (no cascade, 2 calls total)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: 'tv', page: 0, limit: 50, sort: 'date', order: 'desc' });

    // `shouldUseTsvector('tv')` is false (the `< 3` floor), so
    // `findTypingTermIndex` returns -1 and `tiersFor` never lists 'prefix' --
    // there is nothing for a second tier to change.
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('a trailing 1-2 char bare term ENDS the search rather than being skipped past -- "autechre am" has no typing term', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: 'autechre am', page: 0, limit: 50, sort: 'date', order: 'desc' });

    // The DJ is typing "am" (2 chars, not tsvector-eligible); "autechre" is
    // an earlier, already-completed word and must NOT be reached for by
    // skipping "am" -- findTypingTermIndex stops at the first positive bare
    // term scanning backward, so there is no typing term at all here and no
    // cascade is attempted.
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  // Mutation proof (manual; run during implementation): swapping
  // `findTypingTermIndex`'s backward scan for a forward one (picking the
  // FIRST eligible term) flips the "two bare terms" and "trailing field
  // condition" tests above to red -- `'art':*`/`'autec':*` would be missing
  // and the WRONG term would carry `:*` instead. Dropping the
  // `!condition.negated` / `!condition.exact` guard flips the negated/quoted
  // tests to red -- `'girl':*` would appear instead of `'autec':*`. Dropping
  // the `shouldUseTsvector` guard flips the 1-2 char test to red -- a third
  // call pair would fire for `tv`. Reverting the "ends the search" rule to
  // the old "skip past an ineligible trailing term" behaviour flips the
  // "autechre am" test above to red -- it would cascade and prefix-match the
  // completed word "autechre" instead of stopping at "am".
});
