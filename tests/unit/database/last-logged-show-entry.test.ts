/**
 * Unit tests for shared/database/src/last-logged-show-entry.ts (BS#2118
 * sites 5/7/8).
 *
 * Pure SQL-fragment module — no DB client — so these render the real
 * fragments through drizzle's own `PgDialect` and assert on the genuine SQL
 * text, mirroring `tests/unit/utils/sql-like.test.ts` and
 * `tests/unit/jobs/legacy-mirror-reconcile/stale-open-shows-sql.test.ts`
 * (both chosen over a call-shape mock for the same reason: a mock can pin
 * that `orderBy` was called, not what it was called WITH).
 *
 * The consolidation this module performs is a PURE REFACTOR — it must emit
 * exactly what the four hand-written copies emitted. The byte-equality tests
 * below are the guard on that claim, since a silent change to any of these
 * fragments would alter which row three control-flow gates consider a show's
 * last-logged entry.
 */
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';
import { flowsheet } from '../../../shared/database/src/schema';
import {
  lastLoggedShowEntryOrderBy,
  lastLoggedShowEntryOrderBySql,
} from '../../../shared/database/src/last-logged-show-entry';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]): string => dialect.sqlToQuery(fragment).sql;

describe('lastLoggedShowEntryOrderBy (query-builder form, BS#2118 site 5)', () => {
  it('orders by id DESC — insertion order, deliberately not add_time', () => {
    const [term] = lastLoggedShowEntryOrderBy();
    const text = render(term);
    expect(text).toContain('"id" desc');
    // The whole point of the accepted decision: this must NOT sort by airtime.
    expect(text).not.toContain('add_time');
  });

  it('emits exactly one ORDER BY term (no tie-break needed — id is unique)', () => {
    expect(lastLoggedShowEntryOrderBy()).toHaveLength(1);
  });

  it('renders byte-identically to the hand-written desc(flowsheet.id) it replaced', () => {
    const [term] = lastLoggedShowEntryOrderBy();
    expect(render(term)).toBe(render(desc(flowsheet.id)));
  });
});

describe('lastLoggedShowEntryOrderBySql (raw-SQL form, BS#2118 sites 7 and 8)', () => {
  it("renders byte-identically to site 7's hand-written unaliased fragment", () => {
    // Site 7 (closeShowFromTerminalShowEndMarker) interpolated the column
    // object inside an UPDATE...WHERE, where it renders fully-qualified.
    expect(render(lastLoggedShowEntryOrderBySql())).toBe(render(sql`${flowsheet.id} DESC`));
  });

  it("renders byte-identically to site 8's hand-written aliased fragment", () => {
    // Site 8 (selectStaleOpenShows) hand-wrote `fe.id DESC` inside a
    // .select({...}) projection, where a bare interpolation would
    // self-correlate against the subquery's own flowsheet scope.
    expect(render(lastLoggedShowEntryOrderBySql('fe'))).toBe(render(sql`${sql.raw('fe')}.id DESC`));
  });

  it('never emits an unqualified/fully-qualified column when an alias is requested', () => {
    const text = render(lastLoggedShowEntryOrderBySql('fe'));
    expect(text).toContain('fe.id DESC');
    // Falling back to the table-qualified form is the self-correlation bug
    // documented at orchestrate.ts's newestEntryType.
    expect(text).not.toContain('"flowsheet"."id"');
  });

  it('sorts by id, never add_time, in either form', () => {
    expect(render(lastLoggedShowEntryOrderBySql())).not.toContain('add_time');
    expect(render(lastLoggedShowEntryOrderBySql('fe'))).not.toContain('add_time');
  });

  // The alias reaches `sql.raw`, which concatenates rather than
  // parameterizes, on a function exported from @wxyc/database to every
  // workspace. No live caller passes anything but 'fe'; the guard is what
  // keeps that safe for the next one.
  it.each([
    ['a quote-and-comment injection', 'fe"; DROP TABLE flowsheet; --'],
    ['a whitespace-separated clause', 'fe, (SELECT 1)'],
    ['a leading digit', '1fe'],
    ['a hyphen', 'fe-alias'],
  ])('rejects %s rather than interpolating it', (_label, alias) => {
    expect(() => lastLoggedShowEntryOrderBySql(alias)).toThrow(/unsafe SQL alias/);
  });

  it.each(['fe', 'f', 'flowsheet_entry', '_fe', 'fe2'])('accepts the plain identifier %p', (alias) => {
    expect(() => lastLoggedShowEntryOrderBySql(alias)).not.toThrow();
  });

  // An empty string is falsy, so it takes the unaliased branch rather than
  // reaching the guard. Safe either way (nothing is interpolated), but pinned
  // so the fall-through is documented behavior rather than an assumed one.
  it('falls through to the unaliased form on an empty-string alias', () => {
    expect(render(lastLoggedShowEntryOrderBySql(''))).toBe(render(sql`${flowsheet.id} DESC`));
  });
});
