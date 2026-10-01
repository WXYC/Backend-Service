// BS#2726: `flowsheet.search_doc` concatenates five weighted tsvector
// segments (artist A, track B, dj_name B, album C, label D — migration 0054
// added dj_name to 0052's original four) with NO position gap between them
// (`tsvector || tsvector` continues numbering across the `||`), so a
// cross-seam `<->` phrase can match text that was never adjacent in any real
// row — the same defect migration 0178 closed for `library.search_doc` by
// rewriting the STORED generated column. Flowsheet cannot take that column
// rewrite (an ~8-minute ACCESS EXCLUSIVE lock on 2.65M rows, see the plan on
// #2726), so the fix lives in the READER instead: `buildAllFieldMatch`
// switches its tsvector branch from `websearch_to_tsquery` to the catalog's
// `buildPrefixTsquery` (BS#670's builder, which never emits negation or a
// user operator, making the AND-narrowing below unconditionally safe — see
// docs/playlist-search/README.md), and ANDs in a second predicate against a
// GAPPED rebuild of the same five segments (a `wxycsearchdocgap` sentinel
// between each pair, removed by `ts_delete` without renumbering the
// survivors — the exact 0178 mechanism, applied at read time instead of at
// the column).
//
// `searchFlowsheet` compiles via `dialect.sqlToQuery` here (`jest.unmock('drizzle-orm')`
// below), and `compiledExecuteCall(1)` reads the SECOND db.execute call,
// which is always the 'word' tier's own count query (WXYC/Backend-Service#2712):
// every word below is tsvector-eligible, so the 'word' tier never returns
// non-empty before the mock resolves it empty, but this file only inspects
// calls 0/1 regardless of whether a later cascade call follows — so it pins
// the 'word' tier's guard exclusively, byte-identical to pre-#2712 `main`.
// The 'prefix' tier's own, DIFFERENT seam mechanics (an outer boolean CASE,
// not a tsquery-level one) are covered in
// tests/unit/services/search.service.cascade.test.ts.
//
// BS#2753 review: the guard is routed in SQL (`strpos(q::text, '<') = 0 OR
// gapped @@ q`), not predicted in JS, so this file asserts the UNCONDITIONAL
// shape — every tsvector-eligible query compiles the same guarded form,
// whether or not its token happens to split. See `buildAllFieldMatch`'s
// docstring in search.service.ts for why Postgres's own custom-plan constant
// folding makes this free for a plain word in production.
//
// Uses the real drizzle-orm `sql` tag (PgDialect), mirroring
// search.service.count-cap.test.ts: asserting on the capped COUNT query
// (compiledExecuteCall(1)) isolates the WHERE clause from the SELECT list's
// unrelated columns and DJ_NAME_EXPR's own COALESCE.
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Compile the SQL text + bound params for the Nth db.execute call (0 = data, 1 = count). */
const compiledExecuteCall = (n: number) => {
  const stmt = (db.execute as jest.Mock).mock.calls[n][0];
  return dialect.sqlToQuery(stmt);
};

beforeEach(() => {
  jest.clearAllMocks();
});

import { searchFlowsheet } from '../../../apps/backend/services/search.service';

/** searchFlowsheet issues the data query first, then the count query. */
const mockDataAndCount = () => {
  (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
};

describe('search.service gapped-vector seam guard (BS#2726, SQL-routed per BS#2753)', () => {
  describe.each([['jane'], ['stereolab'], ["o'rourke"], ['b_side'], ['pratt-back']])(
    'tsvector-eligible query %j',
    (word) => {
      it('always compiles the strpos-gated guard — no websearch_to_tsquery, exactly two @@, the gapped rebuild and strpos check present regardless of the word', async () => {
        mockDataAndCount();

        await searchFlowsheet({ q: word, page: 0, limit: 50, sort: 'date', order: 'desc' });

        const { sql: text, params } = compiledExecuteCall(1);
        const lower = text.toLowerCase();

        expect(lower).toContain('to_tsquery');
        expect(lower).not.toContain('websearch_to_tsquery');

        // The guard is unconditional at the SQL-TEXT level now — routing
        // happens inside Postgres (strpos on the compiled tsquery's ::text),
        // not in this file's choice of which SQL to emit. So every one of
        // these words, plain or phrase-forming alike, must show the full
        // shape: the strpos check, the gapped rebuild, and both @@ operators.
        expect(lower).toContain('strpos');
        expect(lower).toContain('ts_delete');
        expect(lower).toContain('wxycsearchdocgap');
        // Four gap vectors buy the four position shifts between the five
        // segments (artist | track | dj_name | album | label).
        expect((text.match(/wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap/g) ?? []).length).toBe(4);
        // Lowercase, as the fragment writes it (never `COALESCE`) — once per
        // segment.
        expect((text.match(/coalesce\(/g) ?? []).length).toBe(5);
        // Weights in field order: artist A, track B, dj_name B, album C, label D.
        expect(text).toMatch(/'A'[\s\S]*'B'[\s\S]*'B'[\s\S]*'C'[\s\S]*'D'/);
        // Exactly two `@@` — the stored-column recheck and the gapped
        // predicate inside the strpos-gated OR. A bare "contains AND" would
        // be vacuous, since baseFrom always ANDs `entry_type = 'track'` onto
        // every predicate.
        expect((text.match(/@@/g) ?? []).length).toBe(2);
        expect(text).toMatch(/@@[\s\S]*\bAND\b[\s\S]*strpos\([\s\S]*=\s*0[\s\S]*\bOR\b[\s\S]*ts_delete\([\s\S]*@@/);

        // The mock db's columns are table-qualified sentinel strings
        // ('flowsheet.artist_name', …) — see tests/mocks/database.mock.ts —
        // so each `coalesce(${col}, '')` in the gapped rebuild binds its
        // column as a literal parameter. Column order in the five segments
        // is artist, track, dj_name, album, label.
        const searchDocIndex = params.indexOf('flowsheet.search_doc');
        expect(searchDocIndex).toBeGreaterThanOrEqual(0);
        const columnParamsAfter = params
          .slice(searchDocIndex + 1)
          .filter((p) => typeof p === 'string' && p.startsWith('flowsheet.'));
        expect(columnParamsAfter.slice(0, 5)).toEqual([
          'flowsheet.artist_name',
          'flowsheet.track_title',
          'flowsheet.dj_name',
          'flowsheet.album_title',
          'flowsheet.record_label',
        ]);
      });
    }
  );

  // Mutation proof: removing the `OR ${gappedSearchDocSql()} @@ ${q}` arm
  // (leaving `strpos(...) = 0` as the whole second AND operand) makes every
  // test above go red on the `ts_delete`/`wxycsearchdocgap`/`@@`-count
  // assertions — the compiled SQL would no longer contain the gapped
  // rebuild at all. Removing the `strpos(...) = 0 OR` prefix instead
  // (reverting to the unconditional `search_doc @@ q AND gapped @@ q` this
  // guard replaced) makes the `toContain('strpos')` assertion go red while
  // every other assertion in this file stays green — the seam coverage
  // itself would be unaffected, which is exactly the point of finding 3 in
  // the BS#2753 review (the JS-predicted and SQL-routed forms return the
  // same rows; only the mechanism for deciding changed). Both are run
  // manually: this file has nothing left to assert the guard's presence
  // once the relevant arm is gone.
});
