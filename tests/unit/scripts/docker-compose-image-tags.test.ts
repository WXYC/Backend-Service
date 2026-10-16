/**
 * Pin that the image tags `dev_env/docker-compose.yml` runs and the
 * `docker:build` scripts mint are parameterized, so two worktrees that each
 * set their own tag cannot overwrite each other's images (BS#2442).
 *
 * `COMPOSE_PROJECT_NAME` namespaces containers, networks and volumes, but a
 * Docker image tag is global to the daemon. With the tag hard-coded, every
 * worktree's build re-pointed the same `wxyc_backend_service:ci`, and a
 * container created after a peer's build ran the peer's code under this
 * worktree's test suite.
 *
 * The tag variable is opt-in and defaults to the old literal, because a tag
 * derived from `COMPOSE_PROJECT_NAME` could not keep that default: the compose
 * file declares `name: wxyc-backend`.
 *
 * `wxyc-db-init-image` is deliberately left shared: it holds only
 * init-db.mjs, format-pg-error.mjs and package.init.json, while migrations
 * and schema are bind-mounted per worktree.
 *
 * Source-grep test (no docker, no PG) -- same style as the adjacent
 * `docker-compose-project-isolation.test.ts`.
 */
/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path read here is joined onto `repoRoot`, itself derived from
 * `__dirname`, from a literal list in this file. No caller-supplied input. */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), 'utf-8');
const compose = read('dev_env/docker-compose.yml');

const COMPOSE_IMAGES: Array<[string, string]> = [
  ['wxyc_auth_service', 'CI_IMAGE_TAG:-ci'],
  ['wxyc-mock-api', 'CI_IMAGE_TAG:-ci'],
  ['wxyc_backend_service', 'CI_IMAGE_TAG:-ci'],
  ['wxyc_auth_service', 'E2E_IMAGE_TAG:-e2e'],
  ['wxyc_backend_service', 'E2E_IMAGE_TAG:-e2e'],
];

describe('compose image tags are parameterized', () => {
  it.each(COMPOSE_IMAGES)('%s carries ${%s}', (repository, tagExpression) => {
    expect(compose).toContain(`image: ${repository}:\${${tagExpression}}`);
  });

  it('hard-codes no :ci or :e2e tag', () => {
    expect(compose).not.toMatch(/^\s*image:\s*\S+:(ci|e2e)\s*$/m);
  });
});

describe('docker:build scripts mint the parameterized tag', () => {
  it.each([
    ['apps/backend/package.json', 'wxyc_backend_service'],
    ['apps/auth/package.json', 'wxyc_auth_service'],
  ])('%s tags %s with ${CI_IMAGE_TAG:-ci}', (file, repository) => {
    const { scripts } = JSON.parse(read(file)) as { scripts: Record<string, string> };
    expect(scripts['docker:build']).toContain(`-t ${repository}:\${CI_IMAGE_TAG:-ci}`);
  });
});

describe('scripts/ci-env.sh', () => {
  it('resolves CI_IMAGE_TAG from .env before it builds, so compose and docker:build agree', () => {
    // Mutation caught: deleting the `export CI_IMAGE_TAG=...` line (or moving it
    // below `npm run ci:build`) fails this test. Comment lines are ignored, so
    // the explanatory comment above the export cannot satisfy it on its own.
    const lines = read('scripts/ci-env.sh')
      .split('\n')
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => !line.startsWith('#'));
    const exportLine = lines.find(({ line }) => /^export CI_IMAGE_TAG=.*dotenvx get CI_IMAGE_TAG/.test(line));
    const build = lines.find(({ line }) => line.startsWith('npm run ci:build'));
    expect(exportLine).toBeDefined();
    expect(build).toBeDefined();
    expect(exportLine.index).toBeLessThan(build.index);
  });
});
