/**
 * Concerts Pipeline E2E Tests (touring events)
 *
 * The full scraper → DB → resolver → API pipeline, end to end against a live
 * stack. Where the integration spec (`tests/integration/concerts.spec.js`)
 * seeds `concerts` with raw SQL and exercises only the read endpoint, this
 * suite runs the REAL ingestion:
 *
 *   1. Run the venue-events-scraper (RHP) orchestrator against committed
 *      Cat's Cradle HTML fixtures — real parse + real DB writer — landing
 *      rows in `concerts` with `headlining_artist_id` still NULL.
 *   2. Run the concerts-artist-resolver job — a pure local `artists` join
 *      (no LML) — which stamps `headlining_artist_id` on the row whose
 *      billing matches a seeded canonical artist.
 *   3. Read the rows back through the live `GET /concerts`, asserting the
 *      wire shape and that `curated=true` returns exactly the resolved row.
 *
 * The venue-events-scraper is the representative source: it shares the writer,
 * resolver, and read-API tail with triangle-shows-etl (whose source-specific
 * logic — status enum, 16-venue partition — is covered by its unit suite).
 *
 * Prerequisites (the e2e Docker profile — `npm run e2e:env`):
 *   - e2e-db   reachable at E2E_DB_PORT (default 5434)
 *   - e2e-auth reachable at E2E_AUTH_PORT (default 8084)
 *   - e2e-backend reachable at E2E_BACKEND_PORT (default 8085), AUTH_BYPASS=false
 *
 * Run: npm run test:e2e -- tests/e2e/concerts-pipeline.test.ts
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

// Billing strings the committed Cat's Cradle fixtures parse to.
const HEADLINER_RESOLVED = 'Aaron Lee Tasjan'; // seeded as a canonical artist → resolver stamps its FK
const HEADLINER_UNRESOLVED_A = 'Sleater-Kinney';
const HEADLINER_UNRESOLVED_B = 'The Headliner';
const ALL_HEADLINERS = [HEADLINER_RESOLVED, HEADLINER_UNRESOLVED_A, HEADLINER_UNRESOLVED_B];

const jobEnv = {
  ...process.env,
  DB_HOST: 'localhost',
  DB_PORT,
  DB_NAME,
  DB_USERNAME: DB_USER,
  DB_PASSWORD,
  WXYC_SCHEMA_NAME: SCHEMA,
};

const runNode = (script: string): string =>
  execSync(`npx tsx ${script}`, { env: jobEnv, cwd: process.cwd(), stdio: 'pipe', timeout: 120000 }).toString();

interface ConcertRow {
  id: number;
  source: string;
  source_id: string;
  headlining_artist_raw: string;
  headlining_artist_id: number | null;
  event_url: string | null;
  venue_slug: string;
}

let pg: ReturnType<typeof postgres>;
let resolvedArtistId: number;
let headlinerIdAfterScrape: number | null | undefined;

/**
 * Anonymous session → JWT. `/concerts` is gated by `requirePermissions({})`,
 * which verifies a JWT against JWKS — so the anonymous *session* token from
 * `/sign-in/anonymous` (which `/proxy`'s session middleware accepts directly)
 * must be exchanged at `/auth/token` for the JWT the backend will honour.
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

let authToken: string;

/** All rhp_scrape concert rows for this suite's fixtures, joined to venue slug. */
const scrapedRows = async (): Promise<ConcertRow[]> =>
  pg<ConcertRow[]>`
    SELECT c.id, c.source, c.source_id, c.headlining_artist_raw, c.headlining_artist_id,
           c.event_url, v.slug AS venue_slug
    FROM ${pg(SCHEMA)}.concerts c
    JOIN ${pg(SCHEMA)}.venues v ON v.id = c.venue_id
    WHERE c.source = 'rhp_scrape'
      AND c.headlining_artist_raw = ANY(${ALL_HEADLINERS})
    ORDER BY c.headlining_artist_raw ASC
  `;

const cleanup = async (): Promise<void> => {
  await pg`DELETE FROM ${pg(SCHEMA)}.concerts WHERE source = 'rhp_scrape' AND headlining_artist_raw = ANY(${ALL_HEADLINERS})`;
  await pg`DELETE FROM ${pg(SCHEMA)}.artists WHERE artist_name = ${HEADLINER_RESOLVED}`;
};

beforeAll(async () => {
  pg = postgres(`postgres://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}`, { max: 1, onnotice: () => {} });
  await cleanup(); // idempotent across re-runs on the shared e2e schema

  // Seed the canonical artist the resolver's strict local join will match.
  const [artist] = await pg`
    INSERT INTO ${pg(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
    VALUES (${HEADLINER_RESOLVED}, ${HEADLINER_RESOLVED}, 'ZZ')
    RETURNING id
  `;
  resolvedArtistId = (artist as { id: number }).id;

  authToken = await getAnonymousJwt();

  // 1. Scrape the fixtures into `concerts` (headlining_artist_id NULL).
  runNode('tests/e2e/support/venue-events-fixture-run.ts');

  const afterScrape = await scrapedRows();
  headlinerIdAfterScrape = afterScrape.find(
    (r) => r.headlining_artist_raw === HEADLINER_RESOLVED
  )?.headlining_artist_id;

  // 2. Resolve billing → canonical artist FK.
  runNode('jobs/concerts-artist-resolver/job.ts');
}, 180000);

afterAll(async () => {
  await cleanup();
  await pg.end();
});

describe('scrape step (venue-events-scraper → concerts)', () => {
  it('lands all three fixture events as rhp_scrape rows', async () => {
    const rows = await scrapedRows();
    expect(rows.map((r) => r.headlining_artist_raw)).toEqual([...ALL_HEADLINERS].sort());
  });

  it('attaches the seeded venue and carries source-specific columns', async () => {
    const rows = await scrapedRows();
    // The Aaron Lee Tasjan fixture is in the Back Room; the other two the main room.
    const aaron = rows.find((r) => r.headlining_artist_raw === HEADLINER_RESOLVED);
    expect(aaron.venue_slug).toBe('cats-cradle-back-room');
    expect(aaron.source_id).toContain('cats-cradle');
    for (const r of rows) {
      expect(['cats-cradle', 'cats-cradle-back-room']).toContain(r.venue_slug);
    }
  });

  it('leaves headlining_artist_id NULL before the resolver runs', () => {
    // Captured in beforeAll between the scrape and resolve steps.
    expect(headlinerIdAfterScrape).toBeNull();
  });
});

describe('resolve step (concerts-artist-resolver)', () => {
  it('stamps headlining_artist_id on the row whose billing matches a canonical artist', async () => {
    const rows = await scrapedRows();
    const aaron = rows.find((r) => r.headlining_artist_raw === HEADLINER_RESOLVED);
    expect(aaron.headlining_artist_id).toBe(resolvedArtistId);
  });

  it('leaves unmatched billings unresolved', async () => {
    const rows = await scrapedRows();
    for (const name of [HEADLINER_UNRESOLVED_A, HEADLINER_UNRESOLVED_B]) {
      const row = rows.find((r) => r.headlining_artist_raw === name);
      expect(row.headlining_artist_id).toBeNull();
    }
  });
});

describe('read step (GET /concerts)', () => {
  const getConcerts = async (query = ''): Promise<any> => {
    const res = await fetch(`${BASE_URL}/concerts${query}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    return res.json();
  };

  /** Concerts in a response that belong to this suite's fixtures. */
  const mine = (body: any): any[] => body.concerts.filter((c: any) => ALL_HEADLINERS.includes(c.headlining_artist_raw));

  it('surfaces all three scraped concerts through the live endpoint', async () => {
    const body = await getConcerts('?limit=100');
    const rows = mine(body);
    expect(rows.map((c) => c.headlining_artist_raw).sort()).toEqual([...ALL_HEADLINERS].sort());

    // The resolved row carries the FK on the wire; event pages have no
    // venue URL in these fixtures, so event_url is null (client falls back
    // to ticket_url) — asserting null (not absent) pins the projected key.
    const aaron = rows.find((c) => c.headlining_artist_raw === HEADLINER_RESOLVED)!;
    expect(aaron.headlining_artist_id).toBe(resolvedArtistId);
    expect(aaron).toHaveProperty('event_url');
    expect(aaron.venue.slug).toBe('cats-cradle-back-room');
  });

  it('returns only the resolver-stamped row for curated=true', async () => {
    const body = await getConcerts('?curated=true&limit=100');
    const rows = mine(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].headlining_artist_raw).toBe(HEADLINER_RESOLVED);
    expect(rows[0].headlining_artist_id).toBe(resolvedArtistId);
  });
});
