/**
 * Close gaps in the deploy pipeline's host-disk GC (BS#1844's
 * "reclaim-before-pull" fix, extended by a host audit that found each of
 * these live: BS#2740):
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
 *     receiving pushes -- never reach zero for it; its last image, and its
 *     last `<target>-cron` container, sit on the host forever.
 *
 * Review pass on the first cut of this fix (BS#2740) found the container
 * sweep too blunt (it could remove a deliberately stopped SERVICE
 * container, not just a one-off), the non-v* image sweep too broad (it
 * would also collect hand-pulled reference images like `postgres:*`), the
 * retired-repo sweep's exclusion list an unguarded denylist, and gap (c)'s
 * container half not actually reachable (a retired target's `-cron`
 * container was excluded by name alone, same as a live one). This file's
 * describe blocks are organized by that review's numbered findings.
 *
 * This reads the workflow/action YAML as text, the same way
 * `deploy-affected-targets.test.ts` and `deploy-timeouts.test.ts` do, so
 * there is no dependency edge from the YAML to this spec -- see that file's
 * header for why `detect-changes`' `.github/workflows/**` glob is what
 * makes this hold. The underlying shell logic (restart-policy gating,
 * crontab-membership exclusion, the non-v* and retired-repo sweeps, the
 * truncation guard) was additionally verified by hand against fixture
 * `docker ps` / `docker images` / `crontab -l` output before this PR was
 * opened -- see the PR body. It is not re-verified here: these SSH-executed
 * scripts have no mechanism in this repo to ship a script file to the
 * remote host (see `resolve-cron-schedule.sh`'s CLAUDE.md entry for the
 * one place that pattern IS available -- it runs on the GHA runner, not
 * over SSH), so a behavioral fixture test would need a new file-shipping
 * mechanism to actually exercise the deployed script, which is out of this
 * PR's scope.
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

/** Same as `jobBody`, but keeps comments -- for assertions about the prose itself. */
function jobBodyWithComments(name: string): string {
  const lines = deployBase.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
  if (start === -1) throw new Error(`job '${name}' not found in deploy-base.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

const reclaimDisk = jobBody('reclaim-disk');
const reclaimDiskWithComments = jobBodyWithComments('reclaim-disk');
const setup = jobBody('setup');
const deployCronJobBody = withoutComments(deployBase).slice(
  withoutComments(deployBase).indexOf('- name: Deploy Cron Job')
);
const deployServiceScript = withoutComments(deployServiceAction);
const liveTargetsStep = setup.slice(setup.indexOf('Detect Live Target Repos'));

describe('BS#2740 is cited instead of the unrelated dead-Dockerfile issue (#2721)', () => {
  it('never cites #2721 in the changed workflow/action files', () => {
    for (const text of [deployBase, deployServiceAction]) {
      expect(text).not.toMatch(/2721/);
    }
  });
});

describe('reclaim-disk removes stale stopped containers, service containers excluded (gap a)', () => {
  it('only reaps a container stopped more than 7 days ago', () => {
    expect(reclaimDisk).toContain("date -d '7 days ago'");
    expect(reclaimDisk).toContain('FinishedAt');
  });

  it('requires HostConfig.RestartPolicy.Name to be "no" -- a deliberately stopped service keeps its policy', () => {
    expect(reclaimDisk).toContain('HostConfig.RestartPolicy.Name');
    expect(reclaimDisk).toContain('[ "$RESTART_POLICY" = "no" ] || continue');
  });

  it('skips a bare name that is a current live target or semantic-index, before the restart-policy check', () => {
    expect(reclaimDisk).toContain('[ "$NAME" = "semantic-index" ] && continue');
    expect(reclaimDisk).toMatch(/case " \$LIVE_TARGETS " in\s*\n\s*\*" \$NAME "\*\) continue ;;/);
  });

  it('removes with a soft `docker rm`, never `-f`', () => {
    expect(reclaimDisk).not.toMatch(/docker rm -f "\$NAME"/);
    expect(reclaimDisk).toMatch(/docker rm "\$NAME"/);
  });
});

describe('every GC site also collects non-v* tagged images, scoped to this ECR registry (gap b)', () => {
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

  it.each(Object.entries(sites))('%s restricts the sweep to this ECR registry', (_label, body) => {
    // Otherwise a hand-pulled reference image (postgres:*, node:*, ...),
    // which was never version-tagged to begin with, is a candidate too.
    expect(body).toMatch(/-v ecr="\$AWS_ECR_URI"/);
    expect(body).toContain('index($1, ecr "/") == 1');
  });

  it.each(Object.entries(sites))('%s excludes tags that already match the anchored v* pattern', (_label, body) => {
    // Otherwise a v*-tagged image would be a candidate in BOTH sweeps and
    // could be counted twice toward "newest N", undercounting the buffer.
    // Anchored (^...$) so it matches only a bare vX.Y.Z tag, consistent
    // with the anchored v* grep this sweep sits beside (gap/nit below).
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

describe('the pre-existing v* sweep is anchored to the tag column (nit)', () => {
  const sites: Record<string, string> = {
    'reclaim-disk': reclaimDisk,
    'Deploy Cron Job': deployCronJobBody,
    'deploy-service action': deployServiceScript,
  };

  it.each(Object.entries(sites))(
    '%s matches only a bare vX.Y.Z tag, not a substring anywhere in the line',
    (_label, body) => {
      expect(body).toMatch(/grep -E ' v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/);
      // The old, unanchored form must not survive anywhere.
      expect(body).not.toMatch(/grep -E 'v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+'/);
    }
  );
});

describe('setup computes the full live-target universe for the retired-repo sweep', () => {
  it('runs turbo ls WITHOUT --affected -- the full universe, not just what this push touched', () => {
    expect(setup).toContain('npx turbo ls --output=json');
    expect(liveTargetsStep).not.toContain('--affected');
  });

  it('applies the same Dockerfile-existence filter as the affected-target BUILDABLE loop', () => {
    expect(liveTargetsStep).toContain('if [ -f "Dockerfile.$TARGET" ]');
  });

  it('uses the identical jq filter as the affected-target detection step', () => {
    // Both steps must partition apps/+jobs/ workspaces the same way -- a
    // divergence here (e.g. one step picking up a path turbo reports
    // differently) would silently desync live_targets from targets.
    const jqFilters = [...setup.matchAll(/jq -c '([^']+)'/g)].map((m) => m[1]);
    expect(jqFilters).toHaveLength(2);
    expect(jqFilters[0]).toBe(jqFilters[1]);
    expect(jqFilters[0]).toContain('startswith("apps/")');
  });

  it('exposes the result as a job output', () => {
    expect(deployBase).toMatch(/live_targets:\s*\$\{\{\s*steps\.detect_live_targets\.outputs\.LIVE_TARGETS/);
  });

  it('falls back to an empty list rather than leaving the output undefined', () => {
    expect(deployBase).toMatch(/live_targets:.*\|\|\s*'\[\]'/);
  });

  it('warns when the computed list is empty on the non-dispatch path', () => {
    expect(liveTargetsStep).toContain('::warning');
    expect(liveTargetsStep).toMatch(/if \[ "\$LIVE" = "\[\]" \]/);
  });
});

describe('reclaim-disk removes images of retired/renamed targets via a denylist (gap c)', () => {
  it('treats an empty live-target list as "unknown", never as "everything is retired"', () => {
    expect(reclaimDisk).toMatch(/if \[ -n "\$LIVE_TARGETS" \] && \[ "\$TRUNCATED" = false \]/);
  });

  it('excludes db-migrate, deploy-builder and semantic-index -- none is a matrix deploy target', () => {
    expect(reclaimDisk).toMatch(/db-migrate\|deploy-builder\|semantic-index/);
  });

  it('documents the exclusion list as a denylist that new shared-host services must be added to', () => {
    // The loud comment this review asked for -- a future tenant of this
    // host (e.g. auto-dj-orchestrator) sharing the same ECR registry
    // without being a Backend-Service target would otherwise lose its
    // images on every Backend-Service deploy.
    expect(reclaimDiskWithComments).toMatch(
      /ANY NEW SERVICE DEPLOYED TO THIS HOST FROM THIS REGISTRY MUST\s*\n\s*# BE ADDED TO THIS LIST/
    );
  });

  it('only sweeps repos hosted under the ECR URI, never a local-only tag', () => {
    expect(reclaimDisk).toMatch(/"\$AWS_ECR_URI"\/\*/);
  });

  it('removes every tag of a retired repo, not just the oldest', () => {
    const sweep = reclaimDisk.slice(reclaimDisk.lastIndexOf('Retired target, removing'));
    expect(sweep).toContain('docker images "$REPO" --format \'{{.Repository}}:{{.Tag}}\'');
    expect(sweep).toMatch(/xargs -r -n1 docker rmi/);
    expect(sweep).not.toMatch(/docker rmi -f/);
  });
});

describe("reclaim-disk removes a retired target's stale -cron container (gap c, container half)", () => {
  it('reads crontab in the same script the container sweep runs in', () => {
    expect(reclaimDisk).toContain('CRONTAB_OUT=$(crontab -l 2>/dev/null || true)');
  });

  it('only protects a -cron name when a matching wxyc_<name> crontab entry still exists', () => {
    expect(reclaimDisk).toContain('BASE_NAME="${NAME%-cron}"');
    expect(reclaimDisk).toContain('grep -q "# wxyc_${BASE_NAME}\\$"');
  });

  it("keeps a retained-but-unscheduled one-shot's image via live_targets, not via the container check", () => {
    // flowsheet-etl/rotation-etl/library-etl have no crontab entry either
    // (job-type: one-shot), so their stale -cron containers are removable
    // by the same rule that removes a truly retired target's -- but their
    // v* images survive because the target itself stays in live_targets.
    // This is a behavioral property of the fixture-verified logic (see the
    // PR body), not something this YAML-text test can assert directly;
    // this test instead pins the two mechanisms staying independent: the
    // v* sweep never references LIVE_TARGETS or crontab at all.
    const vSweep = reclaimDisk.slice(
      reclaimDisk.indexOf("grep -E ' v[0-9]"),
      reclaimDisk.indexOf('xargs -r -n1 docker rmi') + 40
    );
    expect(vSweep).not.toContain('LIVE_TARGETS');
    expect(vSweep).not.toContain('CRONTAB_OUT');
  });
});

describe('reclaim-disk refuses the retired-repo sweep on a truncated live-target list (truncation guard)', () => {
  it('cross-checks every crontab-referenced and running-container repo against live_targets', () => {
    expect(reclaimDisk).toContain('REFERENCED_REPOS=');
    expect(reclaimDisk).toContain("grep -oE '# wxyc_[a-zA-Z0-9-]+'");
    expect(reclaimDisk).toContain("docker ps --format '{{.Image}}'");
  });

  it('sets TRUNCATED and warns loudly when a referenced repo is missing from live_targets', () => {
    expect(reclaimDisk).toContain('TRUNCATED=true');
    expect(reclaimDisk).toMatch(/::warning::live_targets is missing/);
  });

  it('ignores the same denylist (db-migrate, deploy-builder, semantic-index) when cross-checking', () => {
    const guard = reclaimDisk.slice(
      reclaimDisk.indexOf('REFERENCED_REPOS='),
      reclaimDisk.indexOf('TRUNCATED=true') + 20
    );
    expect(guard).toMatch(/db-migrate\|deploy-builder\|semantic-index/);
  });

  it('gates the retired-repo sweep on TRUNCATED, not just on live_targets being non-empty', () => {
    const sweepGate = reclaimDisk.match(/if \[ -n "\$LIVE_TARGETS" \] && \[ "\$TRUNCATED" = false \]; then/);
    expect(sweepGate).not.toBeNull();
  });
});

describe('the new GC logic never reintroduces a blanket prune', () => {
  it('never adds `docker image prune -a` or `--volumes` anywhere in the changed files', () => {
    for (const text of [deployBase, deployServiceAction]) {
      expect(text).not.toMatch(/docker image prune[^\n]*(-a\b|--all|--volumes)/);
    }
  });

  it('every docker rmi introduced by the new sweeps still degrades safely', () => {
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
