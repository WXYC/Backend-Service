import { srcFilter } from '../../utils/src-filter';

/**
 * Root files that `npm run format:check` (`prettier --check .`) or `npm ci` read in the src-gated jobs
 * (BS#3677). A PR that edits only one of them must still run `lint-and-typecheck`; otherwise the job
 * reports `skipped`, which branch protection accepts as passing, and main goes red on the next PR.
 */
const FORMAT_AND_INSTALL_INPUTS = [
  'turbo.json',
  'jest.config.json',
  'jest.parallel.config.json',
  'jest.e2e.config.json',
  'drizzle.config.ts',
  'docker-compose.yml',
  '.vscode/launch.json',
  '.github/dependabot.yml',
  '.github/ecr-lifecycle-policy.json',
  'README.md',
  'COMMERCIAL.md',
  '.gitignore',
  '.npmrc',
];

describe("detect-changes' src filter lists the root files format:check and npm ci read", () => {
  it.each(FORMAT_AND_INSTALL_INPUTS)('%s', (file) => {
    expect(srcFilter()).toContain(file);
  });
});
