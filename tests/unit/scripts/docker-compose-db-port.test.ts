/**
 * Pin that every service in `dev_env/docker-compose.yml` that consumes a
 * postgres container hardcodes its in-container `DB_PORT` to `5432` — the
 * port the postgres image actually listens on inside the docker network.
 *
 * Why: `DB_PORT` is a host-side concept (which port on the host the
 * postgres container is *exposed* on). Inside the docker network every
 * postgres container listens on its image-default `5432`. Conflating the
 * two — writing `DB_PORT=${DB_PORT:-5432}` in a consumer service's env —
 * lets a stray `.env` value (e.g. the dev profile's `DB_PORT=5436`) leak
 * into the consumer and break its in-network connection: it tries to dial
 * `ci-db:5436` while the container itself still listens on `5432`.
 *
 * Same shape as the closed BS#413 fix for `AUTH_PORT`. Origin: BS#959,
 * surfaced while debugging the local `ci:testmock` failure in BS#955.
 *
 * Host-port-mapping vars (`DB_PORT`, `CI_DB_PORT`, `E2E_DB_PORT`,
 * `ETL_PG_PORT`) are unchanged — those legitimately need env substitution
 * so different worktrees can use different host ports.
 *
 * Source-grep test (no docker, no PG) — same style as the adjacent
 * `lml-limiter-test-env.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const composePath = path.join(repoRoot, 'dev_env/docker-compose.yml');

const SERVICES_WITH_IN_CONTAINER_DB_PORT = [
  'db-init',
  'ci-db-init',
  'auth',
  'backend',
  'e2e-db-init',
  'e2e-auth',
  'e2e-backend',
  'etl-db-init',
] as const;

describe('docker-compose.yml in-container DB_PORT is hardcoded (BS#959)', () => {
  for (const service of SERVICES_WITH_IN_CONTAINER_DB_PORT) {
    it(`${service} sets DB_PORT=5432 with no env substitution`, () => {
      const block = extractServiceBlock(service);
      const dbPortLine = block.match(/^\s*-\s*DB_PORT=(.+)$/m)?.[1];
      expect(dbPortLine).toBeDefined();
      // The literal `5432` — not `${DB_PORT:-5432}` or any other substitution
      // form. The whole point is to decouple the in-container port from
      // host-side env vars; allowing a default value would let a stray
      // shell `DB_PORT=5436` slip through.
      expect(dbPortLine).toBe('5432');
    });
  }
});

/**
 * Extract a single docker-compose service block by name. Matches the
 * `^  <name>:` line and everything up to the next top-level service header
 * or end of file. Throws on miss so a typo or layout change surfaces
 * immediately rather than producing a silent empty match.
 */
function extractServiceBlock(name: string): string {
  const compose = fs.readFileSync(composePath, 'utf-8');
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`^\\s{2}${escaped}:[\\s\\S]*?(?=^\\s{2}\\w|(?![\\s\\S]))`, 'm');
  const block = compose.match(pattern)?.[0];
  if (!block) {
    throw new Error(`docker-compose service block not found: ${name}`);
  }
  return block;
}
