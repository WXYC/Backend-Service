// WXYC/Backend-Service#2712: the 'substring' tier's predicate shape — every
// positive, non-negated, unquoted bare `all` term that passes
// `shouldUseTsvector` becomes `(<its word-tier predicate> OR <the four-column
// ILIKE-contains predicate>)` — and byte-identity of the 'word'/'prefix'
// tiers' own SQL, which the 'substring' tier must not touch.
//
// `searchFlowsheet`'s cascade only reaches 'substring' when every earlier
// tier comes back empty, so every test here mocks those earlier tiers empty
// to force the cascade, then inspects the substring tier's own data/count
// call pair. A query whose typing term exists runs three tiers (word,
// prefix, substring -- substring's data call is call index 4); a query with
// NO typing term (e.g. a trailing 1-2 char bare term, which ends the search
// for `findTypingTermIndex` -- see `search.service.tier.test.ts`) skips
// 'prefix' and runs only two (word, substring -- substring's data call is
// call index 2), since `tiersFor`'s substring gate is independent of the
// typing term (it fires whenever ANY positive bare term is tsvector-eligible,
// not just the last one).
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

import { searchFlowsheet, buildWhereClause, isSubstringEligible } from '../../../apps/backend/services/search.service';
import { parseSearchQuery, FLOWSHEET_PARSER_CONFIG } from '../../../apps/backend/services/search-parser.service';

/** Mocks empty, zero-count 'word' and 'prefix' tiers (forcing the cascade to 'substring' at call index 4). Use only for a query with a typing term. */
const mockEmptyWordAndPrefixThenSubstring = () => {
  (db.execute as jest.Mock)
    .mockResolvedValueOnce([]) // word data
    .mockResolvedValueOnce([{ total: 0 }]) // word count
    .mockResolvedValueOnce([]) // prefix data
    .mockResolvedValueOnce([{ total: 0 }]) // prefix count
    .mockResolvedValueOnce([]) // substring data
    .mockResolvedValueOnce([{ total: 0 }]); // substring count
};

/** Mocks an empty, zero-count 'word' tier (forcing the cascade straight to 'substring' at call index 2, with no 'prefix' tier in between). Use only for a query with no typing term. */
const mockEmptyWordThenSubstringNoPrefix = () => {
  (db.execute as jest.Mock)
    .mockResolvedValueOnce([]) // word data
    .mockResolvedValueOnce([{ total: 0 }]) // word count
    .mockResolvedValueOnce([]) // substring data
    .mockResolvedValueOnce([{ total: 0 }]); // substring count
};

describe("substring tier: every eligible term's predicate is OR'd with the ILIKE-contains fallback", () => {
  it('a single bare term compiles (wordMatch OR ilikeContains), with both the tsvector and ILIKE params present', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(4);
    const lower = text.toLowerCase();

    expect(lower).toContain('to_tsquery');
    expect(lower).toContain('ilike');
    // Never the prefix CASE — substring already subsumes a prefix.
    expect(lower).not.toContain('case when strpos');
    expect(params).toContain("'utechre'");
    expect(params).toContain('%utechre%');
  });

  it('two bare terms each get their own OR -- both tsvector and ILIKE params present for both', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre power', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(4);
    expect(params).toContain("'utechre'");
    expect(params).toContain('%utechre%');
    expect(params).toContain("'power'");
    expect(params).toContain('%power%');
  });

  it('the typing term is NOT prefix-matched in this tier -- no :* suffix anywhere in the substring-tier params', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(4);
    expect(params).not.toContain("'utechre':*");
  });

  it('a negated term keeps its plain word-tier predicate in the substring tier -- no ILIKE pattern for it', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre NOT girlband', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(4);
    expect(text.toLowerCase()).toContain('not (');
    expect(params).toContain("'utechre'");
    expect(params).toContain('%utechre%');
    expect(params).toContain("'girlband'");
    // The negated term's own predicate is never OR'd with ILIKE -- it stays
    // the bare word-tier form so exclusion never shifts.
    expect(params).not.toContain('%girlband%');
  });

  it('a quoted (exact) term is unchanged -- whole-value ILIKE, never widened to contains', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    // "power" is the eligible bare term that gets the cascade to 'substring'
    // at all; "girlband" is quoted (exact) and must stay untouched by it.
    await searchFlowsheet({ q: 'power "girlband"', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(4);
    expect(params).toContain('girlband');
    expect(params).not.toContain('%girlband%');
  });

  it('a field condition (e.g. label:warp) is unchanged -- no ILIKE-contains widening', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre label:warp', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { params } = compiledExecuteCall(4);
    expect(params).toContain('%warp%');
    // Exactly one ILIKE-contains pattern for "warp" (the field condition's
    // own predicate), not a second one from a substring widening.
    expect(params.filter((p: unknown) => p === '%warp%')).toHaveLength(1);
  });

  it('a 1-2 char trailing term disqualifies the prefix tier but not the substring tier -- "utechre tv" has no typing term, so only word+substring run', async () => {
    mockEmptyWordThenSubstringNoPrefix();

    await searchFlowsheet({ q: 'utechre tv', page: 0, limit: 50, sort: 'date', order: 'desc' });

    // Only 4 calls (word + substring): the trailing short term "tv" ends
    // `findTypingTermIndex`'s scan (see search.service.tier.test.ts), so
    // there is no typing term and the 'prefix' tier never runs -- but
    // `hasSubstringEligibleTerm` scans every condition independently of the
    // typing term, and "utechre" alone qualifies.
    expect(db.execute).toHaveBeenCalledTimes(4);
    const { params } = compiledExecuteCall(2);
    expect(params).toContain("'utechre'");
    expect(params).toContain('%utechre%');
    // "tv" stays on its existing four-column ILIKE-contains branch unchanged
    // -- one '%tv%' per column, not a further duplicate from the substring
    // OR (which never applies to an already-ineligible term).
    expect(params.filter((p: unknown) => p === '%tv%')).toHaveLength(4);
  });

  // Mutation proof (manual; run during implementation): dropping the
  // `!condition.negated` guard when computing the per-condition `substring`
  // flag flips the negated-term test above to red (`%girlband%` would
  // appear). Swapping `ilikeContainsFragment(value)` for a `dj_name` ILIKE
  // would make a dj_name-only match disappear from this tier (covered
  // separately by the integration fixture, since dj_name isn't in this
  // file's row data).
});

describe('word and prefix tiers are byte-identical to their pre-substring-tier shape -- no substring widening leaks upstream', () => {
  it('the word tier (call 0) has no ILIKE for a tsvector-eligible term', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text } = compiledExecuteCall(0);
    expect(text.toLowerCase()).not.toContain('ilike');
  });

  it('the prefix tier (call 2) has no ILIKE-contains widening for the typing term', async () => {
    mockEmptyWordAndPrefixThenSubstring();

    await searchFlowsheet({ q: 'utechre', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text } = compiledExecuteCall(2);
    expect(text.toLowerCase()).toContain('case when strpos');
    expect(text.toLowerCase()).not.toContain('ilike');
  });
});

describe('tiersFor: the substring tier is only appended when eligible, and only under sort=date', () => {
  it('no eligible term at all (query empty) -- the cascade never reaches a second tier', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: '', page: 0, limit: 50, sort: 'date', order: 'desc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('a non-date sort never reaches the substring tier, even with an eligible term and an empty word tier', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    await searchFlowsheet({ q: 'utechre', page: 0, limit: 50, sort: 'artist', order: 'asc' });

    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});

describe('isSubstringEligible is the single source of truth: the substring tier is scheduled iff its WHERE differs from the word tier', () => {
  /** Render a tier's WHERE clause text for a raw query, or null for an empty query. */
  const renderWhere = (q: string, tier: 'word' | 'substring'): string | null => {
    const conditions = parseSearchQuery(q, FLOWSHEET_PARSER_CONFIG);
    // typingTermIndex is irrelevant to both 'word' and 'substring' -- only
    // the 'prefix' tier reads it -- so -1 (no typing term) is safe here.
    const where = buildWhereClause(conditions, tier, -1);
    return where ? dialect.sqlToQuery(where).sql : null;
  };

  it.each([
    ['', false],
    ['tv', false], // under the length-3 floor
    ['Åäöü', false], // no ASCII alphanumeric (BS#2739)
    ['"autec"', false], // quoted (exact)
    ['NOT autec', false], // negated
    ['label:warp', false], // field condition, not 'all'
    ['autec', true],
    ['autec power', true],
    ['autec label:warp', true], // the eligible bare term survives a trailing field condition
    ['autec NOT power', true], // "autec" is still eligible even though "power" is negated
  ])('query %j: hasEligible matches (wordWHERE !== substringWHERE) (%s)', (q) => {
    const conditions = parseSearchQuery(q, FLOWSHEET_PARSER_CONFIG);
    const hasEligible = conditions.some(isSubstringEligible);

    const wordText = renderWhere(q, 'word');
    const substringText = renderWhere(q, 'substring');

    expect(hasEligible).toBe(wordText !== substringText);
  });

  // Mutation proof (manual; run during implementation, confirmed): widening
  // `isSubstringEligible` to drop the `!condition.exact` check flips the
  // `'"autec"'` case to red -- `hasEligible` would be `true` (the quoted
  // condition would count as eligible) while the rendered WHERE stays
  // IDENTICAL between tiers (a quoted condition's predicate never consults
  // the `substring` flag at all, inside `buildAllFieldMatch`), so the two
  // sides of the assertion diverge. Dropping the `shouldUseTsvector` check
  // flips the `'tv'` case to red the same way.
});
