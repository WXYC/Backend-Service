/**
 * Unit tests for `apps/backend/utils/sql-rotation-bin.ts` (BS#2698 — the
 * extraction of `FSEntryFieldsRaw.rotation_bin` out of `flowsheet.service.ts`
 * into a shared, composable fragment).
 *
 * `ROTATION_BIN_EXPR` is built at module-import time from whatever
 * `rotation`/`flowsheet`/`library`/`artists` the module receives from
 * `@wxyc/database` — the unit suite's `moduleNameMapper` points that bare
 * specifier at `tests/mocks/database.mock.ts`, whose "columns" are plain
 * strings rather than real Drizzle `Column`s, so an expression built from
 * them renders as bind parameters (`$1`, `$2`, ...), not as
 * `"rotation"."rotation_bin"`. The precondition guard this file exists to
 * enforce (constraint 5 of BS#2698: callers must `leftJoin(rotation, ...)`)
 * needs the real column identifiers, so this suite overrides `@wxyc/database`
 * with the real, pure `schema.ts` pgTable definitions before importing the
 * module under test — mirroring how `tests/unit/database/last-logged-show-entry.test.ts`
 * reaches for real Drizzle objects instead of the double.
 */
jest.unmock('drizzle-orm');
jest.mock('@wxyc/database', () => jest.requireActual('../../../shared/database/src/schema'));

import { PgDialect } from 'drizzle-orm/pg-core';
import { ROTATION_BIN_EXPR } from '../../../apps/backend/utils/sql-rotation-bin';

const dialect = new PgDialect();
const rendered = dialect.sqlToQuery(ROTATION_BIN_EXPR).sql;

describe('ROTATION_BIN_EXPR', () => {
  it('references the primary FK lane as a real, qualified column — not a bind parameter', () => {
    // This is the precondition guard: if a future caller (or a refactor of
    // this module) drops the requirement that `rotation` be joined, the
    // primary lane stops being a real column reference and this assertion
    // catches it before a request-time "relation \"rotation\" does not exist".
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
});
