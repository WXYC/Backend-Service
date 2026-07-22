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

## CI/CD workflow

GitHub Actions workflow (`.github/workflows/test.yml`) runs on PRs to `main`:

1. **detect-changes** — Paths-filter identifies what changed (apps, jobs, shared, tests, db-init)
2. **lint-and-typecheck** — `typecheck` + `lint` + `format:check` + `build`
3. **unit-tests** — Runs affected tests only (`--changedSince=origin/<base>` on PRs)
4. **integration-tests** — Only if apps/jobs/shared/tests change. Docker images cached by commit SHA in ECR.
5. **migrate-dryrun** — Only when `db-init` paths change. Restores latest RDS snapshot, runs `dryrun-migrate.mjs`, tears down. Catches data-shape preconditions at PR-review time. Detail in [`deploy.md`](deploy.md).
