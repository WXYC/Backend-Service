/**
 * Unit tests for `apps/backend/utils/sql-rotation-bin.ts` — the `rotation_bin`
 * resolution expression, rendered on its own.
 *
 * `rotationBinExpr()` builds its `SQL` from whatever `rotation`/`flowsheet`/
 * `library`/`artists` the module receives from `@wxyc/database` — the unit
 * suite's `moduleNameMapper` points that bare specifier at
 * `tests/mocks/database.mock.ts`, whose "columns" are plain strings rather
 * than real Drizzle `Column`s, so an expression built from them renders as
 * bind parameters (`$1`, `$2`, ...), not as `"rotation"."rotation_bin"`. This
 * suite overrides `@wxyc/database` with the real, pure `schema.ts` pgTable
 * definitions before importing the module under test — mirroring how
 * `tests/unit/database/last-logged-show-entry.test.ts` reaches for real
 * Drizzle objects instead of the double.
 *
 * What this file cannot check is the caller's side of the contract: rendering
 * the fragment alone never sees a join list. That the `rotation` join is
 * present, and that each call site serves the pre-extraction SQL byte for
 * byte, is `tests/unit/services/flowsheet.rotationBin.sql.test.ts`'s job.
 */
jest.unmock('drizzle-orm');
jest.mock('@wxyc/database', () => jest.requireActual('../../../shared/database/src/schema'));

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { rotationBinExpr } from '../../../apps/backend/utils/sql-rotation-bin';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]): string => dialect.sqlToQuery(fragment).sql;
const rendered = render(rotationBinExpr());

describe('rotationBinExpr', () => {
  it('reads the primary lane from the joined `rotation` table as a real column, not a bind parameter', () => {
    // This column is why every caller must join `rotation`: the fragment
    // carries no join of its own for it.
    expect(rendered).toContain('"rotation"."rotation_bin"');
  });

  it('references every table the fallback subquery reads, fully qualified', () => {
    expect(rendered).toContain('"flowsheet"."rotation_id"');
    expect(rendered).toContain('"flowsheet"."album_id"');
    expect(rendered).toContain('"flowsheet"."artist_name"');
    expect(rendered).toContain('"flowsheet"."album_title"');
    expect(rendered).toContain('"flowsheet"."add_time"');
    expect(rendered).toContain('"rotation" r2');
    expect(rendered).toContain('"library" l2');
    expect(rendered).toContain('"artists" a2');
  });

  it('keeps the three-cohort UNION ALL shape (BS#2080) — not collapsed into an OR', () => {
    expect(rendered.match(/union all/gi)).toHaveLength(2);
  });

  it('is a single COALESCE — the FK lane always wins when populated', () => {
    expect(rendered.trim().toLowerCase().startsWith('coalesce(')).toBe(true);
  });

  it('returns a fresh SQL per call, so a caller mutating its copy cannot reach any other caller', () => {
    // drizzle's `SQL.append()`, `.mapWith()` and `.inlineParams()` modify the
    // instance in place and return `this`.
    const mine = rotationBinExpr();
    mine.append(sql` + 1`);

    const theirs = rotationBinExpr();
    expect(theirs).not.toBe(mine);
    expect(render(theirs)).toBe(rendered);
  });
});
