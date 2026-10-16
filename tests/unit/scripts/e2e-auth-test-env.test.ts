/**
 * Pin the E2E auth stack's test-env posture (BS#1690).
 *
 * 1. The `e2e-auth` compose service must run with `NODE_ENV=test`. The image
 *    inherits `ENV NODE_ENV=production` from `Dockerfile.auth`, which mounts
 *    both sign-in limiters (the Express ones in `apps/auth/app.ts` and
 *    better-auth's built-in one, whose `enabled` defaults to `isProduction`).
 *    dj-site's `auth.setup.ts` signs in 5+ users per run, so a few back-to-back
 *    runs 429 every user. The production image must keep its pin, or the
 *    override above would be the only thing standing between prod and an
 *    unthrottled sign-in.
 *
 * 2. `dev_env/seed_db.sql` seeds one deterministic session per dj-site E2E
 *    user (fixed literal token, fixed far-future expiry) so dj-site can cache
 *    storage states across CI runs. The seed never reaches production:
 *    `Dockerfile.migrate` sets `SKIP_SEED=true` and does not copy it.
 *
 * Source-grep test (no docker, no PG) — same style as the adjacent
 * `docker-compose-db-port.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');

const SEEDED_SESSION_USERS = [
  'test-member-id-000000000000000001',
  'test-dj1-id-00000000000000000001',
  'test-dj2-id-00000000000000000002',
  'test-md-id-0000000000000000001',
  'test-sm-id-0000000000000000001',
] as const;

describe('e2e-auth sign-in rate limit under test (BS#1690)', () => {
  it('sets NODE_ENV=test on the e2e-auth compose service', () => {
    expect(extractServiceBlock('e2e-auth')).toMatch(/^\s*-\s*NODE_ENV=test\s*$/m);
  });

  it('keeps the production image pinned to NODE_ENV=production so its limiters stay mounted', () => {
    expect(read('Dockerfile.auth')).toMatch(/^ENV NODE_ENV=production\s*$/m);
  });

  it('never ships the seed to production', () => {
    const migrateDockerfile = read('Dockerfile.migrate');
    expect(migrateDockerfile).toMatch(/^ENV SKIP_SEED='true'\s*$/m);
    expect(migrateDockerfile).not.toMatch(/seed_db\.sql/);
  });
});

describe('seeded deterministic E2E sessions (BS#1690)', () => {
  const seed = read('dev_env/seed_db.sql');
  const sessionInsert = seed.match(/INSERT INTO auth_session[\s\S]*?;\n/)?.[0] ?? '';

  it('inserts an auth_session row', () => {
    expect(sessionInsert).not.toBe('');
  });

  it.each(SEEDED_SESSION_USERS)('seeds a session for %s with a literal token and fixed expiry', (userId) => {
    const row = sessionInsert.split('\n').find((line) => line.includes(`'${userId}'`));
    expect(row).toBeDefined();
    // No NOW()/random() in the token or expiry: the whole point is that the
    // same value comes back after every reseed.
    expect(row).toMatch(/'e2e-session-token-[a-z0-9-]+'/);
    expect(row).toMatch(/TIMESTAMPTZ '20[3-9]\d-\d\d-\d\d/);
  });

  it('is idempotent across re-runs of the seed', () => {
    expect(sessionInsert).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
  });
});

/**
 * Extract a single docker-compose service block by name (see
 * `docker-compose-db-port.test.ts`). Throws on miss so a layout change
 * surfaces immediately.
 */
function extractServiceBlock(name: string): string {
  const compose = read('dev_env/docker-compose.yml');
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`^\\s{2}${escaped}:[\\s\\S]*?(?=^\\s{2}\\w|(?![\\s\\S]))`, 'm');
  const block = compose.match(pattern)?.[0];
  if (!block) {
    throw new Error(`docker-compose service block not found: ${name}`);
  }
  return block;
}
