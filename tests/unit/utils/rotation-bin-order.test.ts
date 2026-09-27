// The unit suite auto-mocks drizzle-orm (tests/__mocks__/drizzle-orm.ts), so a
// `sql` fragment would come back as a plain `{ sql, values }` shape rather than
// something renderable. This suite needs the real tag and dialect to assert on
// the SQL text the fragment actually emits — the same recipe
// tests/unit/utils/sql-like.test.ts uses, and for the same reason: a fragment
// asserted against the mock shape can be malformed without the test noticing.
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { ROTATION_BIN_DEDUP_ORDINAL } from '../../../apps/backend/utils/rotation-bin-order';

const dialect = new PgDialect();
const render = () => dialect.sqlToQuery(ROTATION_BIN_DEDUP_ORDINAL);

describe('ROTATION_BIN_DEDUP_ORDINAL', () => {
  it('emits the exact CASE expression the DISTINCT ON collapses tie-break on', () => {
    // Pinned as a literal, not rebuilt from the bin order, so a reordering of
    // the CASE arms fails here rather than silently changing which rotation row
    // survives a dedup. This is the byte-for-byte text that was module-private
    // in library-search.service.ts before the extraction.
    expect(render().sql).toBe(
      "CASE rotation_bin WHEN 'H' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'S' THEN 4 ELSE 5 END"
    );
  });

  it('binds no parameters, so it is safe to interpolate more than once per query', () => {
    // Every caller interpolates it into both a data query and a count query.
    // A bound parameter here would mean two placeholders per statement and an
    // ordering dependency between them.
    expect(render().params).toEqual([]);
  });

  it('assigns H the lowest ordinal, inverting freq_enum declaration order', () => {
    // The whole reason the constant exists. `freq_enum` is declared
    // ('S','L','M','H') in migration 0000, so pg sorts S=1 L=2 M=3 H=4 and a
    // bare `rotation_bin ASC` keeps Singles and discards Heavy — exactly
    // backwards for a "which bin is this album really in" collapse. Measured on
    // a production clone: 35 albums hold more than one active rotation row and
    // the maximum on a single album is 9.
    const text = render().sql;
    const ordinalOf = (bin: string) => {
      const match = new RegExp(`WHEN '${bin}' THEN (\\d+)`).exec(text);
      if (match === null) throw new Error(`no arm for bin ${bin}`);
      return Number(match[1]);
    };
    expect(ordinalOf('H')).toBeLessThan(ordinalOf('M'));
    expect(ordinalOf('M')).toBeLessThan(ordinalOf('L'));
    expect(ordinalOf('L')).toBeLessThan(ordinalOf('S'));
  });

  it('keeps an ELSE arm, so a NULL bin cannot sort first under a DESC', () => {
    // `library_artist_view` LEFT JOINs rotation, so `rotation_bin` is NULL for
    // most of the catalog. Without the ELSE the expression yields NULL, which
    // sorts last under the ASC every current caller uses but FIRST under a
    // DESC — a trap for a future caller that flips the direction.
    expect(render().sql).toMatch(/ELSE 5 END$/);
  });

  it('references rotation_bin unqualified, which is what constrains where it can be used', () => {
    // Documented in the module docstring and load-bearing: the bare name
    // resolves only in an outer query over a subquery alias, which is the shape
    // all current callers have. A caller that drops this into a flat
    // multi-table join needs a qualified variant instead. If this assertion is
    // ever changed to a qualified reference, every existing call site has to be
    // revisited, so pin it.
    expect(render().sql).toContain('CASE rotation_bin ');
    expect(render().sql).not.toMatch(/CASE\s+"/);
  });
});
