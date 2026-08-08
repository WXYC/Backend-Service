/**
 * Canonical SQL renderer for unit tests driving the manual drizzle-orm mock
 * at `tests/__mocks__/drizzle-orm.ts` (BS#2051).
 *
 * The mock can hand `db.execute(...)` (and its own sub-fragments) one of
 * four distinct "chunk" shapes:
 *
 *   - `{ sql: string[], values: unknown[] }` — the `` sql`...` `` tagged
 *     template (mock lines 5-9)
 *   - `{ raw: string }`                      — `sql.raw(...)` (mock line 11)
 *   - `{ join: unknown[], sep: unknown }`     — `sql.join(...)` (mock line 12)
 *   - `{ queryChunks: unknown[] }`            — a REAL drizzle-orm `SQL`
 *     fragment that slipped through the mock (e.g. built by code this suite
 *     doesn't mock, or produced by `sql.raw`'s real counterpart upstream)
 *
 * Forty-plus unit-test files each hand-rolled their own subset of this
 * rendering logic, and every one of them fell back to an empty string on a
 * shape it didn't recognize. During PR #2041, one such local renderer had no
 * case for `{ join, sep }`: instead of throwing, it silently rendered
 * nothing, the assertion saw `FROM (VALUES )` with an empty body, and the
 * resulting failure message pointed nowhere near the actual bug. `renderSql`
 * and `renderValue` below throw instead — loudly, with the offending value
 * serialized — the moment they meet something that isn't one of the four
 * shapes above. An unhandled shape is a bug in the renderer (or a fifth mock
 * shape nobody has taught it yet), never a silently empty string.
 *
 * Do not "fix" this by changing the shared mock's `sql.join` to compose a
 * `{ sql, values }` fragment instead of `{ join, sep }` — several suites
 * define their own local drizzle-orm mocks that pin the `{ join, sep }`
 * shape, and changing the shared mock's output shape would break them for
 * reasons unrelated to what they're testing. Normalize here, at the
 * renderer, not at the mock.
 */

interface SqlLikeShape {
  sql?: unknown;
  values?: readonly unknown[];
  raw?: unknown;
  join?: readonly unknown[];
  sep?: unknown;
  queryChunks?: readonly unknown[];
  value?: unknown;
}

/** Best-effort serialization of an offending value for an error message. */
function describeUnknownShape(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json !== undefined) return json;
  } catch {
    // circular structure or similar — fall through to util.inspect, which
    // (unlike JSON.stringify/String) is built to handle arbitrary values.
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { inspect } = require('node:util') as typeof import('node:util');
  return inspect(value, { depth: 6 });
}

function unrecognizedShapeError(fnName: string, value: unknown): Error {
  return new Error(
    `${fnName}: unrecognized SQL mock shape — expected one of {sql, values}, {raw}, {join, sep}, or ` +
      `{queryChunks}. Received: ${describeUnknownShape(value)}`
  );
}

/**
 * Renders a single bound value (an entry of a `{ sql, values }` chunk's
 * `values` array, or a `queryChunks` entry that isn't a raw string).
 *
 * `null`/`undefined` are legitimate bound-SQL-NULL values, not an
 * unrecognized shape, and render as `''`. Anything else that isn't a
 * primitive or one of the four recognized chunk shapes throws.
 */
export function renderValue(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const obj = value as SqlLikeShape;
    if (
      Array.isArray(obj.sql) ||
      typeof obj.sql === 'string' ||
      typeof obj.raw === 'string' ||
      Array.isArray(obj.join) ||
      Array.isArray(obj.queryChunks)
    ) {
      return renderSql(obj);
    }
    // A real drizzle-orm `Param`-like chunk, which carries its bound value
    // (or array of value fragments) under `.value` rather than one of the
    // four shapes above.
    if (Array.isArray(obj.value)) return obj.value.join('');
    if (typeof obj.value === 'string') return obj.value;
  }
  throw unrecognizedShapeError('renderValue', value);
}

/**
 * Renders a SQL "chunk" — anything the manual drizzle-orm mock could hand to
 * `db.execute(...)` — to a flat string, recursing into nested fragments.
 *
 * Throws (never returns `''`) when `value` is `null`/`undefined` or doesn't
 * match one of the four recognized shapes. A SQL chunk, unlike a bound
 * value, should never legitimately be absent — `db.execute` is always
 * called with a real `sql`-tag result.
 */
export function renderSql(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const obj = value as SqlLikeShape;

    // `` sql`...` `` tagged template: { sql: string[], values: unknown[] }
    if (Array.isArray(obj.sql)) {
      const fragments = obj.sql as readonly string[];
      const values = obj.values ?? [];
      let out = '';
      for (let i = 0; i < fragments.length; i++) {
        out += fragments[i];
        if (i < values.length) out += renderValue(values[i]);
      }
      return out;
    }
    if (typeof obj.sql === 'string') return obj.sql;

    // sql.raw(...): { raw: string }
    if (typeof obj.raw === 'string') return obj.raw;

    // sql.join([...], sep): { join: unknown[], sep: unknown }. `sep` is
    // `undefined` only when the caller passed no separator to `sql.join`
    // (real drizzle-orm treats that as no separator, not an error).
    if (Array.isArray(obj.join)) {
      const sepText = obj.sep === null || typeof obj.sep === 'undefined' ? '' : renderSql(obj.sep);
      return obj.join.map((fragment) => renderSql(fragment)).join(sepText);
    }

    // A real drizzle-orm SQL fragment leaking through: { queryChunks: [...] }
    if (Array.isArray(obj.queryChunks)) {
      return obj.queryChunks.map((chunk) => (typeof chunk === 'string' ? chunk : renderValue(chunk))).join('');
    }
  }

  throw unrecognizedShapeError('renderSql', value);
}
