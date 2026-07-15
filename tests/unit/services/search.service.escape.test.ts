// Use the real drizzle-orm `sql` tag (the unit suite auto-mocks it) so
// searchFlowsheet builds a real SQL object we can compile with PgDialect and
// assert the escaped ILIKE patterns + ESCAPE clause reach db.execute. Mirrors
// the escaping regression tests in suggest.service.test.ts / labels.service.test.ts,
// extended to the flowsheet search service's multi-column trigram fallback.
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Compile the SQL text + bound params for the Nth db.execute call (0 = data query). */
const compiledExecuteCall = (n = 0) => {
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

describe('search.service ILIKE wildcard escaping', () => {
  it('escapes a % across all four columns of the all-field trigram fallback (with ESCAPE)', async () => {
    mockDataAndCount();

    // "%a" is 2 chars -> shouldUseTsvector() is false -> trigram fallback path,
    // which ORs an ILIKE across artist/track/album/label.
    await searchFlowsheet({ q: '%a', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(0);
    // "%a" -> escaped "\%a" -> contains pattern "%\%a%" (only the wrapping %s are wildcards).
    const contains = params.filter((p) => p === '%\\%a%');
    // One bound param per column: artist_name, track_title, album_title, record_label.
    expect(contains).toHaveLength(4);
    expect(text).toContain("ESCAPE '\\'");
  });

  it('escapes a % in a field-scoped (artist:) contains match (with ESCAPE)', async () => {
    mockDataAndCount();

    await searchFlowsheet({ q: 'artist:%a', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(0);
    expect(params).toContain('%\\%a%');
    expect(text).toContain("ESCAPE '\\'");
  });

  it('escapes a _ in a dj-name (dj:) contains match (with ESCAPE)', async () => {
    mockDataAndCount();

    await searchFlowsheet({ q: 'dj:_a', page: 0, limit: 50, sort: 'date', order: 'desc' });

    const { sql: text, params } = compiledExecuteCall(0);
    // "_a" -> escaped "\_a" -> contains pattern "%\_a%".
    expect(params).toContain('%\\_a%');
    expect(text).toContain("ESCAPE '\\'");
  });
});
