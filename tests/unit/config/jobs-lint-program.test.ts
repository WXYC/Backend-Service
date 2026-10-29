import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { srcFilter } from '../../utils/src-filter';

// ESLint lints `jobs/**/*.ts` through ONE TypeScript program, `tsconfig.eslint.jobs.json`,
// instead of the project service's one program per `jobs/*/tsconfig.json` (BS#3667). The
// project service never releases a program during a run, so 59 per-job programs cost ~8 GB
// of the full lint's 12 GB peak; one shared program costs ~1.2 GB. That is only equivalent
// while every job tsconfig resolves modules the way the shared program does, so this test
// fails when a job's `extends`, `module`, `moduleResolution` or `paths` drifts. A job that
// needs other options has to leave the shared program on purpose (give it its own lint block).
//
// `types`, `noEmit` and `references` are deliberately NOT compared: the shared program sees a
// superset of ambient types, and `noEmit` and `references` affect emit, not lint.
const ROOT = resolve(__dirname, '../../..');
const SHARED_TSCONFIG = 'tsconfig.eslint.jobs.json';

type TsConfig = {
  extends?: string | string[];
  include?: string[];
  compilerOptions?: { module?: string; moduleResolution?: string; paths?: Record<string, string[]> };
};

const readTsConfig = (path: string): TsConfig => JSON.parse(readFileSync(path, 'utf-8'));

// Absolute paths of the configs a tsconfig extends, so `../../tsconfig.base.json` (from a job)
// and `./tsconfig.base.json` (from the root) compare equal.
const extendsPaths = (path: string, config: TsConfig): string[] =>
  [config.extends ?? []].flat().map((target) => resolve(path, '..', target));

const sharedPath = resolve(ROOT, SHARED_TSCONFIG);
const shared = readTsConfig(sharedPath);

const jobTsconfigs = readdirSync(resolve(ROOT, 'jobs'))
  .filter((job) => existsSync(resolve(ROOT, 'jobs', job, 'tsconfig.json')))
  .sort();

describe(`${SHARED_TSCONFIG}`, () => {
  it('extends the base config and pins the job module settings', () => {
    expect(extendsPaths(sharedPath, shared)).toEqual([resolve(ROOT, 'tsconfig.base.json')]);
    expect(shared.compilerOptions).toMatchObject({ module: 'esnext', moduleResolution: 'bundler', paths: {} });
  });

  it('includes every job .ts file', () => {
    expect(shared.include).toEqual(['jobs/*/**/*.ts']);
  });
});

describe('jobs/*/tsconfig.json matches the shared lint program', () => {
  it('selects a non-trivial set of jobs', () => {
    expect(jobTsconfigs.length).toBeGreaterThan(20);
  });

  it.each(jobTsconfigs)('jobs/%s', (job) => {
    const path = resolve(ROOT, 'jobs', job, 'tsconfig.json');
    const config = readTsConfig(path);

    expect({
      extends: extendsPaths(path, config),
      module: config.compilerOptions?.module,
      moduleResolution: config.compilerOptions?.moduleResolution,
      paths: config.compilerOptions?.paths,
    }).toEqual({
      extends: extendsPaths(sharedPath, shared),
      module: shared.compilerOptions?.module,
      moduleResolution: shared.compilerOptions?.moduleResolution,
      paths: shared.compilerOptions?.paths,
    });
  });
});

describe('eslint.config.mjs parser options', () => {
  // Resolved through ESLint itself so the flat-config block ordering is what is under test.
  const parserOptionsFor = (file: string): Record<string, unknown> => {
    const script = `
      import { ESLint } from 'eslint';
      const config = await new ESLint({ cwd: ${JSON.stringify(ROOT)} }).calculateConfigForFile(${JSON.stringify(file)});
      process.stdout.write(JSON.stringify(config.languageOptions.parserOptions));
    `;
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf-8' })
    );
  };

  it.each(['jobs/flowsheet-etl/job.ts', 'jobs/library-label-backfill/dump.ts'])(
    'lints %s through the shared program',
    (file) => {
      expect(parserOptionsFor(file)).toMatchObject({ projectService: false, project: [`./${SHARED_TSCONFIG}`] });
    }
  );

  it.each(['apps/backend/app.ts', 'shared/database/src/schema.ts', 'tests/unit/config/jobs-lint-program.test.ts'])(
    'keeps the project service for %s',
    (file) => {
      const options = parserOptionsFor(file);
      expect(options.projectService).toBe(true);
      expect(options.project).toBeUndefined();
    }
  );
});

describe('the guard is reachable from the files it reads', () => {
  it.each([SHARED_TSCONFIG, 'eslint.config.mjs'])("detect-changes' src filter lists %s", (file) => {
    expect(srcFilter()).toContain(file);
  });
});
