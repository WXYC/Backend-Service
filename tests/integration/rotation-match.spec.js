/**
 * Integration tests for `isActiveRotationMatch` (@wxyc/legacy-mirror,
 * BS#1821) against a REAL Postgres — not the `@wxyc/database` mock the
 * unit suite (tests/unit/middleware/legacy/rotation-match.mirror.test.ts)
 * uses.
 *
 * Coverage gap this closes: the unit suite `jest.mock('@wxyc/database', ...)`
 * and drives `mockDbExecute.mockResolvedValue(...)`, so the real postgres-js
 * serializer is never exercised. `isActiveRotationMatch` interpolates a JS
 * `Date` directly into a raw `sql`` template (`WHERE r2.add_date <=
 * ${addTime}::date AND (r2.kill_date IS NULL OR r2.kill_date >
 * ${addTime}::date)`), and Drizzle's postgres-js driver rebinds the
 * date-family outbound serializer to a passthrough, so the raw `Date`
 * reaches postgres-js's `Bind()` -> `b.str(date)` -> `Buffer.byteLength(date)`,
 * which throws `TypeError: ... Received an instance of Date`. The helper's
 * try/catch swallows that (`captureMirrorFailure('rotation_lookup', {
 * error: e }, 'warning')`) and returns `false` — so on the unfixed code,
 * EVERY call that reaches the query silently returns `false`, and the
 * #1432 rotation-badge mirror fallback never actually fires in production.
 * This spec imports and calls `isActiveRotationMatch` directly (no HTTP, no
 * mock) against a real rotation row, so a `Date`-bind regression fails
 * loudly instead of being absorbed by the catch branch.
 *
 * Fixture: a dedicated rotation row (cohort (b) — NULL album_id, denorm
 * artist/album snapshot), inserted here and torn down in afterAll, rather
 * than depending on the shared seed's rotation row 1 — mirrors the
 * "rotation_bin read-path fallback" describe block's convention in
 * tests/integration/flowsheet.spec.js:848+.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker
 * tier) plus a built `@wxyc/database` + `@wxyc/legacy-mirror` (`dist/`),
 * same as running the app itself — `@wxyc/legacy-mirror`'s package.json
 * `require` export resolves to `./dist/index.js`.
 */

// `@wxyc/legacy-mirror` -> `@wxyc/database` -> `drizzle-orm`. The repo-wide
// `tests/__mocks__/drizzle-orm.ts` manual mock (written for the ts-jest unit
// config, see jest.unit.config.ts) is a Jest node_modules manual mock, which
// Jest substitutes automatically for ANY test file that requires
// `drizzle-orm` — no `jest.mock(...)` call needed to trigger it — including
// this babel-jest-transformed integration spec, where that `.ts` mock file
// fails to parse (no TypeScript-stripping transform is registered for
// `jest.config.json`). `jest.unmock` opts this file back into the real
// `drizzle-orm` package so `@wxyc/database`'s real postgres-js driver runs,
// which is the entire point of this spec (BS#1821 is a real-driver bug the
// mocked unit suite cannot see).
jest.unmock('drizzle-orm');

const postgres = require('postgres');
const { isActiveRotationMatch } = require('@wxyc/legacy-mirror');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('isActiveRotationMatch against a real Postgres (BS#1821)', () => {
  let sql;
  let rotationId;

  beforeAll(async () => {
    sql = makeSql();
    // Active rotation row: add_date in the past, kill_date open-ended, so
    // any add_time from here forward falls inside the window.
    const inserted = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, artist_name, album_title, add_date, kill_date)
      VALUES (NULL, 'H', 'Jessica Pratt', 'On Your Own Love Again', '2024-01-01', NULL)
      RETURNING id
    `;
    rotationId = inserted[0].id;
  });

  afterAll(async () => {
    if (rotationId != null) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ${rotationId}`;
    }
    if (sql) await sql.end({ timeout: 5 });
  });

  test('returns true for a hand-typed (artist_name, album_title) matching an active rotation row', async () => {
    // On the unfixed code, the raw-Date bind throws inside db.execute(),
    // the catch branch swallows it, and this comes back false — the
    // exact regression BS#1821 exists to catch.
    const result = await isActiveRotationMatch({
      rotation_id: null,
      album_id: null,
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      add_time: new Date('2024-06-14T22:00:00Z'),
    });

    expect(result).toBe(true);
  });

  test('returns false for a non-matching (artist_name, album_title)', async () => {
    const result = await isActiveRotationMatch({
      rotation_id: null,
      album_id: null,
      artist_name: 'Not A Real Rotation Artist BS1821',
      album_title: 'Not A Real Rotation Album BS1821',
      add_time: new Date('2024-06-14T22:00:00Z'),
    });

    expect(result).toBe(false);
  });
});
