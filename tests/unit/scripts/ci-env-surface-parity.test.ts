/**
 * Pin the env-var surface parity between the two CI integration-test paths
 * (BS#958):
 *
 *   1. `dev_env/docker-compose.yml` — the `backend` service env, used by
 *      `npm run ci:testmock` (the local docker-based repro).
 *   2. `.github/workflows/test.yml` — used by GHA CI, which runs the
 *      backend as a host node process and does NOT load env from
 *      docker-compose. The workflow surface is the union of three YAML
 *      scopes the host-process backend inherits: the workflow-top-level
 *      `env:`, the `Integration-Tests` job-level `env:`, and the
 *      `Start services` step-level `env:`.
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
 * `lml-limiter-test-env.test.ts` and the other guards in
 * `tests/unit/scripts/`.
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
 * Keys present in the compose `backend` env block but NOT anywhere in the
 * workflow env surface (top-level + Integration-Tests job + Start services
 * step). Each entry must be justified.
 */
const EXPECTED_ONLY_IN_COMPOSE = [
  // Why: backend-side feature flags that activate the full track-search
  // fallback cascade in `tests/integration/library.spec.js` (Track 1 = CTA,
  // Track 2 = LML cross-ref). The workflow path doesn't set these; whether
  // that's a coverage gap on the workflow path is tracked separately and
  // out of scope for this guard.
  'CATALOG_TRACK_SEARCH_CTA_ENABLED',
  'CATALOG_TRACK_SEARCH_DISCOGS_ENABLED',

  // Why: artist-search-alias LATERAL JOIN flag (plan §PR 5). Compose flips it
  // on so `tests/integration/library-search-alias.spec.js` exercises the
  // LATERAL against a seeded variant. Workflow path doesn't run that spec;
  // whether that's a coverage gap is tracked separately.
  'CATALOG_SEARCH_ALIAS_ENABLED',

  // Why: AWS Cognito identifiers from the legacy auth flow. Compose sets
  // them via `.env` substitution; backend defaults work in the workflow's
  // host-process auth-bypass mode.
  'COGNITO_USERPOOL_ID',
  'DJ_APP_CLIENT_ID',

  // Why: metadata cache sizes. Compose substitutes from `.env` with
  // defaults that match prod; workflow relies on backend defaults.
  'METADATA_ALBUM_CACHE_MAX_SIZE',
  'METADATA_ARTIST_CACHE_MAX_SIZE',
  'METADATA_ROTATION_PRIORITY',

  // Why: rate-limit gating. Compose exposes `TEST_RATE_LIMITING` so the
  // `ci:env:full` script can flip the cap on and exercise the rate-limit
  // middleware; the workflow doesn't run that variant.
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

  // Why: auth-service host port (workflow's auth process binds on 8083).
  // The backend doesn't consume it directly — it encodes the auth URL via
  // BETTER_AUTH_URL (mirrored). Compose puts AUTH_PORT in the auth service
  // env, not the backend env.
  'AUTH_PORT',

  // Why: better-auth JWT signing secret needed by the auth service host
  // process. Compose's ci-profile auth container omits it and relies on
  // better-auth's test-mode default; the workflow sets it explicitly. The
  // backend doesn't sign JWTs (only the auth service does), so this is
  // workflow-only without a real divergence in backend behavior.
  'BETTER_AUTH_SECRET',

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

  // Why: auth-service auto-membership / org-sync hooks read this from env
  // and no-op (with a warning) when unset. Compose sets it on the `auth`
  // service env block; the backend service doesn't need it. In GHA CI's
  // host-process model both services share workflow-level env, so it
  // appears here. Mirroring it into the compose `backend` env would be
  // harmless but pointless — the backend code never reads it.
  'DEFAULT_ORG_SLUG',

  // Why: mock-api server addressing. Backend reads LIBRARY_METADATA_URL
  // (mirrored). MOCK_API_PORT + MOCK_API_URL exist for the harness side
  // (mock-server start command, test assertions about response bodies).
  'MOCK_API_PORT',
  'MOCK_API_URL',

  // Why: workflow-level alias for CI_PORT used by certain non-test scripts
  // that read PORT (e.g. drizzle-kit migrations); harness-side.
  'PORT',

  // Why: workflow-only gating var sourced from the `detect-changes` job's
  // `run-integration` output. Drives `if:` conditions on every step in the
  // `Integration-Tests` job; compose doesn't gate steps this way (compose
  // runs everything unconditionally; profile selection is the gate).
  'RUN_TESTS',

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

  // The host-process backend in GHA CI inherits env from THREE YAML scopes
  // (workflow → job → step). Miss any of them and the parity check produces
  // false positives. Take the union of all three.
  return new Set([
    ...extractTopLevelEnv(workflow),
    ...extractIntegrationTestsJobEnv(workflow),
    ...extractStartServicesStepEnv(workflow),
  ]);
}

/**
 * Workflow-top-level `env:`, scoped to the region above `jobs:` so a
 * job-level `env:` can't accidentally match first. Required keys live at
 * column 2 (`^  KEY:`).
 */
function extractTopLevelEnv(workflow: string): string[] {
  const jobsIdx = workflow.indexOf('\njobs:\n');
  if (jobsIdx === -1) {
    throw new Error('workflow has no top-level `jobs:` key');
  }
  const preJobs = workflow.slice(0, jobsIdx);
  const topMatch = preJobs.match(/^env:\n((?:\s+[A-Z][A-Z0-9_]*:.*\n)+)/m);
  if (!topMatch) {
    throw new Error('workflow top-level `env:` block not found');
  }
  return [...topMatch[1].matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

/**
 * Job-level `env:` under `Integration-Tests:`. This block (lines 266-281
 * today) sets the host-process backend's DB_HOST / DB_PORT / BETTER_AUTH_*
 * etc. — vars the docker-compose path sets in the backend service env
 * block. Missing this scope causes false-positive "only in compose"
 * entries.
 *
 * The 4-space `env:` anchor specifically discriminates job-level env from
 * the `services.postgres.env:` block (8-space indent) immediately above it
 * in the same job — that one populates the postgres SERVICE container's
 * env, not the runner-process env, and shouldn't be merged in.
 */
function extractIntegrationTestsJobEnv(workflow: string): string[] {
  const jobIdx = workflow.indexOf('\n  Integration-Tests:');
  if (jobIdx === -1) {
    throw new Error('workflow `Integration-Tests:` job not found');
  }
  const jobSlice = workflow.slice(jobIdx);
  // Bound the slice at the next job (col 2) or `steps:` (col 4) so the
  // regex doesn't run away into later jobs. `steps:` comes after the
  // job-level env block.
  const stepsIdx = jobSlice.indexOf('\n    steps:');
  if (stepsIdx === -1) {
    throw new Error('Integration-Tests job has no `steps:` key');
  }
  // `+1` includes the trailing newline of the last env line; the
  // env-key regex requires each line to terminate with `\n`, so without
  // it the LAST entry in the env block (today: BETTER_AUTH_SECRET) is
  // silently dropped.
  const boundedSlice = jobSlice.slice(0, stepsIdx + 1);
  const envMatch = boundedSlice.match(/\n {4}env:\n((?: {6}[A-Z][A-Z0-9_]*:.*\n)+)/);
  if (!envMatch) {
    throw new Error('Integration-Tests job-level `env:` block not found');
  }
  return [...envMatch[1].matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

/**
 * `Start services` step `env:` — the innermost YAML scope, where the
 * limiter overrides (BS#955) live today.
 */
function extractStartServicesStepEnv(workflow: string): string[] {
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
  return [...stepEnv.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}
