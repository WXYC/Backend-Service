/**
 * Pin the Compose project namespacing of `dev_env/docker-compose.yml`.
 *
 * When a compose file declares no top-level `name:`, Compose derives the
 * project name from the directory holding the file — `dev_env` for every
 * clone and every worktree of this repo. All of them therefore addressed
 * ONE shared Compose project, so `db:stop` run from one tree tore down
 * another tree's containers and (with `-v`) deleted its seeded `pg-data`
 * volume. An explicit `name:` makes the project a single declared value
 * that `COMPOSE_PROJECT_NAME` can override per worktree.
 *
 * `container_name:` is the second half of the same collision. Container
 * names are global to the daemon, not scoped to a Compose project, so two
 * correctly-namespaced projects still cannot both create one: the second
 * fails with `Conflict. The container name "/wxyc-db-init" is already in
 * use`. Omitting the pin lets Compose prefix the project name.
 *
 * Removing those fixed names invalidates any command that addressed a
 * container by name, which is why the npm scripts are pinned here too: a
 * container-addressing `docker` subcommand in package.json must go through
 * `docker compose <sub> <service>`, which resolves the container from the
 * project instead of re-hardcoding a name.
 *
 * Source-grep test (no docker, no PG) — same style as the adjacent
 * `docker-compose-db-port.test.ts`.
 */
/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path read here is joined onto `repoRoot`, itself derived from
 * `__dirname`, from a literal list in this file. No caller-supplied input. */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const composePath = path.join(repoRoot, 'dev_env/docker-compose.yml');
const packageJsonPath = path.join(repoRoot, 'package.json');

const compose = fs.readFileSync(composePath, 'utf-8');
const scripts = (JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { scripts: Record<string, string> }).scripts;

/**
 * `docker` subcommands that address an individual container by name or id.
 * `docker compose <sub>` forms are exempt — those take a service name and
 * let Compose resolve the container within the project.
 */
const ADDRESSES_A_CONTAINER_BY_NAME =
  /\bdocker\s+(?!compose\b)(attach|exec|restart|start|stop|kill|rm|logs|inspect|cp)\b/;

/** The container-name shape Compose generated under the old `dev_env` project. */
const LEGACY_GENERATED_CONTAINER_NAME = /dev_env-[a-z0-9-]+-\d/;

/**
 * Files that named a container Compose generates. Each has to derive the
 * name from the declared project, or address the service through Compose.
 */
const FILES_THAT_NAMED_A_CONTAINER = [
  'package.json',
  'scripts/run-library-etl.sh',
  'tests/e2e/etl.test.ts',
  'tests/e2e/album-reviews-pipeline.test.ts',
];

describe('dev_env/docker-compose.yml declares its Compose project', () => {
  it('sets a top-level project name that is not the directory-derived default', () => {
    const declared = compose.match(/^name:\s*(\S+)\s*$/m)?.[1];
    expect(declared).toBeDefined();
    expect(declared).not.toBe('dev_env');
  });

  it('pins no container_name on any service', () => {
    const pinned = compose.split('\n').filter((line) => /^\s*container_name:/.test(line));
    expect(pinned).toEqual([]);
  });
});

describe('npm scripts reach containers through Compose', () => {
  const dockerScripts = Object.entries(scripts).filter(([, command]) => command.includes('docker'));

  it('has docker-driving scripts to check', () => {
    expect(dockerScripts.length).toBeGreaterThan(0);
  });

  it.each(dockerScripts)('%s addresses no container by a fixed name', (_name, command) => {
    expect(command).not.toMatch(ADDRESSES_A_CONTAINER_BY_NAME);
  });
});

describe('references to Compose-generated container names track the declared project', () => {
  const declaredProject = compose.match(/^name:\s*(\S+)\s*$/m)?.[1];

  it.each(FILES_THAT_NAMED_A_CONTAINER)('%s names no container from the old dev_env project', (file) => {
    const contents = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
    expect(contents).not.toMatch(LEGACY_GENERATED_CONTAINER_NAME);
  });

  it('the etl e2e suite defaults to the MySQL container of the declared project', () => {
    const etlTest = fs.readFileSync(path.join(repoRoot, 'tests/e2e/etl.test.ts'), 'utf-8');
    const fallback = etlTest.match(/ETL_MYSQL_CONTAINER\s*\|\|\s*'([^']+)'/)?.[1];
    expect(fallback).toBe(`${declaredProject}-etl-mysql-1`);
  });
});

describe('stopping the dev database keeps its data', () => {
  it('db:stop does not remove volumes', () => {
    expect(scripts['db:stop']).toBeDefined();
    expect(scripts['db:stop']).not.toMatch(/\s(-v|--volumes)\b/);
  });

  it('db:reset is the one dev-profile script that removes them', () => {
    expect(scripts['db:reset']).toMatch(/\bdown\b.*\s(-v|--volumes)\b/);
  });
});
