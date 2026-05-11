/**
 * Sanity check for the four wxyc_identity_match_* plpgsql functions
 * deployed by migration 0076.
 *
 * Three layers:
 *
 *   1. SHA pin freshness — `wxyc-etl-pin.txt` hashes match the vendored
 *      bytes at `vendor/wxyc-etl/`. Drift means re-vendor.
 *   2. Migration freshness — `shared/database/src/migrations/0076_*.sql`
 *      ends with `vendor/wxyc-etl/wxyc_identity_match_functions.sql`
 *      byte-for-byte. Prefix is the wrapper (CREATE EXTENSION + dictionary).
 *   3. PG smoke — each function returns the expected normalization for a
 *      small WXYC-canonical artist set. Not the full 252-row fixture
 *      (that lives in wxyc-etl); just enough to catch a deploy that
 *      shipped functions with different bodies than expected.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const postgres = require('postgres');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PIN_PATH = path.join(REPO_ROOT, 'wxyc-etl-pin.txt');
const VENDOR_RULES = path.join(REPO_ROOT, 'vendor', 'wxyc-etl', 'wxyc_unaccent.rules');
const VENDOR_FUNCTIONS = path.join(REPO_ROOT, 'vendor', 'wxyc-etl', 'wxyc_identity_match_functions.sql');
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  'shared',
  'database',
  'src',
  'migrations',
  '0076_wxyc-identity-match-functions.sql'
);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parsePin() {
  const text = fs.readFileSync(PIN_PATH, 'utf8');
  const m = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    m[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return m;
}

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

describe('wxyc_identity_match_* deploy (#805)', () => {
  test('pin SHAs match vendored files', () => {
    const pin = parsePin();
    expect(sha256(VENDOR_RULES)).toBe(pin.unaccent_rules_sha256);
    expect(sha256(VENDOR_FUNCTIONS)).toBe(pin.functions_sql_sha256);
  });

  test('migration 0076 inlines vendored functions SQL byte-for-byte', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const canonical = fs.readFileSync(VENDOR_FUNCTIONS, 'utf8');
    const firstLine = canonical.split('\n')[0];
    const idx = migration.indexOf(firstLine);
    expect(idx).toBeGreaterThan(-1);
    expect(migration.slice(idx)).toBe(canonical);
  });

  describe('PG-deployed functions', () => {
    let sql;

    beforeAll(() => {
      sql = makeSql();
    });

    afterAll(async () => {
      if (sql) await sql.end();
    });

    test.each([
      // Canonical WXYC artists exercising the article-drop + paren-strip paths.
      // Pulled from wxycExampleArtists in @wxyc/shared/test-utils — small set
      // so a body-shape regression surfaces without dragging in the full
      // 252-row fixture (that's wxyc-etl's job).
      ['wxyc_identity_match_artist', 'Stereolab', 'stereolab'],
      ['wxyc_identity_match_artist', 'Cat Power', 'cat power'],
      ['wxyc_identity_match_artist', 'Juana Molina (Live)', 'juana molina'],
      ['wxyc_identity_match_artist', 'The Microphones', 'microphones'],
      ['wxyc_identity_match_artist', 'Hermanos Gutiérrez', 'hermanos gutierrez'],
      ['wxyc_identity_match_title', 'In a Sentimental Mood (Live)', 'in a sentimental mood'],
      ['wxyc_identity_match_title', 'Call Your Name', 'call your name'],
      ['wxyc_identity_match_with_punctuation', 'Godspeed You! Black Emperor', 'godspeed you black emperor'],
      ['wxyc_identity_match_with_punctuation', '10,000 Maniacs', '10 000 maniacs'],
      ['wxyc_identity_match_with_disambiguator_strip', 'Stereolab /1', 'stereolab'],
      ['wxyc_identity_match_with_disambiguator_strip', 'Track 1/12', 'track 1/12'],
    ])('%s(%s) → %s', async (fnName, input, expected) => {
      const rows = await sql.unsafe(`SELECT ${fnName}($1::text) AS out`, [input]);
      expect(rows[0].out).toBe(expected);
    });

    test('functions are idempotent', async () => {
      const probe = '   The Foo Fighters (1995)   ';
      for (const fnName of [
        'wxyc_identity_match_artist',
        'wxyc_identity_match_title',
        'wxyc_identity_match_with_punctuation',
        'wxyc_identity_match_with_disambiguator_strip',
      ]) {
        const once = (await sql.unsafe(`SELECT ${fnName}($1::text) AS out`, [probe]))[0].out;
        const twice = (await sql.unsafe(`SELECT ${fnName}($1::text) AS out`, [once]))[0].out;
        expect(twice).toBe(once);
      }
    });
  });
});
