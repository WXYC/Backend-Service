/**
 * Pin the shared-builder-image mechanism that replaced 56 per-target
 * `npm ci` builds with one shared build (BS#2718).
 *
 * # The failure this guards against
 *
 * Every Node `Dockerfile.<target>` used to run its own `npm ci && npm run
 * build` over the whole monorepo in its own `builder` stage. Since this is
 * an npm-workspaces repo, `npm ci` always installs the full dependency
 * tree regardless of which `--workspace` flags the build script passes, so
 * those 56 builder stages were ~0.7 GB of near-identical work, each cached
 * under its own per-target ECR ref (`<target>:buildcache`) and independently
 * pulled by its own `build` matrix job -- ~38 GB of ECR egress on a
 * full (54-target) fan-out. `Dockerfile.deploy-builder` now does that build
 * exactly once per deploy and exports only the compiled `dist/**` output
 * (~9 MB across every workspace); every target's builder stage becomes
 * `ARG BUILDER_IMAGE` / `FROM ${BUILDER_IMAGE} AS builder`, fed by a new
 * `build-shared-builder` job upstream of the `build` matrix.
 *
 * This is a pure `readFileSync` scan (no Docker build, no ECR access), so
 * it can't verify the images actually build or that egress drops in
 * production -- it verifies a future edit can't silently reintroduce a
 * per-target `npm ci` or drop the wiring that feeds `BUILDER_IMAGE` to the
 * matrix. See `docs/deploy.md` "Shared builder image" for the full design
 * and the numbers this closes out.
 *
 * # Why this file is a `readFileSync` test, and what that costs
 *
 * It reads Dockerfiles and workflow YAML as text, so Jest's dependency
 * graph has no edge from either to this spec -- the job running it has to
 * be triggered by a change to the files it reads. `detect-changes`' `src`
 * filter in `test.yml` globs both `Dockerfile.*` and `.github/workflows/**`,
 * which is what makes that hold (mirrors `deploy-timeouts.test.ts` and
 * `deploy-affected-targets.test.ts`, which depend on the same glob for the
 * workflow half).
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Dockerfiles that deliberately do NOT consume the shared builder image:
 * `migrate` builds a standalone init image with no `npm ci`/build step at
 * all, and the fleet's one Python job has no Node builder stage to share.
 * This list is not independently pinned by count or contents (that would be
 * circular -- it's the input to the exclusion filter below, so asserting it
 * equals itself proves nothing); what actually guards against it silently
 * admitting a real target is the per-entry structural check below, which
 * verifies each excluded file has no reason to be included in the first
 * place (no Node two-stage builder pattern at all).
 */
const NON_SHARED_BUILDER_DOCKERFILES = ['Dockerfile.migrate', 'Dockerfile.rotation-release-id-pollution-check'];

/** The shared builder image's own Dockerfile -- has a REAL `npm ci`, checked separately below. */
const SHARED_BUILDER_DOCKERFILE = 'Dockerfile.deploy-builder';

/**
 * Every root Dockerfile expected to consume the shared builder image.
 *
 * Not hardcoded to a fixed list of 56 names (too easy for this file to rot
 * against a fleet that adds/retires jobs weekly) -- instead a floor on the
 * *count*, so a regex/glob that silently stops matching almost everything
 * (the failure mode `deploy-affected-targets.test.ts` and
 * `deploy-timeouts.test.ts` both guard against for their own scans) still
 * fails loudly rather than passing vacuously over zero or one file.
 */
function nodeTargetDockerfiles(): string[] {
  return fs
    .readdirSync(repoRoot)
    .filter((f) => f.startsWith('Dockerfile.'))
    .filter((f) => f !== SHARED_BUILDER_DOCKERFILE && !NON_SHARED_BUILDER_DOCKERFILES.includes(f));
}

const MIN_EXPECTED_NODE_DOCKERFILES = 50;

// The default (BS#2718 follow-up fix) is what makes every local build path
// -- dev_env/docker-compose.yml, every app/job's own `docker:build` script --
// work without threading a BUILDER_IMAGE build-arg through ~55 scripts. In
// CI, deploy-base.yml always overrides it with the real per-deploy ECR
// image; the default only takes effect when nothing overrides it, which is
// every local build path. See docs/deploy.md "Shared builder image".
const EXPECTED_BUILDER_BLOCK = 'ARG BUILDER_IMAGE=wxyc-deploy-builder:local\nFROM ${BUILDER_IMAGE} AS builder';

function readDockerfile(name: string): string {
  return fs.readFileSync(path.join(repoRoot, name), 'utf-8');
}

describe('shared builder image replaces per-target npm ci (BS#2718)', () => {
  it('finds a real fleet of Node target Dockerfiles to check', () => {
    // If this ever drops near zero, every assertion below passes on an
    // empty set and proves nothing -- exactly the `turbo --affected`
    // fail-open failure mode this repo has already been bitten by once.
    expect(nodeTargetDockerfiles().length).toBeGreaterThanOrEqual(MIN_EXPECTED_NODE_DOCKERFILES);
  });

  it.each(NON_SHARED_BUILDER_DOCKERFILES)(
    '%s does NOT consume the shared builder image, and structurally has no reason to',
    (name) => {
      const text = readDockerfile(name);
      expect(text).not.toContain('BUILDER_IMAGE');
      // The real protection: each exclusion must be justified by the file
      // having no Node two-stage builder pattern at all -- not merely by
      // being named in this list. If a future edit gave one of these files
      // a real `npm ci`/build step, this is what would catch it.
      expect(text).not.toMatch(/^FROM node:24-alpine AS builder$/m);
      expect(text).not.toMatch(/^RUN npm ci\b/m);
    }
  );

  const COPY_FROM_BUILDER = /^COPY (?:--link )?--from=builder (\S+) (\S+)$/m;
  const COPY_FROM_BUILDER_G = new RegExp(COPY_FROM_BUILDER.source, 'gm');

  describe.each(nodeTargetDockerfiles())('%s', (name) => {
    const text = readDockerfile(name);

    it('declares the shared-builder ARG/FROM pair, and nothing else, as its builder stage', () => {
      expect(text).toContain(EXPECTED_BUILDER_BLOCK);
      // The old per-target shape must never come back.
      expect(text).not.toMatch(/^FROM node:24-alpine AS builder$/m);
      expect(text).not.toMatch(/^RUN npm ci\b/m);
    });

    it('copies dist/** from the builder stage using an absolute path, not the old per-target prefix', () => {
      const copyLines = [...text.matchAll(COPY_FROM_BUILDER_G)];
      expect(copyLines.length).toBeGreaterThan(0);
      for (const [, src, dst] of copyLines) {
        expect(src.startsWith('/')).toBe(true);
        expect(src.endsWith('/dist')).toBe(true);
        expect(dst.endsWith('/dist')).toBe(true);
        // The absolute source path (minus its leading slash) must be what
        // the destination copies into, mirroring the shared image's own
        // repo-relative layout (apps/<x>/dist, jobs/<x>/dist, shared/<x>/dist).
        expect(dst.replace(/^\.\//, '')).toBe(src.replace(/^\//, ''));
      }
    });
  });

  it.each([
    ['COPY --from=builder /jobs/x/dist ./jobs/x/dist', true],
    ['COPY --link --from=builder /jobs/x/dist ./jobs/x/dist', true],
    ['COPY --chown=1:1 --from=builder /jobs/x/dist ./jobs/x/dist', false],
  ])('COPY-line pattern: %s -> matches=%s', (line, matches) => {
    expect(COPY_FROM_BUILDER.test(line)).toBe(matches);
  });

  describe(SHARED_BUILDER_DOCKERFILE, () => {
    const text = readDockerfile(SHARED_BUILDER_DOCKERFILE);

    it('runs the real npm ci + full-monorepo build exactly once, after every workspace source is present', () => {
      expect(text).toContain('FROM node:24-alpine AS builder');
      expect(text).toMatch(/^ARG NPM_TOKEN$/m);
      expect(text).toMatch(/^RUN npm ci$/m);
      expect(text).toMatch(
        /^RUN npm run build --workspace=@wxyc\/database --workspace=shared\/\*\* --workspace=apps\/\*\* --workspace=jobs\/\*\*$/m
      );
      // `npm ci` must come AFTER the COPYs of shared/apps/jobs, not before.
      // A manifest-only-first split (COPY only package.json's, npm ci, THEN
      // copy source) was tried and reverted: in an npm WORKSPACES repo,
      // `npm ci` needs every workspace's own package.json already present
      // to resolve the workspace graph, not just the root manifest and
      // lockfile -- deferring the source copies past it produced a
      // node_modules inconsistent with what the build step actually needed,
      // reproduced twice locally. See Dockerfile.deploy-builder's own
      // comment and docs/deploy.md for the full account.
      const npmCiIndex = text.indexOf('RUN npm ci\n');
      const copyAppsIndex = text.indexOf('COPY ./apps ./apps');
      expect(npmCiIndex).toBeGreaterThan(-1);
      expect(copyAppsIndex).toBeGreaterThan(-1);
      expect(npmCiIndex).toBeGreaterThan(copyAppsIndex);
    });

    it('collects dist/** for every workspace anchored at exactly one glob depth (never node_modules)', () => {
      // The collection loop must be anchored at apps|jobs|shared/*/dist --
      // anything looser (e.g. a recursive `find -name dist`) would also
      // match a dependency's own nested dist/ under node_modules.
      expect(text).toMatch(/for d in apps\/\*\/dist jobs\/\*\/dist shared\/\*\/dist/);
    });

    it('pushes only a from-scratch dist-export stage, never the node_modules-bearing builder stage', () => {
      expect(text).toMatch(/^FROM scratch AS dist-export$/m);
      expect(text).toContain('COPY --from=builder /dist-export/ /');
    });
  });
});

describe('deploy-base.yml wires the shared builder image ahead of the build matrix (BS#2718)', () => {
  const deployBase = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-base.yml'), 'utf-8');

  it('builds the shared image in its own job, upstream of (and not inside) the build matrix', () => {
    expect(deployBase).toMatch(/^ {2}build-shared-builder:\s*$/m);
    // Not matrixed: build-shared-builder must never gain a `strategy:` /
    // `matrix:` block, which is exactly the concurrent-writer hazard this
    // design avoids (see the job's own comment in deploy-base.yml).
    const jobStart = deployBase.indexOf('build-shared-builder:');
    const buildStart = deployBase.indexOf('\n  build:\n');
    expect(jobStart).toBeGreaterThan(-1);
    expect(buildStart).toBeGreaterThan(jobStart);
    const jobBody = deployBase.slice(jobStart, buildStart);
    expect(jobBody).not.toContain('matrix:');
    expect(jobBody).toContain('needs: [setup]');
    expect(jobBody).toContain('Dockerfile.deploy-builder');
    expect(jobBody).toContain('target: dist-export');
  });

  it('makes the build matrix depend on the shared builder job and consume its image', () => {
    expect(deployBase).toMatch(/needs:\s*\[handle-git-tags, setup, build-shared-builder\]/);
    // Reconstructed from a secret-free tag output, not a full-URI job
    // output -- see build-shared-builder's own "Compute Image Tag" comment.
    expect(deployBase).toContain(
      "BUILDER_IMAGE=${{ secrets.AWS_ECR_URI }}/deploy-builder:${{ needs['build-shared-builder'].outputs.builder_image_tag }}"
    );
  });

  it('never lets a secret-bearing value cross the build-shared-builder job boundary as an output', () => {
    // The regression this guards: outputs: builder_image: <full URI
    // embedding secrets.AWS_ECR_URI> would risk GitHub's documented
    // output-redaction behavior at the job boundary. Only a bare tag
    // (no secret content) may be declared as this job's output.
    const jobStart = deployBase.indexOf('build-shared-builder:');
    const buildStart = deployBase.indexOf('\n  build:\n');
    const jobBody = deployBase.slice(jobStart, buildStart);
    const outputsMatch = jobBody.match(/outputs:\n( {6}\S.*\n)+/);
    expect(outputsMatch).not.toBeNull();
    expect(outputsMatch?.[0]).not.toContain('secrets.');
    expect(outputsMatch?.[0]).toContain('builder_image_tag');
  });
});
