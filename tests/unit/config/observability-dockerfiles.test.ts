import { readFileSync } from 'fs';
import { resolve } from 'path';

// The runtime images' prod stages install and copy shared workspaces by
// explicit enumeration, so a new one is silently absent until it is listed.
// `@wxyc/observability` is imported by instrument.ts, which loads before app
// code — a missing dist is a boot crash, and no CI job builds these images.
// Pin all three Dockerfiles here instead.
//
// Since BS#2718 (shared builder image), every target's builder stage is
// `FROM ${BUILDER_IMAGE}`, fed by the single `Dockerfile.deploy-builder`
// build that runs `npm run build --workspace=shared/**` once for the whole
// fleet -- so the BS#2532 hazard this file originally guarded against (the
// worker's builder stage needing `@wxyc/observability` named explicitly, or
// its dist silently never gets built at all) no longer exists: every
// consumer gets every shared package's dist "for free" from the one shared
// build, the same way `Dockerfile.backend`/`Dockerfile.auth` always did. The
// per-target `COPY --from=builder` path is still worth pinning (a missing
// COPY is still a boot crash); the old worker-specific
// `--workspace=@wxyc/observability` assertion is gone because that flag no
// longer lives in any per-target Dockerfile.
describe('Dockerfile runtime stages ship @wxyc/observability', () => {
  it.each([
    ['backend', '../../../Dockerfile.backend'],
    ['auth', '../../../Dockerfile.auth'],
    ['enrichment-worker', '../../../Dockerfile.enrichment-worker'],
  ])('Dockerfile.%s copies the package manifest and the built dist', (_app, relPath) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).toContain('COPY ./shared/observability/package* ./shared/observability/');
    expect(source).toContain('COPY --link --from=builder /shared/observability/dist ./shared/observability/dist');
  });

  it('Dockerfile.deploy-builder builds every shared workspace unconditionally, not by per-target enumeration', () => {
    const source = readFileSync(resolve(__dirname, '../../../Dockerfile.deploy-builder'), 'utf-8');
    expect(source).toContain('--workspace=shared/**');
  });
});
