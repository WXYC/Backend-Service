import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

// Every job image installs and copies its shared workspaces by explicit
// enumeration (a manifest COPY before `npm install --omit=dev`, a builder dist
// COPY after it). A missing line is an ERR_MODULE_NOT_FOUND at container start,
// which for a cron pages nobody, and no CI job builds these images. This test
// derives the expected lines from each job's package.json so the PR that adds
// a `@wxyc/<shared>` dependency (or forgets the COPY lines) fails `test:unit`.
//
// Selection: a job is checked when it has both `jobs/<job>/package.json` and a
// root `Dockerfile.<job>`. Python jobs (no package.json), `Dockerfile.migrate`
// and `Dockerfile.deploy-builder` (no jobs/ package) are therefore never judged.
const ROOT = resolve(__dirname, '../../..');

// Deliberate exceptions: job name -> { shared package name -> reason }.
const ALLOWLIST: Record<string, Record<string, string>> = {};

type Manifest = { name: string; dependencies?: Record<string, string> };

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf-8'));

const sharedDirByName = new Map<string, string>(
  readdirSync(resolve(ROOT, 'shared'))
    .filter((dir) => existsSync(resolve(ROOT, 'shared', dir, 'package.json')))
    .map((dir) => [readManifest(resolve(ROOT, 'shared', dir, 'package.json')).name, dir])
);

// Transitive closure of `@wxyc/*` shared-workspace dependencies, as directory names.
const sharedClosure = (manifest: Manifest): string[] => {
  const seen = new Set<string>();
  const visit = (deps: Record<string, string> = {}): void => {
    for (const name of Object.keys(deps)) {
      const dir = sharedDirByName.get(name);
      if (dir === undefined || seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      visit(readManifest(resolve(ROOT, 'shared', dir, 'package.json')).dependencies);
    }
  };
  visit(manifest.dependencies);
  return [...seen].sort();
};

const jobs = readdirSync(resolve(ROOT, 'jobs'))
  .filter(
    (job) => existsSync(resolve(ROOT, 'jobs', job, 'package.json')) && existsSync(resolve(ROOT, `Dockerfile.${job}`))
  )
  .sort();

describe('job Dockerfiles copy the shared workspaces their package.json depends on', () => {
  it('selects a non-trivial set of jobs', () => {
    expect(jobs.length).toBeGreaterThan(20);
  });

  it.each(jobs)('Dockerfile.%s', (job) => {
    const dockerfile = readFileSync(resolve(ROOT, `Dockerfile.${job}`), 'utf-8');
    const allowed = ALLOWLIST[job] ?? {};
    const missing: string[] = [];

    for (const dir of sharedClosure(readManifest(resolve(ROOT, 'jobs', job, 'package.json')))) {
      const name = readManifest(resolve(ROOT, 'shared', dir, 'package.json')).name;
      if (name in allowed) {
        continue;
      }
      const manifestLine = `COPY ./shared/${dir}/package* ./shared/${dir}/`;
      const distLine = `COPY --link --from=builder /shared/${dir}/dist ./shared/${dir}/dist`;
      for (const line of [manifestLine, distLine]) {
        if (!dockerfile.includes(line)) {
          missing.push(line);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
