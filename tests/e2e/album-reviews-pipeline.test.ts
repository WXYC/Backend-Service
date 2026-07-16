/**
 * Album-Reviews Pipeline E2E Tests (ADR 0011)
 *
 * The full sheet → DB → link → API pipeline, end to end against a live
 * stack. Where the integration spec (`tests/integration/album-reviews.spec.js`)
 * seeds `album_review_submissions` with raw SQL and exercises only the
 * read endpoint, this suite runs the REAL ingestion:
 *
 *   1. Run the album-reviews ETL orchestrator against an in-memory sheet
 *      fixture — real header mapping + real UPSERT writer + real link
 *      pass — via `tests/e2e/support/album-reviews-fixture-run.ts`.
 *   2. Run it AGAIN, asserting the idempotent-nightly acceptance
 *      criterion: inserted=0, updated=0, everything `unchanged`.
 *   3. Read the rows back through the live `GET /album-reviews`,
 *      asserting the wire shape, the link-pass `album_id`, the artist
 *      filter, and — load-bearing — that reviewer PII never reaches the
 *      wire even though the ingested rows carry it in the DB.
 *
 * Prerequisites (the e2e Docker profile — `npm run e2e:env`):
 *   - e2e-db   reachable at E2E_DB_PORT (default 5434)
 *   - e2e-auth reachable at E2E_AUTH_PORT (default 8084)
 *   - e2e-backend reachable at E2E_BACKEND_PORT (default 8085), AUTH_BYPASS=false
 *
 * Run: npm run test:e2e -- tests/e2e/album-reviews-pipeline.test.ts
 */

import { execSync } from 'child_process';
import postgres from 'postgres';

const DB_PORT = process.env.E2E_DB_PORT || '5434';
const DB_NAME = process.env.DB_NAME || 'e2edb';
const DB_USER = process.env.DB_USERNAME || 'e2euser';
const DB_PASSWORD = process.env.DB_PASSWORD || 'e2epassword';
const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_BACKEND_PORT || '8085'}`;
const AUTH_URL = process.env.E2E_AUTH_URL || `http://localhost:${process.env.E2E_AUTH_PORT || '8084'}/auth`;

// The fixture rows' deterministic source keys: `form:` + the UTC instant of
// the sheet's ET wall-clock timestamp (EDT for the March row, EST for the
// January row) — the same derivation map.ts performs.
const JUANA_SOURCE_KEY = 'form:2021-03-15T17:45:12.000Z';
const PRATT_SOURCE_KEY = 'form:2015-01-21T03:10:05.000Z';
const ALL_SOURCE_KEYS = [JUANA_SOURCE_KEY, PRATT_SOURCE_KEY];

// ZZ ownership markers on the FK scaffolding (artists/genres/format), so
// cleanup can only ever delete this suite's own rows.
const LINK_ARTIST = 'Juana Molina';
const PROBE_GENRE = 'E2E AR Probe Genre';
const PROBE_FORMAT = 'E2E AR Probe Format';

const jobEnv = {
  ...process.env,
  DB_HOST: 'localhost',
  DB_PORT,
  DB_NAME,
  DB_USERNAME: DB_USER,
  DB_PASSWORD,
  WXYC_SCHEMA_NAME: SCHEMA,
  // Neutralize Sentry in the child job: without this, an inherited
  // SENTRY_DSN would flush fixture-run telemetry to production Sentry and
  // add the 2s Sentry.close() drain to every runNode.
  SENTRY_DSN: '',
  SENTRY_TRACES_SAMPLE_RATE: '0',
};

// stdio:'pipe' captures the child's output; on a non-zero exit execSync
// throws with that output buffered on the error, not printed. Surface it so
// a fixture drift is diagnosable from the failure message.
const runNode = (script: string): string => {
  try {
    return execSync(`npx tsx ${script}`, {
      env: jobEnv,
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 120000,
    }).toString();
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const stdout = e.stdout?.toString() ?? '';
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(`child failed: npx tsx ${script}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, {
      cause: err,
    });
  }
};

type EtlTotals = {
  fetched: number;
  valid: number;
  skipped_invalid: number;
  fallback_keys: number;
  duplicate_key_skipped: number;
  inserted: number;
  updated: number;
  unchanged: number;
  linked: number;
  link_ambiguous: number;
  link_unmatched: number;
};

/** The driver prints the run totals as the last JSON line on stdout;
 *  logger lines precede it, so scan from the end for a parseable object
 *  carrying the counter keys. */
const parseTotals = (stdout: string): EtlTotals => {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null && 'inserted' in parsed && 'linked' in parsed) {
        return parsed as EtlTotals;
      }
    } catch {
      // not a JSON line — keep scanning
    }
  }
  throw new Error(`album-reviews-fixture-run: no totals JSON found in stdout:\n${stdout}`);
};

/**
 * Anonymous session → JWT. `/album-reviews` is gated by
 * `requirePermissions({})`, which verifies a JWT against JWKS — so the
 * anonymous *session* token from `/sign-in/anonymous` must be exchanged at
 * `/auth/token` for the JWT the backend will honour.
 */
async function getAnonymousJwt(): Promise<string> {
  const signIn = await fetch(`${AUTH_URL}/sign-in/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!signIn.ok) throw new Error(`anonymous sign-in failed: ${signIn.status} ${await signIn.text().catch(() => '')}`);
  const sessionToken =
    signIn.headers.get('set-auth-token') || ((await signIn.json().catch(() => ({}))) as { token?: string }).token;
  if (!sessionToken) throw new Error('no session token from anonymous sign-in');

  const tokenRes = await fetch(`${AUTH_URL}/token`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  if (!tokenRes.ok)
    throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text().catch(() => '')}`);
  const jwt = ((await tokenRes.json()) as { token?: string }).token;
  if (!jwt) throw new Error('no JWT returned from /auth/token');
  return jwt;
}

let pg: ReturnType<typeof postgres>;
let authToken: string;
let libraryId: number;
let firstRun: EtlTotals;
let secondRun: EtlTotals;

interface SubmissionRow {
  id: number;
  source_key: string;
  album_id: number | null;
  reviewer_raw: string | null;
  norm_artist: string | null;
}

/** This suite's submission rows, straight from the DB. */
const ingestedRows = async (): Promise<SubmissionRow[]> =>
  pg<SubmissionRow[]>`
    SELECT id, source_key, album_id, reviewer_raw, norm_artist
    FROM ${pg(SCHEMA)}.album_review_submissions
    WHERE source_key = ANY(${ALL_SOURCE_KEYS})
    ORDER BY source_key ASC
  `;

const cleanup = async (): Promise<void> => {
  await pg`DELETE FROM ${pg(SCHEMA)}.album_review_submissions WHERE source_key = ANY(${ALL_SOURCE_KEYS})`;
  await pg`DELETE FROM ${pg(SCHEMA)}.library
            WHERE artist_id IN (SELECT id FROM ${pg(SCHEMA)}.artists WHERE artist_name = ${LINK_ARTIST} AND code_letters = 'ZZ')`;
  await pg`DELETE FROM ${pg(SCHEMA)}.artists WHERE artist_name = ${LINK_ARTIST} AND code_letters = 'ZZ'`;
  await pg`DELETE FROM ${pg(SCHEMA)}.genres WHERE genre_name = ${PROBE_GENRE}`;
  await pg`DELETE FROM ${pg(SCHEMA)}.format WHERE format_name = ${PROBE_FORMAT}`;
};

beforeAll(async () => {
  pg = postgres(`postgres://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}`, { max: 1, onnotice: () => {} });
  await cleanup(); // idempotent across re-runs on the shared e2e schema

  // FK scaffolding so the link pass has a SINGLETON library match for the
  // Juana Molina / DOGA fixture row. The Jessica Pratt row deliberately has
  // no library twin — the negative link arm.
  const [genre] = await pg`INSERT INTO ${pg(SCHEMA)}.genres (genre_name) VALUES (${PROBE_GENRE}) RETURNING id`;
  const [format] = await pg`INSERT INTO ${pg(SCHEMA)}.format (format_name) VALUES (${PROBE_FORMAT}) RETURNING id`;
  const [artist] = await pg`
    INSERT INTO ${pg(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
    VALUES (${LINK_ARTIST}, ${LINK_ARTIST}, 'ZZ') RETURNING id
  `;
  const [lib] = await pg`
    INSERT INTO ${pg(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES (${(artist as { id: number }).id}, ${(genre as { id: number }).id}, ${(format as { id: number }).id},
            'DOGA', 9201, ${LINK_ARTIST})
    RETURNING id
  `;
  libraryId = (lib as { id: number }).id;

  authToken = await getAnonymousJwt();

  // 1. Ingest the fixture sheet (map → upsert → link), twice: the second
  // run pins nightly idempotency against an unchanged sheet.
  firstRun = parseTotals(runNode('tests/e2e/support/album-reviews-fixture-run.ts'));
  secondRun = parseTotals(runNode('tests/e2e/support/album-reviews-fixture-run.ts'));
}, 180000);

afterAll(async () => {
  await cleanup();
  await pg.end();
});

describe('ingest step (album-reviews-etl → album_review_submissions)', () => {
  it('lands both valid fixture rows and drops the formula-residue junk row', async () => {
    expect(firstRun).toMatchObject({
      fetched: 3,
      valid: 2,
      skipped_invalid: 1,
      fallback_keys: 0,
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    const rows = await ingestedRows();
    expect(rows.map((r) => r.source_key)).toEqual([PRATT_SOURCE_KEY, JUANA_SOURCE_KEY]);
  });

  it('keeps reviewer PII in the DB (internal curation) — the wire assertions below prove it stays there', async () => {
    const rows = await ingestedRows();
    const juana = rows.find((r) => r.source_key === JUANA_SOURCE_KEY);
    expect(juana?.reviewer_raw).toBe('A Real Name, 3/15/21');
  });

  it('is idempotent on the second run against an unchanged sheet', () => {
    expect(secondRun).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
  });
});

describe('link step (singleton library match)', () => {
  it('links the row with exactly one library match and leaves the other unmatched', async () => {
    expect(firstRun).toMatchObject({ linked: 1, link_ambiguous: 0, link_unmatched: 1 });
    const rows = await ingestedRows();
    const juana = rows.find((r) => r.source_key === JUANA_SOURCE_KEY);
    const pratt = rows.find((r) => r.source_key === PRATT_SOURCE_KEY);
    expect(juana?.album_id).toBe(libraryId);
    expect(pratt?.album_id).toBeNull();
  });
});

describe('read step (GET /album-reviews)', () => {
  const getAlbumReviews = async (query: string): Promise<any> => {
    const res = await fetch(`${BASE_URL}/album-reviews?${query}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('returns 401 without a bearer token', async () => {
    const res = await fetch(`${BASE_URL}/album-reviews`);
    expect(res.status).toBe(401);
  });

  it('round-trips the linked row through the artist filter with the full wire shape', async () => {
    const body = await getAlbumReviews('artist=juana%20molina&limit=100');
    const rows = (body.album_reviews as any[]).filter((r) => r.album_id === libraryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      album_id: libraryId,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      record_label: 'Sonamos',
      review: 'Hypnotic layered loops; a late-night staple.',
      recommended_tracks: '1, 3 (!!!!), 5',
      buzzwords: 'hypnotic, electronic, folk',
      fcc_violations: 'None',
      review_purpose: 'Rotation',
      rotated: true,
      released_within_six_months: true,
      social_consent: true,
      submitted_at: '2021-03-15T17:45:12.000Z',
    });
  });

  it('serves the unlinked row through the album_id-less listing', async () => {
    const body = await getAlbumReviews('artist=jessica%20pratt&limit=100');
    const rows = (body.album_reviews as any[]).filter((r) => r.artist_name === 'Jessica Pratt');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const pratt = rows.find((r) => r.album_title === 'On Your Own Love Again');
    expect(pratt).toBeDefined();
    expect(pratt.album_id).toBeNull();
    expect(pratt.rotated).toBe(false);
    expect(pratt.submitted_at).toBe('2015-01-21T03:10:05.000Z');
  });

  it('NEVER exposes reviewer PII on the wire — the rows carry it in the DB', async () => {
    // The ingest step proved reviewer_raw is populated in the DB; this is
    // the wire-level exclusion (absent keys, not nulls).
    const body = await getAlbumReviews(`album_id=${libraryId}&limit=100`);
    expect((body.album_reviews as any[]).length).toBeGreaterThanOrEqual(1);
    for (const row of body.album_reviews as any[]) {
      for (const internal of [
        'reviewer_raw',
        'social_consent_raw',
        'source',
        'source_key',
        'norm_artist',
        'norm_album',
        'add_date',
        'last_modified',
      ]) {
        expect(row).not.toHaveProperty(internal);
      }
    }
  });
});
