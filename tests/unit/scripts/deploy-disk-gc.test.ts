/**
 * Close three gaps in the deploy pipeline's host-disk GC (BS#1844's
 * "reclaim-before-pull" fix, extended after a 2026-09-28 near-full-disk
 * audit of the shared prod EC2 host found each of them live on the host):
 *
 * (a) A stopped one-off container (a hand-run dry-run/verify/execute
 *     invocation, never a `<target>-cron` container) pins its image
 *     forever -- nothing else ever removes it.
 * (b) Every GC site filters on `grep -E 'v[0-9]+\.[0-9]+\.[0-9]+'` before
 *     applying its keep-newest-per-repo logic, so a `:sha-...` or `:latest`
 *     tagged image -- what a one-off job produces when invoked without an
 *     explicit version -- is never a removal candidate, regardless of age.
 * (c) A retired or renamed target (root Dockerfile removed) never rebuilds,
 *     so the keep-newest-N sweeps -- which only ever *trim* a repo still
 *     receiving pushes -- never reach zero for it; its last image sits on
 *     the host forever.
 *
 * This reads the workflow/action YAML as text, the same way
 * `deploy-affected-targets.test.ts` and `deploy-timeouts.test.ts` do, so
 * there is no dependency edge from the YAML to this spec -- see that file's
 * header for why `detect-changes`' `.github/workflows/**` glob is what
 * makes this hold.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const deployBase = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-base.yml'), 'utf-8');
const deployServiceAction = fs.readFileSync(path.join(repoRoot, '.github/actions/deploy-service/action.yml'), 'utf-8');

/** Drop comment-only lines: every check here must read YAML, not the prose above it. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The body of one top-level job in `deploy-base.yml`, comments stripped.
 * Jobs are indented two spaces under `jobs:`, so a job ends at the next
 * line with exactly that indent. (Copied from `deploy-affected-targets.test.ts`
 * rather than imported -- these are two independent specs of the same file,
 * and a shared helper module would be more indirection than either buys.)
 */
function jobBody(name: string): string {
  const lines = withoutComments(deployBase).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
  if (start === -1) throw new Error(`job '${name}' not found in deploy-base.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

const reclaimDisk = jobBody('reclaim-disk');
const setup = jobBody('setup');
const deployCronJobBody = withoutComments(deployBase).slice(
  withoutComments(deployBase).indexOf('- name: Deploy Cron Job')
);
const deployServiceScript = withoutComments(deployServiceAction);

describe('reclaim-disk removes stale stopped one-off containers (gap a)', () => {
  it('filters to stopped containers only', () => {
    expect(reclaimDisk).toContain('--filter status=exited');
  });

  it('excludes anything ending in -cron -- the live cron pin, rotated on its own schedule', () => {
    expect(reclaimDisk).toMatch(/\*-cron\)\s*continue/);
  });

  it('only reaps a container stopped more than 7 days ago', () => {
    expect(reclaimDisk).toContain("date -d '7 days ago'");
    expect(reclaimDisk).toContain('FinishedAt');
  });

  it('removes with a soft `docker rm`, never `-f`', () => {
    expect(reclaimDisk).not.toMatch(/docker rm -f "\$NAME"/);
    expect(reclaimDisk).toMatch(/docker rm "\$NAME"/);
  });
});

describe('every GC site also collects non-v* tagged images (gap b)', () => {
  const sites: Record<string, string> = {
    'reclaim-disk (pre-pull, keep 1)': reclaimDisk,
    'Deploy Cron Job (post-pull, keep 2)': deployCronJobBody,
    'deploy-service action (post-pull, keep 2)': deployServiceScript,
  };

  it.each(Object.entries(sites))('%s orders by CreatedAt, not the tag string', (_label, body) => {
    // `sha-...` and `:latest` have no shared ordering as strings the way
    // `sort -V` gives v* tags -- this must be time-ordered instead.
    expect(body).toContain('{{.CreatedAt}}');
  });

  it.each(Object.entries(sites))('%s excludes tags that already match the v* pattern', (_label, body) => {
    // Otherwise a v*-tagged image would be a candidate in BOTH sweeps and
    // could be counted twice toward "newest N", undercounting the buffer.
    expect(body).toMatch(/\$2 !~ \/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$\//);
  });

  it.each(Object.entries(sites))('%s never touches semantic-index', (_label, body) => {
    expect(body).toMatch(/semantic-index/);
    // The exclusion pattern must match both an ECR-prefixed repo
    // (".../semantic-index") and a bare local tag ("semantic-index", no
    // slash) -- the host carries both.
    expect(body).toMatch(/\(\^\|\\\/\)semantic-index/);
  });

  it.each(Object.entries(sites))('%s still removes with a soft `docker rmi`', (_label, body) => {
    const nonVSweeps = body
      .split(/(?=docker images --format '\{\{\.Repository\}\}\|)/)
      .filter((chunk) => chunk.includes('{{.CreatedAt}}'));
    expect(nonVSweeps.length).toBeGreaterThan(0);
    for (const sweep of nonVSweeps) {
      expect(sweep).not.toMatch(/docker rmi -f/);
      expect(sweep).toMatch(/xargs -r -n1 docker rmi/);
    }
  });
});

describe('setup computes the full live-target universe for the retired-repo sweep', () => {
  it('runs turbo ls WITHOUT --affected -- the full universe, not just what this push touched', () => {
    expect(setup).toContain('npx turbo ls --output=json');
    // The --affected form (used earlier in the same job, for the deploy
    // matrix itself) must not be what this step reuses.
    const liveTargetsStep = setup.slice(setup.indexOf('Detect Live Target Repos'));
    expect(liveTargetsStep).not.toContain('--affected');
  });

  it('applies the same Dockerfile-existence filter as the affected-target BUILDABLE loop', () => {
    const liveTargetsStep = setup.slice(setup.indexOf('Detect Live Target Repos'));
    expect(liveTargetsStep).toContain('if [ -f "Dockerfile.$TARGET" ]');
  });

  it('exposes the result as a job output', () => {
    expect(deployBase).toMatch(/live_targets:\s*\$\{\{\s*steps\.detect_live_targets\.outputs\.LIVE_TARGETS/);
  });

  it('falls back to an empty list rather than leaving the output undefined', () => {
    expect(deployBase).toMatch(/live_targets:.*\|\|\s*'\[\]'/);
  });
});

describe('reclaim-disk removes images of retired/renamed targets (gap c)', () => {
  it('treats an empty live-target list as "unknown", never as "everything is retired"', () => {
    expect(reclaimDisk).toMatch(/if \[ -n "\$LIVE_TARGETS" \]/);
  });

  it('excludes db-migrate and deploy-builder -- neither is a matrix deploy target', () => {
    expect(reclaimDisk).toMatch(/db-migrate\|deploy-builder\|semantic-index/);
  });

  it('only sweeps repos hosted under the ECR URI, never a local-only tag', () => {
    expect(reclaimDisk).toMatch(/"\$AWS_ECR_URI"\/\*/);
  });

  it('removes every tag of a retired repo, not just the oldest', () => {
    const sweep = reclaimDisk.slice(reclaimDisk.indexOf('Retired target, removing'));
    expect(sweep).toContain('docker images "$REPO" --format \'{{.Repository}}:{{.Tag}}\'');
    expect(sweep).toMatch(/xargs -r -n1 docker rmi/);
    expect(sweep).not.toMatch(/docker rmi -f/);
  });
});

describe('the new GC logic never reintroduces a blanket prune', () => {
  it('never adds `docker image prune -a` or `--volumes` anywhere in the changed files', () => {
    for (const text of [deployBase, deployServiceAction]) {
      expect(text).not.toMatch(/docker image prune[^\n]*(-a\b|--all|--volumes)/);
    }
  });

  it('every docker rmi introduced by the three new sweeps still degrades safely', () => {
    // Scoped to the new sweeps specifically (gap a's container removal, gap
    // b's non-v* image sweep, gap c's retired-repo sweep) rather than every
    // `docker rm`/`rmi` in the file -- deploy-service/action.yml's
    // pre-existing "stop the container on this port" cleanup legitimately
    // has its own error handling and is out of this issue's scope.
    const newRmiLines = [
      ...reclaimDisk.matchAll(/^.*docker rmi[^\n]*$/gm),
      ...deployCronJobBody.matchAll(/^.*docker rmi[^\n]*$/gm),
      ...withoutComments(deployServiceAction).matchAll(/^.*docker rmi[^\n]*$/gm),
    ].map((m) => m[0]);
    expect(newRmiLines.length).toBeGreaterThan(0);
    for (const line of newRmiLines) {
      expect(line).not.toMatch(/docker rmi -f/);
      expect(line).toMatch(/\|\|\s*true|2>\/dev\/null/);
    }
  });
});
