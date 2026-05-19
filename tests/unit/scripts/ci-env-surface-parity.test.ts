/**
 * Pin the env-var surface parity between the two CI integration-test paths
 * (BS#958):
 *
 *   1. `dev_env/docker-compose.yml` — the `backend` service env, used by
 *      `npm run ci:testmock` (the local docker-based repro).
 *   2. `.github/workflows/test.yml` — the workflow-level `env:` block plus
 *      the `Start services` step `env:` block, used by GHA CI which runs
 *      the backend as a host node process and does NOT load env from
 *      docker-compose.
 *
 * Per BS#164, the host-process model on CI is intentional. But the two env
 * surfaces drift independently and a new var landing in one but not the
 * other can silently break the integration suite — as happened in BS#955
 * with G4's `LML_CLIENT_MAX_CONCURRENT` + `LML_CLIENT_RATE_PER_MIN`. This
 * test treats today's divergence as the explicit allowlist; any new key
 * appearing in only one surface fails CI with a clear message pointing the
 * dev at either mirroring the var or amending the allowlist (with a brief
 * `Why:` line).
 *
 * Source-grep test (no docker, no PG). Same style as the adjacent
 * `lml-limiter-test-env.test.ts` and `docker-compose-db-port.test.ts`.
 *
 * # Updating the allowlist
 *
 * When you add a new env var to one of the two surfaces, the test will
 * fail. Two options:
 *
 *   - Preferred: mirror the var into the other surface. The integration
 *     suite gets the same behavior on both paths and the parity holds.
 *   - Otherwise: add the key to the appropriate `EXPECTED_ONLY_*` array
 *     below with a one-line `// Why:` comment explaining the divergence
 *     (e.g. "test-harness-only, never read by backend").
 *
 * The allowlist is intentionally explicit. Don't silently expand it — the
 * one-line `Why:` is the deliberate-thought receipt.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const composePath = path.join(repoRoot, 'dev_env/docker-compose.yml');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');

/**
 * Keys present in the compose `backend` env block but NOT in the workflow
 * env surface (top-level + Start services). Each entry must be justified.
 */
const EXPECTED_ONLY_IN_COMPOSE = [
  // Why: BETTER_AUTH service URLs differ between the docker network (auth:8080)
  // and host-process model (localhost:8083). The host-process path relies on
  // backend defaults that match its localhost network; the compose path
  // overrides for the docker hostname `auth`.
  'BETTER_AUTH_AUDIENCE',
  'BETTER_AUTH_ISSUER',
  'BETTER_AUTH_JWKS_URL',

  // Why: backend-side feature flags that activate the full track-search
  // fallback cascade in `tests/integration/library.spec.js` (Track 1 = CTA,
  // Track 2 = LML cross-ref). The workflow path doesn't set these; whether
  // that's a coverage gap on the workflow path is tracked separately and
  // out of scope for this guard.
  'CATALOG_TRACK_SEARCH_CTA_ENABLED',
  'CATALOG_TRACK_SEARCH_DISCOGS_ENABLED',

  // Why: AWS Cognito identifiers from the legacy auth flow. Compose sets
  // them via `.env` substitution; backend defaults work in the workflow's
  // host-process auth-bypass mode.
  'COGNITO_USERPOOL_ID',
  'DJ_APP_CLIENT_ID',

  // Why: DB host/port. Compose uses the docker network hostname `ci-db` on
  // in-container port `5432`; workflow uses backend defaults (`localhost`
  // + `5432`) that match the host-process network. DB_PORT in compose is
  // hardcoded `5432` after BS#959.
  'DB_HOST',
  'DB_PORT',

  // Why: metadata cache sizes. Compose substitutes from `.env` with
  // defaults that match prod; workflow relies on backend defaults.
  'METADATA_ALBUM_CACHE_MAX_SIZE',
  'METADATA_ARTIST_CACHE_MAX_SIZE',
  'METADATA_ROTATION_PRIORITY',

  // Why: rate-limit gating. Compose exposes `TEST_RATE_LIMITING` so the
  // `ci:env:full` script can flip the cap on and exercise the rate-limit
  // middleware; the workflow doesn't run that variant.
  'RATE_LIMIT_REGISTRATION_MAX',
  'RATE_LIMIT_REGISTRATION_WINDOW_MS',
  'RATE_LIMIT_REQUEST_MAX',
  'RATE_LIMIT_REQUEST_WINDOW_MS',
  'SIMULATE_SLACK_FAILURE',
  'TEST_RATE_LIMITING',
];

/**
 * Keys present in the workflow env surface but NOT in the compose
 * `backend` env block. Each entry must be justified.
 */
const EXPECTED_ONLY_IN_WORKFLOW = [
  // Why: integration-test login credential. Read by the test harness (e.g.
  // `tests/integration/setup/login.js`), not by the backend process.
  'AUTH_PASSWORD',

  // Why: CI-only auth URL alias used by the test harness when constructing
  // host-process URLs. Not read by the backend.
  'CI_BETTER_AUTH_URL',

  // Why: host port mappings. CI_DB_PORT and CI_PORT are read by
  // docker-compose externally (port-mapping resolution) on the local path;
  // on GHA the workflow exports them as a top-level convention so scripts
  // that share docker-compose semantics work in both places. Not read by
  // the backend process.
  'CI_DB_PORT',
  'CI_PORT',

  // Why: mock-api server addressing. Backend reads LIBRARY_METADATA_URL
  // (mirrored). MOCK_API_PORT + MOCK_API_URL exist for the harness side
  // (mock-server start command, test assertions about response bodies).
  'MOCK_API_PORT',
  'MOCK_API_URL',

  // Why: test-mode signal needed on the workflow's host-process model
  // (gates rate-limit middleware bypass, etc.). The compose backend
  // container doesn't set NODE_ENV but its test-mode behaviors are reached
  // via parallel gates (`TEST_RATE_LIMITING=false`, `AUTH_BYPASS=true`).
  // If a code path appears that requires NODE_ENV=test specifically and
  // can't reach it via those gates, this entry should move to "mirror in
  // both" — but that's a backend change, not a CI-env one.
  'NODE_ENV',

  // Why: workflow-level alias for CI_PORT used by certain non-test scripts
  // that read PORT (e.g. drizzle-kit migrations); harness-side.
  'PORT',

  // Why: backend-host URL for the integration test harness. Read by tests
  // when forming http requests; the backend itself doesn't bind based on
  // it (it binds on PORT).
  'TEST_HOST',
];

describe('CI env-var surface parity (BS#958)', () => {
  const composeKeys = extractComposeBackendEnvKeys();
  const workflowKeys = extractWorkflowEnvKeys();

  const actualOnlyInCompose = [...composeKeys].filter((k) => !workflowKeys.has(k)).sort();
  const actualOnlyInWorkflow = [...workflowKeys].filter((k) => !composeKeys.has(k)).sort();

  it('keys present only in dev_env/docker-compose.yml match the allowlist', () => {
    // Sort the allowlist for stable comparison; the source order in the
    // allowlist is grouped for readability.
    expect(actualOnlyInCompose).toEqual([...EXPECTED_ONLY_IN_COMPOSE].sort());
  });

  it('keys present only in .github/workflows/test.yml match the allowlist', () => {
    expect(actualOnlyInWorkflow).toEqual([...EXPECTED_ONLY_IN_WORKFLOW].sort());
  });
});

function extractComposeBackendEnvKeys(): Set<string> {
  const compose = fs.readFileSync(composePath, 'utf-8');
  const block = compose.match(/^\s{2}backend:[\s\S]*?(?=^\s{2}\w|(?![\s\S]))/m)?.[0];
  if (!block) {
    throw new Error('docker-compose `backend` service block not found');
  }
  const envIdx = block.indexOf('environment:');
  if (envIdx === -1) {
    throw new Error('docker-compose `backend` service has no `environment:` block');
  }
  const tail = block.slice(envIdx);
  const matches = [...tail.matchAll(/^\s*-\s*([A-Z][A-Z0-9_]*)=/gm)];
  return new Set(matches.map((m) => m[1]));
}

function extractWorkflowEnvKeys(): Set<string> {
  const workflow = fs.readFileSync(workflowPath, 'utf-8');

  // Top-level workflow env block (lines 15-28 today).
  const topMatch = workflow.match(/^env:\n((?:\s+[A-Z][A-Z0-9_]*:.*\n)+)/m);
  if (!topMatch) {
    throw new Error('workflow top-level `env:` block not found');
  }
  const topKeys = [...topMatch[1].matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);

  // `Start services` step env block.
  const startIdx = workflow.indexOf('- name: Start services');
  if (startIdx === -1) {
    throw new Error('workflow step `Start services` not found');
  }
  const stepSlice = workflow.slice(startIdx);
  const runIdx = stepSlice.indexOf('\n        run:');
  if (runIdx === -1) {
    throw new Error('workflow step `Start services` has no `run:` key');
  }
  const stepEnv = stepSlice.slice(0, runIdx);
  const stepKeys = [...stepEnv.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);

  return new Set([...topKeys, ...stepKeys]);
}
