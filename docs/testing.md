# Testing

## Unit tests

```bash
npm run test:unit
```

- Config: `jest.unit.config.ts`
- Location: `tests/unit/**/*.test.ts`
- Setup: `tests/setup/unit.setup.ts`
- Database is mocked via `tests/mocks/database.mock.ts`
- No external dependencies required

## Integration tests

```bash
npm run db:start         # Requires Docker DB
npm run test:integration
```

- Config: `jest.config.json`
- Location: `tests/integration/**/*.spec.js`
- Setup: `tests/setup/integration.setup.js` with `tests/setup/globalSetup.js`
- Tests run sequentially (`--runInBand`) because they share show state, DJ sessions, and flowsheet entries
- 30-second timeout per test
- Generates HTML report at `tests/report/report.html`

## CI mock

```bash
npm run ci:testmock      # Sets up Docker env, runs tests, cleans up
```

Or manually:

```bash
npm run ci:env           # Start sandboxed Docker environment
npm run ci:test          # Run tests against CI environment
npm run ci:clean         # Tear down containers, volumes, networks
```

The CI environment uses `dev_env/docker-compose.yml` with Docker profiles (`ci`, `e2e`).

Every profile in that file belongs to the Compose project it declares (`name: wxyc-backend`), shared by every checkout of this repo. Two worktrees running `ci:testmock` at the same time therefore fight over the same containers and the same host ports; give one of them a `COMPOSE_PROJECT_NAME` and its own `CI_DB_PORT` / `CI_PORT` / `CI_AUTH_PORT` / `MOCK_API_PORT` in that worktree's `.env` if you need them concurrent. See `docs/dev-db-fixture.md` for the full rationale.

`CI_DB_PORT` (default `15433`) is the host port the ci-db container publishes on, read by `dev_env/docker-compose.yml`, `dev_env/db_setup.sh`, and — via the shared resolver `scripts/ci-env-vars.sh` — `scripts/ci-test.sh` and `scripts/ci-test-parallel.sh` (the script backing the `ci:test:parallel` npm command). `scripts/ci-env-vars.sh` resolves `CI_PORT` / `CI_AUTH_PORT` / `CI_DB_PORT` / `CI_BETTER_AUTH_URL` from the same `.env` file compose's `--env-file` reads, using `dotenvx get` — the same parser `dotenvx run -f .env` uses to launch jest — so the two can never disagree about what a line in `.env` means. Precedence, highest first: a non-empty explicit shell export, then the value in `.env`, then the hard-coded default; see the header of `scripts/ci-env-vars.sh` for the full chain (BS#2348). `CI_DB_PORT` itself defaults outside the org's contested local-Postgres band (5433 discogs-cache, 5434 musicbrainz-cache/staging, 5435 wikidata-cache, 5442 BS dev DB — see the org CLAUDE.md) so `ci:testmock` doesn't silently connect to a native listener on one of those ports instead of the Docker-mapped ci-db. If `15433` is also taken on your machine, override it either in `.env` or via `CI_DB_PORT=<port> npm run ci:testmock`.

### Running the integration tier from a fresh worktree

Seven things beyond the above are needed for a green run in a checkout that has never run this tier. Each fails in a way that does not look like its cause, which is why they are written down (BS#2410).

**1. Give the worktree its own Compose project and its own five ports, in its `.env`.** This is the per-worktree form of the paragraph above, and it is not hypothetical — several Backend worktrees are typically live at once, and without it two of them share containers, host ports, and the ci-db volume. Pick a port block nobody else is on (check with `lsof -nP -iTCP:<port> -sTCP:LISTEN`) and keep `CI_BETTER_AUTH_URL` in step with `CI_AUTH_PORT` — a bare `BETTER_AUTH_URL` in `.env` is a _different_ key and does not move with it:

```
COMPOSE_PROJECT_NAME=wxyc-bs<issue>-<slug>
CI_DB_PORT=15461
CI_PORT=18081
CI_AUTH_PORT=18083
CI_BETTER_AUTH_URL=http://localhost:18083/auth
MOCK_API_PORT=19090
```

**2. `COMPOSE_PROJECT_NAME` isolates containers, ports and volumes — it does NOT isolate the image tag.** `dev_env/docker-compose.yml` hardcodes `image: wxyc_backend_service:ci` (likewise `wxyc_auth_service:ci`, `wxyc-mock-api:ci`), so every worktree's `npm run ci:env` **overwrites the same tag**. A container created or recreated after a peer's build therefore starts from the peer's code, in your project, on your ports, against your database. An already-running container keeps the image it started with, which is why this only bites intermittently.

The symptom is distinctive and worth recognising immediately: **your suite fails on your own new endpoint or behavior while everything else stays green.** That is a peer's image running your tests, not a defect in your branch — the inverse of the "everything fails at once" harness signature below. Confirm with `docker inspect --format '{{.Image}}' <project>-backend-1` against the image id your build produced.

Build your own tag and override just that service. This touches no repo file, so it cannot collide with anyone:

```bash
docker build --build-arg NPM_TOKEN="$(gh auth token)" -t wxyc_backend_service:<slug> -f Dockerfile.backend .
printf 'services:\n  backend:\n    image: wxyc_backend_service:<slug>\n' > /tmp/compose.<slug>.yml
docker compose -f dev_env/docker-compose.yml -f /tmp/compose.<slug>.yml --env-file .env --profile ci \
  up -d --force-recreate backend
```

**3. `MOCK_API_PORT` must ALSO be exported into the shell that runs `ci:test`.** `scripts/ci-env-vars.sh` resolves four of those five keys out of `.env` (BS#2348) — `MOCK_API_PORT` is not one of them. `scripts/ci-test.sh` builds `MOCK_API_URL=http://localhost:${MOCK_API_PORT:-9090}` from the **shell** only, so an offset port that lives only in `.env` reaches compose (which publishes the mock on it) and not jest (which still probes 9090). Three suites then fail with "MOCK_API_URL is set but mock-api-server is unreachable" — `library-tracks`, `compilation-tracks`, `library-legacy-release-id-exposure` — which reads like a dead mock server rather than a port mismatch. Run `MOCK_API_PORT=<port> npm run ci:test`; closing the resolver gap is BS#2441.

**4. Set `DEFAULT_ORG_SLUG` and `DEFAULT_ORG_NAME` in `.env`.** The compose file passes both through unconditionally (`- DEFAULT_ORG_SLUG=${DEFAULT_ORG_SLUG}`, no `:-` default), so leaving them out hands the auth container an empty slug. The org bootstrap then creates nothing, and `station-signup.spec.js` fails with 500s while `auth-auto-membership.spec.js` finds no `auth_member` row — neither of which names the variable. `test-org` / `Test Organization` are what the e2e profile hardcodes for the same services.

**5. `npm run build` first.** Seven integration suites `require()` a compiled job bundle (`jobs/*/dist/*.cjs`) rather than importing TypeScript — `library-call-number-dedup-merge`, `artist-unicode-dedup-merge`, `digital-archive-bind-write`, `enrichment-worker-streaming-toctou`, `metadata-no-match-digest`, `station-signup-review`, `va-apple-music-url-remediation-invalidate`. A fresh worktree has no `dist/`, and they fail with "Cannot find module", which reads like a broken import rather than a missing build step. CI's own pipeline builds before the integration job for the same reason.

**6. `NPM_TOKEN` must be set for the image build.** `npm run ci:env` builds the backend and auth images, and `apps/backend` depends on `@wxyc/shared` from GitHub Packages; `.npmrc` reads the token from `${NPM_TOKEN}`. An unset token fails the image build at `npm ci` with a 401 that names the registry, not the variable. `NPM_TOKEN=$(gh auth token) npm run ci:env` works if your `gh` login carries `read:packages`.

**7. Start from a virgin `ci-db` volume.** The suite runs `--runInBand` and shares show/DJ/flowsheet state across spec files, so a database that absorbed a partial earlier run fails a large number of suites with residue-shaped errors ("expected 1 row, got 0"). Remove only your own project's volume by name — `docker volume rm <COMPOSE_PROJECT_NAME>_ci-pg-data` — never `docker volume prune`, `docker system prune`, or a bare `down -v` on the shared project: other volumes on the same machine hold production database clones that are expensive to rebuild. Note that `npm run ci:clean` **is** `down -v`, so it is only safe once the worktree has its own `COMPOSE_PROJECT_NAME` per point 1.

**Telling a harness failure from a code failure.** When a large set of suites fails at once, look at _which_ ones are green. If the suites covering your change pass while auth, webhook, and feature-flag suites fail, the problem is the harness, not the code — missing env fails in misleading ways (`ETL_NOTIFY_KEY` surfaces as webhook 401s, unset feature flags as 404s, `DEFAULT_ORG_SLUG` as station-signup 500s). The Docker-based `ci:env` flow wires all of those in `dev_env/docker-compose.yml`; running the services outside Docker does not, and also loses the `NODE_ENV=test` the compose file sets on both `auth` and `backend` (without which auth's sign-in rate limiter 429s the whole suite).

`flowsheet-upcoming-show.spec.js`'s scan-count ceiling is a known flake (BS#2194); one rerun is the established remedy, and two failed infrastructure attempts is the stop-and-ask ceiling — never loop retries.

## CI/CD workflow

GitHub Actions workflow (`.github/workflows/test.yml`) runs on PRs to `main`:

1. **detect-changes** — Paths-filter identifies what changed (apps, jobs, shared, tests, db-init)
2. **lint-and-typecheck** — `typecheck` + `lint` + `format:check` + `build`
3. **unit-tests** — Runs the full unit suite (`npm run test:unit:coverage`). Deliberately _not_ Jest's affected-tests mode: selection comes from the module dependency graph, so the ~52 specs that read a source file as text (`fs.readFileSync`) instead of importing it are invisible to a change in the file they guard (BS#2249). The job gates nothing and finishes well inside `lint-and-typecheck`, so the full run is effectively free. `tests/unit/scripts/ci-unit-tests-full-suite.test.ts` pins this.
4. **integration-tests** — Only if apps/jobs/shared/tests change. Docker images cached by commit SHA in ECR.
5. **migrate-dryrun** — Only when `db-init` paths change. Restores latest RDS snapshot, runs `dryrun-migrate.mjs`, tears down. Catches data-shape preconditions at PR-review time. Detail in [`deploy.md`](deploy.md).
